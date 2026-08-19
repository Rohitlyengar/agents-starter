const base = process.env.REPRO_URL;
if (!base) throw new Error("REPRO_URL is required");
const name = `node-verify-${crypto.randomUUID()}`;
const url = new URL(`/agents/chat-agent/${name}`, base);
url.protocol = "wss:";
const socket = new WebSocket(url);
const requestId = "verify157";
const chunks = [];
let trace = null;
let done = false;
let finished = false;

const timeout = setTimeout(() => {
  console.error("Timed out", { chunks, trace });
  process.exit(2);
}, 90_000);

socket.addEventListener("open", () => {
  console.log("OPEN", url.toString());
  socket.send(
    JSON.stringify({
      id: requestId,
      init: {
        method: "POST",
        body: JSON.stringify({
          messages: [
            {
              id: "user-157",
              role: "user",
              parts: [{ type: "text", text: "Reply with exactly: Hello!" }]
            }
          ],
          trigger: "submit-message"
        })
      },
      type: "cf_agent_use_chat_request"
    })
  );
});

socket.addEventListener("message", (event) => {
  const wire = String(event.data);
  let message;
  try {
    message = JSON.parse(wire);
  } catch {
    console.log("NON_JSON", wire);
    return;
  }

  if (message.type === "repro-raw-trace") {
    trace = message.trace;
    console.log("RAW_TRACE", JSON.stringify(trace));
    maybeFinish();
  }

  if (message.type === "cf_agent_use_chat_response" && message.id === requestId) {
    if (message.body?.trim()) {
      try {
        const chunk = JSON.parse(message.body);
        chunks.push(chunk);
        console.log("UI_CHUNK", JSON.stringify(chunk));
      } catch {
        console.log("UNPARSED_BODY", message.body);
      }
    }
    if (message.done) {
      done = true;
      maybeFinish();
    }
  }
});

socket.addEventListener("error", (event) => {
  console.error("SOCKET_ERROR", event);
});
socket.addEventListener("close", (event) => {
  console.log("CLOSE", event.code, event.reason);
  if (!done) finish();
});

function maybeFinish() {
  if (done && trace) finish();
}

function finish() {
  if (finished) return;
  finished = true;
  const uiText = chunks
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => chunk.delta)
    .join("");
  const result = {
    uiText,
    trace,
    providerPredictionMatches: trace?.providerParserPrediction === uiText,
    duplicateRawRepresentations:
      !!trace &&
      trace.hybridEventCount > 0 &&
      trace.nativeText === trace.openAiText
  };
  console.log("RESULT", JSON.stringify(result, null, 2));
  clearTimeout(timeout);
  try {
    socket.close();
  } catch {}
  setTimeout(
    () =>
      process.exit(
        result.providerPredictionMatches && result.duplicateRawRepresentations
          ? 0
          : 1
      ),
    100
  );
}
