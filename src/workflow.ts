import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { IncidentCommander } from "./server";
import type { InvestigationParams, InvestigationProgress } from "./domain";
import { inspectMetrics, listDeployments, searchLogs } from "./observability";

export class InvestigationWorkflow extends AgentWorkflow<
  IncidentCommander,
  InvestigationParams,
  InvestigationProgress
> {
  async run(
    event: AgentWorkflowEvent<InvestigationParams>,
    step: AgentWorkflowStep
  ) {
    const { service, objective } = event.payload;

    await this.reportProgress({
      step: "metrics",
      status: "running",
      message: `Inspecting golden signals for ${service}`,
      percent: 0.1
    });

    const metrics = await step.do("collect-metrics", async () =>
      inspectMetrics(service)
    );
    await step.sendEvent({
      type: "evidence",
      source: "metrics",
      data: metrics
    });

    await this.reportProgress({
      step: "logs",
      status: "running",
      message: "Clustering errors around the first alert",
      percent: 0.35
    });

    const logs = await step.do("search-logs", async () =>
      searchLogs(service, "level:error OR db.pool.wait_ms > 1000")
    );
    await step.sendEvent({ type: "evidence", source: "logs", data: logs });

    await this.reportProgress({
      step: "changes",
      status: "running",
      message: "Correlating recent deployments",
      percent: 0.58
    });

    const deployments = await step.do("list-deployments", async () =>
      listDeployments(service)
    );
    await step.sendEvent({
      type: "evidence",
      source: "deployments",
      data: deployments
    });

    const assessment = await step.do("build-assessment", async () => ({
      objective,
      hypothesis:
        "Synchronous fraud enrichment introduced in deploy 2026.09.18.3 is holding database connections longer, exhausting the pool.",
      confidence: 0.91,
      proposedAction:
        "Roll back checkout-api to 2026.09.17.8, then monitor p95 latency and error rate for 10 minutes."
    }));

    await this.agent.recordAssessment(assessment);

    await this.reportProgress({
      step: "approval",
      status: "pending",
      message: "Evidence collected. Remediation requires operator approval.",
      percent: 0.75,
      proposedAction: assessment.proposedAction
    });

    const approval = await this.waitForApproval<{ approvedBy: string }>(step, {
      timeout: "7 days",
      stepName: "approve-remediation"
    });

    await this.reportProgress({
      step: "remediation",
      status: "running",
      message: `Rollback approved by ${approval.approvedBy}`,
      percent: 0.86,
      proposedAction: assessment.proposedAction
    });

    const remediation = await step.do("execute-rollback", async () => ({
      action: "rollback",
      fromVersion: "2026.09.18.3",
      toVersion: "2026.09.17.8",
      changeId: `chg-${crypto.randomUUID().slice(0, 8)}`,
      completedAt: new Date().toISOString()
    }));

    await this.agent.recordRemediation(remediation);

    await this.reportProgress({
      step: "verification",
      status: "running",
      message: "Verifying service recovery",
      percent: 0.95,
      proposedAction: assessment.proposedAction
    });

    const result = await step.do("verify-recovery", async () => ({
      healthy: true,
      p95Ms: 438,
      errorRatePercent: 0.5,
      verifiedAt: new Date().toISOString()
    }));

    await step.reportComplete(result);
    return result;
  }
}
