import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { routeAgentRequest } from "agents";
import { convertToModelMessages, streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";

type Env = {
  ChatAgent: DurableObjectNamespace<ChatAgent>;
};

type ParsedSseEvent = Record<string, unknown>;

function parseSse(wire: string): ParsedSseEvent[] {
  const payloads: string[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length > 0) payloads.push(data.join("\n"));
    data = [];
  };

  for (const line of wire.split(/\r?\n/)) {
    if (line === "") {
      flush();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  flush();

  return payloads.flatMap((payload) => {
    if (!payload || payload === "[DONE]") return [];
    try {
      return [JSON.parse(payload) as ParsedSseEvent];
    } catch {
      return [];
    }
  });
}

async function summarizeRawStream(stream: ReadableStream<Uint8Array>) {
  const wire = await new Response(stream).text();
  const events = parseSse(wire);
  let nativeText = "";
  let openAiText = "";
  let providerParserPrediction = "";
  let hybridEventCount = 0;

  for (const event of events) {
    const nativeDelta =
      event.response == null || event.response === ""
        ? ""
        : String(event.response);
    const choices = event.choices as
      | Array<{ delta?: { content?: unknown } }>
      | undefined;
    const candidate = choices?.[0]?.delta?.content;
    const openAiDelta = typeof candidate === "string" ? candidate : "";

    nativeText += nativeDelta;
    openAiText += openAiDelta;
    // workers-ai-provider@3.3.1/src/streaming.ts handles both branches
    // independently, in this order, even when both occur in one SSE event.
    providerParserPrediction += nativeDelta + openAiDelta;
    if (nativeDelta && openAiDelta) hybridEventCount++;
  }

  return {
    rawEventCount: events.length,
    hybridEventCount,
    nativeText,
    openAiText,
    providerParserPrediction,
    sampleEvents: events.slice(0, 8)
  };
}

// This is the dual-format SSE shape emitted by Workers AI and documented in
// cloudflare/ai#615. Both fields carry the same token in each event.
function dualFormatFixtureBinding(): Ai {
  const encoder = new TextEncoder();
  const events = [
    {
      response: "Hello",
      choices: [{ delta: { content: "Hello" }, finish_reason: null }]
    },
    {
      response: "!",
      choices: [{ delta: { content: "!" }, finish_reason: null }]
    },
    {
      response: "",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
    }
  ];
  const wire =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    "data: [DONE]\n\n";

  return {
    async run() {
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(wire));
          controller.close();
        }
      });
    }
  } as unknown as Ai;
}

function tracedBinding(
  binding: Ai,
  onTrace: (trace: Awaited<ReturnType<typeof summarizeRawStream>>) => void,
  onError: (error: unknown) => void
): Ai {
  return {
    async run(...args: unknown[]) {
      const result = await (
        binding.run as unknown as (...values: unknown[]) => Promise<unknown>
      ).apply(binding, args);

      if (!(result instanceof ReadableStream)) return result;
      const [providerStream, traceStream] = result.tee();
      summarizeRawStream(traceStream)
        .then(onTrace)
        .catch(onError);
      return providerStream;
    }
  } as unknown as Ai;
}

export class ChatAgent extends AIChatAgent<Env> {
  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const binding = tracedBinding(
      dualFormatFixtureBinding(),
      (trace) => {
        console.log("REPRO_RAW_TRACE", JSON.stringify(trace));
        this.broadcast(JSON.stringify({ type: "repro-raw-trace", trace }));
      },
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("REPRO_RAW_TRACE_ERROR", message);
        this.broadcast(
          JSON.stringify({ type: "repro-raw-trace-error", error: message })
        );
      }
    );
    const workersai = createWorkersAI({ binding });
    const result = streamText({
      model: workersai("@cf/meta/llama-4-scout-17b-16e-instruct"),
      messages: await convertToModelMessages(this.messages),
      temperature: 0,
      maxOutputTokens: 32,
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
