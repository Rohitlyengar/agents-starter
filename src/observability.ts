/**
 * Demo observability adapter.
 *
 * Replace these functions with calls to your metrics, logging and deployment
 * providers. Keeping the integration behind a small interface lets the chat
 * tools and durable workflow share the same source of truth.
 */
export function inspectMetrics(service: string) {
  return {
    service,
    window: "last 30 minutes",
    latency: { p50Ms: 184, p95Ms: 1842, p99Ms: 3310, baselineP95Ms: 420 },
    errorRate: { currentPercent: 7.8, baselinePercent: 0.4 },
    saturation: { cpuPercent: 42, memoryPercent: 61, dbPoolPercent: 96 },
    finding:
      "Database connection pool saturation tracks the latency and error-rate increase."
  };
}

export function searchLogs(service: string, query: string) {
  return {
    service,
    query,
    matches: 1284,
    patterns: [
      {
        count: 847,
        level: "error",
        message: "Timeout acquiring database connection after 2000ms"
      },
      {
        count: 301,
        level: "warn",
        message: "Retrying payment intent lookup (attempt 2/3)"
      },
      {
        count: 136,
        level: "error",
        message: "POST /checkout returned 503 upstream_timeout"
      }
    ],
    finding:
      "Connection acquisition timeouts dominate errors after the latest deploy."
  };
}

export function listDeployments(service: string) {
  return {
    service,
    deployments: [
      {
        id: "deploy-7f31a2",
        version: "checkout-api@2026.09.18.3",
        deployedAt: "2026-09-18T09:06:00.000Z",
        author: "release-bot",
        summary: "Enable synchronous fraud profile enrichment"
      },
      {
        id: "deploy-c8bb10",
        version: "checkout-api@2026.09.17.8",
        deployedAt: "2026-09-17T17:42:00.000Z",
        author: "release-bot",
        summary: "Checkout telemetry labels"
      }
    ],
    finding: "The latest deploy preceded the alert by six minutes."
  };
}
