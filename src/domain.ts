export type Severity = "SEV-1" | "SEV-2" | "SEV-3";

export type IncidentStatus =
  | "investigating"
  | "mitigating"
  | "monitoring"
  | "resolved";

export type TimelineKind =
  | "alert"
  | "evidence"
  | "hypothesis"
  | "decision"
  | "action"
  | "operator"
  | "system";

export interface TimelineEvent {
  id: string;
  at: string;
  kind: TimelineKind;
  title: string;
  detail: string;
}

export interface Evidence {
  id: string;
  source: "metrics" | "logs" | "deployments" | "operator";
  title: string;
  detail: string;
  observedAt: string;
}

export interface Hypothesis {
  id: string;
  text: string;
  confidence: number;
  status: "open" | "supported" | "rejected";
}

export interface Incident {
  id: string;
  title: string;
  service: string;
  severity: Severity;
  status: IncidentStatus;
  startedAt: string;
  commander: string;
}

export interface InvestigationRun {
  id: string | null;
  status:
    | "idle"
    | "running"
    | "awaiting-approval"
    | "complete"
    | "rejected"
    | "error";
  step: string;
  message: string;
  percent: number;
  proposedAction: string | null;
  startedAt: string | null;
}

export interface IncidentState {
  incident: Incident;
  workflow: InvestigationRun;
  timeline: TimelineEvent[];
  evidence: Evidence[];
  hypotheses: Hypothesis[];
  lastUpdatedAt: string;
}

export interface InvestigationParams {
  incidentId: string;
  service: string;
  objective: string;
  startedAt: string;
}

export interface InvestigationProgress {
  step: string;
  status: "pending" | "running" | "complete" | "error";
  message: string;
  percent: number;
  proposedAction?: string;
}

const DEMO_STARTED_AT = "2026-09-18T09:12:00.000Z";

export function createInitialState(): IncidentState {
  return {
    incident: {
      id: "INC-2048",
      title: "Checkout latency spike",
      service: "checkout-api",
      severity: "SEV-1",
      status: "investigating",
      startedAt: DEMO_STARTED_AT,
      commander: "On-call team"
    },
    workflow: {
      id: null,
      status: "idle",
      step: "Ready",
      message: "Investigation has not started",
      percent: 0,
      proposedAction: null,
      startedAt: null
    },
    timeline: [
      {
        id: "evt-alert-fired",
        at: DEMO_STARTED_AT,
        kind: "alert",
        title: "Latency alert fired",
        detail: "checkout-api p95 exceeded 1.5s for five minutes."
      }
    ],
    evidence: [],
    hypotheses: [],
    lastUpdatedAt: DEMO_STARTED_AT
  };
}

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}
