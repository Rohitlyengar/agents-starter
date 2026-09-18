import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  type LanguageModelMiddleware,
  pruneMessages,
  simulateStreamingMiddleware,
  stepCountIs,
  streamText,
  tool,
  wrapLanguageModel
} from "ai";
import { z } from "zod";
import {
  createInitialState,
  makeId,
  type Evidence,
  type IncidentState,
  type InvestigationProgress,
  type Severity,
  type TimelineEvent,
  type TimelineKind
} from "./domain";
import { inspectMetrics, listDeployments, searchLogs } from "./observability";

export { InvestigationWorkflow } from "./workflow";

const SYSTEM_PROMPT = `You are Incident Commander, an expert production-operations agent.

Your job is to help an on-call team restore service safely. Be concise, evidence-led, and explicit about uncertainty.

Operating rules:
- Gather metrics, logs, and recent changes before asserting a root cause.
- Keep the incident timeline and hypotheses updated with tools.
- Never claim an action happened unless a tool confirms it.
- Production remediation must go through startInvestigation and its human approval gate.
- Treat status questions as read-only: answer from current state without writing a timeline note or starting a workflow.
- Start an investigation only when the user explicitly asks you to investigate or start it.
- If a tool fails, do not repeatedly call the same tool; report the failure and continue safely.
- Do not expose secrets or invent telemetry.
- When reporting evidence, distinguish observations from hypotheses.
- Prefer a short status summary followed by the next safest action.`;

type Assessment = {
  objective: string;
  hypothesis: string;
  confidence: number;
  proposedAction: string;
};

type Remediation = {
  action: string;
  fromVersion: string;
  toVersion: string;
  changeId: string;
  completedAt: string;
};

type IncidentToolName =
  | "inspectMetrics"
  | "searchLogs"
  | "listRecentDeployments"
  | "addHypothesis"
  | "addTimelineNote"
  | "startInvestigation";

const TEXT_ONLY_STEP_MIDDLEWARE: LanguageModelMiddleware = {
  specificationVersion: "v3",
  transformParams: async ({ params }) =>
    params.toolChoice?.type === "none"
      ? { ...params, tools: undefined, toolChoice: undefined }
      : params
};

function now() {
  return new Date().toISOString();
}

function isEvidenceSource(value: unknown): value is Evidence["source"] {
  return ["metrics", "logs", "deployments", "operator"].includes(String(value));
}

export class IncidentCommander extends AIChatAgent<Env, IncidentState> {
  initialState = createInitialState();
  maxPersistedMessages = 120;
  chatRecovery = true;
  waitForMcpConnections = true;

  private updateState(patch: Partial<IncidentState>) {
    this.setState({
      ...this.state,
      ...patch,
      lastUpdatedAt: now()
    });
  }

  private appendTimeline(kind: TimelineKind, title: string, detail: string) {
    const event: TimelineEvent = {
      id: makeId("evt"),
      at: now(),
      kind,
      title,
      detail
    };
    this.updateState({ timeline: [...this.state.timeline, event].slice(-60) });
    return event;
  }

  private appendEvidence(
    source: Evidence["source"],
    title: string,
    detail: string
  ) {
    const item: Evidence = {
      id: makeId("ev"),
      source,
      title,
      detail,
      observedAt: now()
    };
    this.updateState({ evidence: [...this.state.evidence, item].slice(-30) });
    return item;
  }

  private async stopActiveWorkflow() {
    if (
      this.state.workflow.id &&
      ["running", "awaiting-approval"].includes(this.state.workflow.status)
    ) {
      await this.terminateWorkflow(this.state.workflow.id);
    }
  }

  @callable()
  async resetDemo() {
    await this.stopActiveWorkflow();
    this.setState(createInitialState());
    return this.state;
  }

  @callable()
  async openIncident(
    title: string,
    service: string,
    severity: Severity = "SEV-2"
  ) {
    await this.stopActiveWorkflow();
    const startedAt = now();
    const state = createInitialState();
    state.incident = {
      id: `INC-${Math.floor(1000 + Math.random() * 9000)}`,
      title,
      service,
      severity,
      status: "investigating",
      startedAt,
      commander: "On-call team"
    };
    state.timeline = [
      {
        id: makeId("evt"),
        at: startedAt,
        kind: "alert",
        title: "Incident opened",
        detail: `${severity} declared for ${service}: ${title}`
      }
    ];
    state.lastUpdatedAt = startedAt;
    this.setState(state);
    return state.incident;
  }

  @callable()
  async startInvestigation(
    objective = "Identify the cause and propose a safe mitigation"
  ) {
    if (
      this.state.workflow.id &&
      ["running", "awaiting-approval"].includes(this.state.workflow.status)
    ) {
      return {
        workflowId: this.state.workflow.id,
        status: this.state.workflow.status,
        message: "An investigation is already active."
      };
    }

    const startedAt = now();
    const workflowId = await this.runWorkflow(
      "INVESTIGATION_WORKFLOW",
      {
        incidentId: this.state.incident.id,
        service: this.state.incident.service,
        objective,
        startedAt
      },
      {
        metadata: {
          incidentId: this.state.incident.id,
          service: this.state.incident.service
        },
        agentBinding: "IncidentCommander"
      }
    );

    this.updateState({
      workflow: {
        id: workflowId,
        status: "running",
        step: "Starting",
        message: objective,
        percent: 0.02,
        proposedAction: null,
        startedAt
      }
    });
    this.appendTimeline("system", "Investigation started", objective);
    return { workflowId, status: "running", message: objective };
  }

  @callable()
  async approveRemediation(workflowId: string, approvedBy = "Operator") {
    if (this.state.workflow.id !== workflowId) {
      throw new Error("This workflow is not active for the current incident.");
    }
    await this.approveWorkflow(workflowId, {
      reason: "Approved in the incident command center",
      metadata: { approvedBy }
    });
    this.updateState({
      workflow: {
        ...this.state.workflow,
        status: "running",
        step: "remediation",
        message: `Approved by ${approvedBy}`,
        percent: 0.8
      },
      incident: { ...this.state.incident, status: "mitigating" }
    });
    this.appendTimeline(
      "decision",
      "Remediation approved",
      `${approvedBy} approved: ${this.state.workflow.proposedAction ?? "proposed mitigation"}`
    );
    return { approved: true };
  }

  @callable()
  async rejectRemediation(workflowId: string, reason = "Rejected by operator") {
    if (this.state.workflow.id !== workflowId) {
      throw new Error("This workflow is not active for the current incident.");
    }
    await this.rejectWorkflow(workflowId, { reason });
    this.updateState({
      workflow: {
        ...this.state.workflow,
        status: "rejected",
        step: "Stopped",
        message: reason
      }
    });
    this.appendTimeline("decision", "Remediation rejected", reason);
    return { approved: false };
  }

  async recordAssessment(assessment: Assessment) {
    const existing = this.state.hypotheses.find(
      (item) => item.text === assessment.hypothesis
    );
    if (!existing) {
      this.updateState({
        hypotheses: [
          ...this.state.hypotheses,
          {
            id: makeId("hyp"),
            text: assessment.hypothesis,
            confidence: assessment.confidence,
            status: "supported" as const
          }
        ]
      });
      this.appendTimeline(
        "hypothesis",
        "Leading hypothesis",
        `${Math.round(assessment.confidence * 100)}% confidence — ${assessment.hypothesis}`
      );
    }
  }

  async recordRemediation(remediation: Remediation) {
    if (
      this.state.timeline.some((event) =>
        event.detail.includes(remediation.changeId)
      )
    ) {
      return;
    }
    this.updateState({
      incident: { ...this.state.incident, status: "monitoring" }
    });
    this.appendTimeline(
      "action",
      "Rollback completed",
      `${remediation.changeId}: ${remediation.fromVersion} → ${remediation.toVersion}`
    );
  }

  async onWorkflowProgress(
    _workflowName: string,
    workflowId: string,
    progress: unknown
  ) {
    const value = progress as InvestigationProgress;
    const awaitingApproval =
      value.step === "approval" && value.status === "pending";
    this.updateState({
      workflow: {
        ...this.state.workflow,
        id: workflowId,
        status: awaitingApproval ? "awaiting-approval" : "running",
        step: value.step,
        message: value.message,
        percent: value.percent,
        proposedAction:
          value.proposedAction ?? this.state.workflow.proposedAction
      }
    });
  }

  async onWorkflowEvent(
    _workflowName: string,
    _workflowId: string,
    event: unknown
  ) {
    const value = event as {
      type?: string;
      source?: unknown;
      data?: { finding?: unknown };
    };
    if (value.type !== "evidence" || !isEvidenceSource(value.source)) return;
    const finding = String(value.data?.finding ?? "Evidence collected");
    this.appendEvidence(value.source, `${value.source} finding`, finding);
    this.appendTimeline("evidence", `${value.source} analyzed`, finding);
  }

  async onWorkflowComplete(
    _workflowName: string,
    workflowId: string,
    result?: unknown
  ) {
    const verification = result as
      | { healthy?: boolean; p95Ms?: number; errorRatePercent?: number }
      | undefined;
    this.updateState({
      incident: { ...this.state.incident, status: "monitoring" },
      workflow: {
        ...this.state.workflow,
        id: workflowId,
        status: "complete",
        step: "Complete",
        message: verification?.healthy
          ? `Recovery verified: p95 ${verification.p95Ms}ms, errors ${verification.errorRatePercent}%`
          : "Investigation completed",
        percent: 1
      }
    });
    this.appendTimeline(
      "system",
      "Recovery verified",
      verification?.healthy
        ? `Service is healthy at ${verification.p95Ms}ms p95 and ${verification.errorRatePercent}% errors.`
        : "Workflow completed."
    );
  }

  async onWorkflowError(
    _workflowName: string,
    workflowId: string,
    error: string
  ) {
    const rejected = error.toLowerCase().includes("reject");
    this.updateState({
      workflow: {
        ...this.state.workflow,
        id: workflowId,
        status: rejected ? "rejected" : "error",
        step: rejected ? "Stopped" : "Failed",
        message: error
      }
    });
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersAI = createWorkersAI({ binding: this.env.AI });
    const mcpTools = this.mcp.getAITools();
    const lastUserText =
      [...this.messages]
        .reverse()
        .find((message) => message.role === "user")
        ?.parts.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ")
        .toLowerCase() ?? "";
    const asksToInvestigate =
      /\b(investigate|triage)\b/.test(lastUserText) ||
      /\b(start|run|begin|launch)\b.{0,24}\binvestigation\b/.test(
        lastUserText
      ) ||
      /\b(find|identify)\b.{0,24}\b(cause|culprit)\b/.test(lastUserText);
    const asksForStatus =
      /\b(status|summary|summarize|current update|what is happening|what's happening)\b/.test(
        lastUserText
      );
    const asksForTimelineWrite =
      /\b(add|record|write|log)\b.{0,32}\b(timeline|note)\b/.test(lastUserText);
    const asksForHypothesisWrite =
      /\b(add|record|create)\b.{0,32}\bhypothesis\b/.test(lastUserText);

    let activeTools: IncidentToolName[];
    if (asksToInvestigate) {
      activeTools = ["startInvestigation"];
    } else if (asksForTimelineWrite) {
      activeTools = ["addTimelineNote"];
    } else if (asksForHypothesisWrite) {
      activeTools = ["addHypothesis"];
    } else if (asksForStatus) {
      activeTools = [];
    } else {
      activeTools = ["inspectMetrics", "searchLogs", "listRecentDeployments"];
    }

    const model = wrapLanguageModel({
      model: workersAI("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      // Llama's native tool-call stream currently duplicates argument deltas.
      // Generate each model step atomically, then expose it as an AI SDK stream.
      middleware: [TEXT_ONLY_STEP_MIDDLEWARE, simulateStreamingMiddleware()]
    });

    const system = `${SYSTEM_PROMPT}\n\nCurrent incident state:\n${JSON.stringify(this.state)}`;
    const messages = pruneMessages({
      messages: await convertToModelMessages(this.messages),
      toolCalls: "before-last-3-messages",
      reasoning: "before-last-message"
    });

    // Workers AI rejects a request when tools are present but the active tool
    // list is empty. Status requests are intentionally sent without tools.
    if (asksForStatus && !asksToInvestigate) {
      const result = streamText({
        model,
        system,
        messages,
        stopWhen: stepCountIs(1),
        abortSignal: options?.abortSignal
      });

      return result.toUIMessageStreamResponse();
    }

    const incidentTools = {
      ...mcpTools,
      inspectMetrics: tool({
        description: "Inspect latency, errors and saturation for a service.",
        inputSchema: z.object({ service: z.string() }),
        execute: async ({ service }) => inspectMetrics(service)
      }),
      searchLogs: tool({
        description: "Search and cluster recent service logs.",
        inputSchema: z.object({
          service: z.string(),
          query: z.string().describe("A focused log query")
        }),
        execute: async ({ service, query }) => searchLogs(service, query)
      }),
      listRecentDeployments: tool({
        description: "List deployments that may correlate with an incident.",
        inputSchema: z.object({ service: z.string() }),
        execute: async ({ service }) => listDeployments(service)
      }),
      addHypothesis: tool({
        description:
          "Add an investigation hypothesis to shared incident state.",
        inputSchema: z.object({
          text: z.string(),
          confidence: z.number().min(0).max(1)
        }),
        execute: async ({ text, confidence }) => {
          const hypothesis = {
            id: makeId("hyp"),
            text,
            confidence,
            status: "open" as const
          };
          this.updateState({
            hypotheses: [...this.state.hypotheses, hypothesis].slice(-20)
          });
          this.appendTimeline(
            "hypothesis",
            "Hypothesis added",
            `${Math.round(confidence * 100)}% confidence — ${text}`
          );
          return hypothesis;
        }
      }),
      addTimelineNote: tool({
        description:
          "Record genuinely new operator information or a decision on the timeline. Do not use for routine status questions or to record your own response.",
        inputSchema: z.object({ title: z.string(), detail: z.string() }),
        execute: async ({ title, detail }) =>
          this.appendTimeline("operator", title, detail)
      }),
      startInvestigation: tool({
        description:
          "Start the durable evidence collection workflow only when the user explicitly requests an investigation. It pauses before remediation for human approval.",
        inputSchema: z.object({
          objective: z.string().default("Identify cause and propose mitigation")
        }),
        execute: async ({ objective }) => this.startInvestigation(objective)
      })
    };
    const isMutationRequest =
      asksToInvestigate || asksForTimelineWrite || asksForHypothesisWrite;

    const result = streamText({
      model,
      system,
      messages,
      tools: incidentTools,
      activeTools,
      // Mutation results render as tool cards, so end immediately after the
      // confirmed action. Read-only tools get one prose synthesis step.
      prepareStep: ({ stepNumber }) =>
        !isMutationRequest && stepNumber > 0
          ? { toolChoice: "none" }
          : undefined,
      stopWhen: stepCountIs(isMutationRequest ? 1 : 2),
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
