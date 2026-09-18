import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { Streamdown } from "streamdown";
import {
  BrainIcon,
  BugIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  CircleIcon,
  GearIcon,
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  XCircleIcon
} from "@phosphor-icons/react";
import type { IncidentCommander } from "./server";
import { createInitialState, type IncidentState } from "./domain";

const suggestions = [
  "Give me a concise incident status update.",
  "What evidence should we collect first?",
  "Start the investigation and find the likely cause."
];

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function titleCase(value: string) {
  return value
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ToolPart({
  part,
  approve
}: {
  part: UIMessage["parts"][number];
  approve: (response: { id: string; approved: boolean }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const name = titleCase(getToolName(part));

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="tool-card approval-tool">
        <div className="tool-heading">
          <GearIcon size={15} /> Approval required · {name}
        </div>
        <pre>{JSON.stringify(part.input, null, 2)}</pre>
        <div className="button-row">
          <button
            className="button primary compact"
            onClick={() =>
              approvalId && approve({ id: approvalId, approved: true })
            }
          >
            Approve
          </button>
          <button
            className="button secondary compact"
            onClick={() =>
              approvalId && approve({ id: approvalId, approved: false })
            }
          >
            Reject
          </button>
        </div>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="tool-card tool-error">
        <XCircleIcon size={15} /> {name} failed: {part.errorText}
      </div>
    );
  }

  if (part.state === "output-available") {
    return (
      <details className="tool-card">
        <summary>
          <CheckCircleIcon size={15} /> {name} completed
        </summary>
        <pre>{JSON.stringify(part.output, null, 2)}</pre>
      </details>
    );
  }

  return (
    <div className="tool-card running-tool">
      <GearIcon size={15} /> Running {name}…
    </div>
  );
}

function WorkflowCard({
  state,
  onStart,
  onApprove,
  onReject,
  busy
}: {
  state: IncidentState;
  onStart: () => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const { workflow } = state;
  const awaiting = workflow.status === "awaiting-approval";
  const active = workflow.status === "running";

  return (
    <section className={`workflow-card ${awaiting ? "needs-attention" : ""}`}>
      <div className="workflow-topline">
        <div>
          <span className="eyebrow">Durable investigation</span>
          <h2>{titleCase(workflow.step)}</h2>
        </div>
        <span className={`status-chip ${workflow.status}`}>
          {titleCase(workflow.status)}
        </span>
      </div>
      <p>{workflow.message}</p>
      <div
        className="progress-track"
        aria-label={`${Math.round(workflow.percent * 100)}% complete`}
      >
        <span style={{ width: `${Math.max(2, workflow.percent * 100)}%` }} />
      </div>

      {workflow.status === "idle" && (
        <button className="button primary" onClick={onStart} disabled={busy}>
          <BugIcon size={17} /> Run investigation
        </button>
      )}

      {active && (
        <div className="live-note">
          <span className="pulse" /> Workflow is running with automatic retries
        </div>
      )}

      {awaiting && (
        <div className="approval-box">
          <div>
            <strong>Proposed production change</strong>
            <p>{workflow.proposedAction}</p>
          </div>
          <div className="button-row">
            <button
              className="button approve"
              onClick={onApprove}
              disabled={busy}
            >
              <CheckCircleIcon size={17} /> Approve rollback
            </button>
            <button
              className="button reject"
              onClick={onReject}
              disabled={busy}
            >
              <XCircleIcon size={17} /> Reject
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function ContextPanel({ state }: { state: IncidentState }) {
  return (
    <aside className="context-panel panel-scroll">
      <section>
        <span className="section-kicker">Live signals</span>
        <div className="signal-grid">
          <div className="signal danger">
            <span>P95 latency</span>
            <strong>1.84s</strong>
            <small>+338% baseline</small>
          </div>
          <div className="signal danger">
            <span>Error rate</span>
            <strong>7.8%</strong>
            <small>+7.4 points</small>
          </div>
          <div className="signal warning">
            <span>DB pool</span>
            <strong>96%</strong>
            <small>Saturated</small>
          </div>
          <div className="signal healthy">
            <span>CPU</span>
            <strong>42%</strong>
            <small>Normal</small>
          </div>
        </div>
      </section>

      <section>
        <div className="section-heading">
          <span className="section-kicker">Evidence</span>
          <span className="count">{state.evidence.length}</span>
        </div>
        <div className="stack-list">
          {state.evidence.length === 0 ? (
            <p className="empty-copy">
              Run the investigation to collect correlated metrics, logs, and
              deploys.
            </p>
          ) : (
            state.evidence.map((item) => (
              <article className="evidence-item" key={item.id}>
                <span className={`source-tag ${item.source}`}>
                  {item.source}
                </span>
                <strong>{item.title}</strong>
                <p>{item.detail}</p>
              </article>
            ))
          )}
        </div>
      </section>

      <section>
        <div className="section-heading">
          <span className="section-kicker">Hypotheses</span>
          <span className="count">{state.hypotheses.length}</span>
        </div>
        <div className="stack-list">
          {state.hypotheses.length === 0 ? (
            <p className="empty-copy">No hypotheses yet.</p>
          ) : (
            state.hypotheses.map((item) => (
              <article className="hypothesis-item" key={item.id}>
                <div className="confidence-ring">
                  {Math.round(item.confidence * 100)}%
                </div>
                <div>
                  <strong>{titleCase(item.status)}</strong>
                  <p>{item.text}</p>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </aside>
  );
}

function Timeline({ state }: { state: IncidentState }) {
  const reversed = useMemo(
    () => [...state.timeline].reverse(),
    [state.timeline]
  );
  return (
    <aside className="timeline-panel panel-scroll">
      <div className="section-heading sticky-heading">
        <div>
          <span className="section-kicker">Incident record</span>
          <h2>Timeline</h2>
        </div>
        <span className="count">{state.timeline.length}</span>
      </div>
      <div className="timeline-list">
        {reversed.map((event) => (
          <article className="timeline-event" key={event.id}>
            <div className={`timeline-dot ${event.kind}`} />
            <time>{timeLabel(event.at)}</time>
            <strong>{event.title}</strong>
            <p>{event.detail}</p>
          </article>
        ))}
      </div>
    </aside>
  );
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [rpcBusy, setRpcBusy] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<IncidentCommander, IncidentState>({
    agent: "IncidentCommander",
    name: "demo-incident",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("Agent connection error", error),
      []
    )
  });

  const state = agent.state ?? createInitialState();
  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    status,
    stop
  } = useAgentChat({ agent, experimental_throttle: 80 });
  const streaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!streaming) inputRef.current?.focus();
  }, [streaming]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming || !connected) return;
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setInput("");
  }, [connected, input, sendMessage, streaming]);

  const runRpc = useCallback(async (operation: () => Promise<unknown>) => {
    setRpcBusy(true);
    try {
      await operation();
    } catch (error) {
      console.error(error);
    } finally {
      setRpcBusy(false);
    }
  }, []);

  const workflowId = state.workflow.id;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">IC</span>
          <div>
            <strong>Incident Commander</strong>
            <span>AI operations room</span>
          </div>
        </div>
        <div className="incident-title">
          <span className="severity">{state.incident.severity}</span>
          <div>
            <strong>{state.incident.title}</strong>
            <span>
              {state.incident.id} · {state.incident.service}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <span className={`connection ${connected ? "online" : ""}`}>
            <CircleIcon size={9} weight="fill" />
            {connected ? "Live" : "Connecting"}
          </span>
          <button
            className={`icon-button ${showDebug ? "active" : ""}`}
            onClick={() => setShowDebug(!showDebug)}
            title="Toggle message debug view"
          >
            <BugIcon size={17} />
          </button>
          <button
            className="icon-button"
            onClick={() => clearHistory()}
            title="Clear chat"
          >
            <TrashIcon size={17} />
          </button>
          <button
            className="button secondary compact"
            onClick={() => runRpc(() => agent.stub.resetDemo())}
            disabled={rpcBusy}
          >
            Reset demo
          </button>
        </div>
      </header>

      <main className="workspace">
        <ContextPanel state={state} />

        <section className="command-center">
          <WorkflowCard
            state={state}
            busy={rpcBusy}
            onStart={() =>
              runRpc(() =>
                agent.stub.startInvestigation(
                  "Identify the cause of the checkout latency spike and propose the safest mitigation"
                )
              )
            }
            onApprove={() =>
              workflowId &&
              runRpc(() =>
                agent.stub.approveRemediation(workflowId, "Web operator")
              )
            }
            onReject={() =>
              workflowId &&
              runRpc(() =>
                agent.stub.rejectRemediation(
                  workflowId,
                  "Operator requested more evidence"
                )
              )
            }
          />

          <div className="chat-header">
            <div>
              <ChatCircleDotsIcon size={18} />
              <strong>Command channel</strong>
            </div>
            <span>Llama 3.3 70B · Workers AI</span>
          </div>

          <div className="messages">
            {messages.length === 0 && (
              <div className="welcome">
                <div className="assistant-avatar">
                  <BrainIcon size={23} />
                </div>
                <h2>Ready to investigate</h2>
                <p>
                  I can inspect signals, correlate recent changes, maintain the
                  incident record, and coordinate a rollback with your approval.
                </p>
                <div className="suggestions">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() =>
                        sendMessage({
                          role: "user",
                          parts: [{ type: "text", text: suggestion }]
                        })
                      }
                      disabled={!connected || streaming}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message: UIMessage) => (
              <article className={`message ${message.role}`} key={message.id}>
                <div className="message-avatar">
                  {message.role === "user" ? "YOU" : "IC"}
                </div>
                <div className="message-body">
                  <span className="message-author">
                    {message.role === "user"
                      ? "Operator"
                      : "Incident Commander"}
                  </span>
                  {showDebug && (
                    <pre className="debug-block">
                      {JSON.stringify(message, null, 2)}
                    </pre>
                  )}
                  {message.parts.map((part, index) => {
                    const key = `${message.id}-${index}`;
                    if (isToolUIPart(part))
                      return (
                        <ToolPart
                          key={key}
                          part={part}
                          approve={addToolApprovalResponse}
                        />
                      );
                    if (part.type === "text" && part.text) {
                      return message.role === "user" ? (
                        <p className="user-copy" key={key}>
                          {part.text}
                        </p>
                      ) : (
                        <Streamdown
                          key={key}
                          className="assistant-copy"
                          controls={false}
                        >
                          {part.text}
                        </Streamdown>
                      );
                    }
                    if (part.type === "reasoning" && part.text) {
                      return (
                        <details className="reasoning" key={key}>
                          <summary>
                            <BrainIcon size={14} /> Model reasoning
                          </summary>
                          <pre>{part.text}</pre>
                        </details>
                      );
                    }
                    return null;
                  })}
                </div>
              </article>
            ))}
            <div ref={endRef} />
          </div>

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder={
                connected
                  ? "Ask for status, investigate a signal, or coordinate the response…"
                  : "Connecting to incident room…"
              }
              disabled={!connected || streaming}
              rows={1}
            />
            {streaming ? (
              <button
                type="button"
                className="send-button"
                onClick={stop}
                aria-label="Stop response"
              >
                <StopIcon size={19} />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={!input.trim() || !connected}
                aria-label="Send message"
              >
                <PaperPlaneRightIcon size={19} />
              </button>
            )}
          </form>
        </section>

        <Timeline state={state} />
      </main>
    </div>
  );
}
