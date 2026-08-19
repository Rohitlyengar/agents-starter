import { useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import type { ChatAgent } from "./server";

type RawTrace = {
  rawEventCount: number;
  hybridEventCount: number;
  nativeText: string;
  openAiText: string;
  providerParserPrediction: string;
  sampleEvents: Array<Record<string, unknown>>;
};

function textOf(message: UIMessage | undefined) {
  if (!message) return "";
  return message.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> =>
      part.type === "text"
    )
    .map((part) => part.text)
    .join("");
}

function App() {
  const [name] = useState(() => `issue-157-${crypto.randomUUID()}`);
  const [connected, setConnected] = useState(false);
  const [triggered, setTriggered] = useState(false);
  const [trace, setTrace] = useState<RawTrace | null>(null);
  const [traceError, setTraceError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const add = useCallback(
    (message: string) =>
      setLog((entries) => [
        ...entries,
        `${new Date().toISOString()} ${message}`
      ]),
    []
  );

  const agent = useAgent<ChatAgent>({
    agent: "chat-agent",
    name,
    onOpen: useCallback(() => {
      setConnected(true);
      add("WebSocket connected");
    }, [add]),
    onClose: useCallback(() => {
      setConnected(false);
      add("WebSocket closed");
    }, [add]),
    onMessage: useCallback(
      (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "repro-raw-trace") {
            setTrace(message.trace as RawTrace);
            add(
              `raw Workers AI trace captured (${message.trace.rawEventCount} SSE events)`
            );
          } else if (message.type === "repro-raw-trace-error") {
            setTraceError(String(message.error));
            add(`raw trace error: ${message.error}`);
          }
        } catch {
          // Normal AI chat protocol frames are handled by useAgentChat.
        }
      },
      [add]
    )
  });

  const { messages, sendMessage, status, error } = useAgentChat({
    agent,
    getInitialMessages: null,
    resume: false
  });

  const assistant = useMemo(
    () => [...messages].reverse().find((message) => message.role === "assistant"),
    [messages]
  );
  const actual = textOf(assistant);
  const providerPredictionMatches =
    !!trace && !!actual && trace.providerParserPrediction === actual;
  const oneRepresentation = trace?.nativeText || trace?.openAiText || "";
  const duplicated =
    !!trace &&
    trace.hybridEventCount > 0 &&
    trace.nativeText === trace.openAiText &&
    providerPredictionMatches;
  const busy = status === "submitted" || status === "streaming";

  return (
    <main
      style={{
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        maxWidth: 960,
        margin: "0 auto",
        padding: 24,
        lineHeight: 1.45
      }}
    >
      <h1>#157 streamed chat response duplication</h1>
      <p>
        Expected: the model text appears once. Actual bug: every raw model delta
        appears twice in the chat response (for example, <code>HelloHello!!</code>).
      </p>
      <p>
        This deterministic demo feeds workers-ai-provider the dual-format SSE
        shape emitted by Workers AI: each event contains the same token in both
        top-level <code>response</code> and <code>choices[0].delta.content</code>.
        It then runs the normal streamText → AIChatAgent → useAgentChat stack.
      </p>
      <button
        disabled={!connected || busy || triggered}
        onClick={() => {
          setTriggered(true);
          setTrace(null);
          setTraceError("");
          add('Trigger: send “Reply with exactly: Hello!”');
          void sendMessage({
            role: "user",
            parts: [{ type: "text", text: "Reply with exactly: Hello!" }]
          });
        }}
        style={{ font: "inherit", padding: "8px 14px" }}
      >
        {busy ? "Streaming…" : "Trigger bug"}
      </button>
      <span style={{ marginLeft: 12 }}>
        {connected ? "connected" : "connecting…"} · chat status: {status}
      </span>

      <h2>Visible result</h2>
      <dl>
        <dt>Expected from either single raw representation</dt>
        <dd>
          <pre data-testid="expected">{oneRepresentation || "(waiting)"}</pre>
        </dd>
        <dt>Actual chat text after workers-ai-provider mapping</dt>
        <dd>
          <pre data-testid="actual">{actual || "(waiting)"}</pre>
        </dd>
        <dt>Verdict</dt>
        <dd data-testid="verdict">
          {duplicated
            ? "BUG REPRODUCED: provider output exactly matches both raw representations appended per event."
            : busy || !trace || !actual
              ? "Waiting for the stream and raw trace…"
              : "This run did not meet the automatic duplication check."}
        </dd>
      </dl>

      <h2>Raw-stream evidence</h2>
      {trace ? (
        <pre data-testid="trace">
          {JSON.stringify(
            {
              rawEventCount: trace.rawEventCount,
              hybridEventCount: trace.hybridEventCount,
              topLevelResponseText: trace.nativeText,
              choicesDeltaContentText: trace.openAiText,
              providerParserPrediction: trace.providerParserPrediction,
              actualChatText: actual,
              predictionMatchesActual: providerPredictionMatches,
              firstRawEvents: trace.sampleEvents
            },
            null,
            2
          )}
        </pre>
      ) : (
        <pre>{traceError || "(waiting)"}</pre>
      )}

      {error && <pre style={{ color: "crimson" }}>{String(error.message)}</pre>}
      <h2>Event log</h2>
      <pre>{log.join("\n")}</pre>
      <p>
        Dependencies under test: agents 0.17.4, @cloudflare/ai-chat 0.9.3,
        ai 6.0.197, workers-ai-provider 3.3.1.
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
