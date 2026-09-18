# Incident Commander

An AI-assisted incident response room built with Cloudflare Agents, Workflows,
Durable Objects, and Workers AI.

The included scenario starts with a checkout latency alert. The agent can inspect
demo telemetry, correlate a recent deployment, maintain shared incident state,
and launch a durable investigation. The workflow pauses before remediation and
cannot continue until an operator approves or rejects the proposed rollback.

> The observability integrations and rollback are intentionally simulated. The
> approval flow is real; it is backed by a Cloudflare Workflow and survives
> process restarts. Do not connect production mutation APIs until authentication,
> authorization, audit logging, and provider-specific safety checks are in place.

## Architecture

```text
React command center
        │ WebSocket + typed RPC
        ▼
IncidentCommander (AIChatAgent / Durable Object)
  ├── persisted chat history
  ├── synchronized incident state
  ├── Llama 3.3 70B on Workers AI
  ├── observability tools (+ optional MCP tools)
  └── InvestigationWorkflow
        ├── collect metrics
        ├── cluster logs
        ├── correlate deployments
        ├── wait for human approval
        ├── simulate rollback
        └── verify recovery
```

Each incident room maps to one named Agent instance. In this MVP the UI connects
to `demo-incident`; change the `name` passed to `useAgent()` to create separate
rooms.

## What is included

- Streaming chat with `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- Durable Object state synchronized to every connected dashboard
- Persisted chat messages and resumable streams
- Multi-step Cloudflare Workflow with retries and durable progress
- Human approval/rejection gate before remediation
- Incident timeline, evidence board, hypotheses, and live signals
- Model tools for metrics, logs, deployments, hypotheses, and workflow launch
- MCP tool support on the server
- Responsive operations dashboard and raw-message debug mode

## Run locally

Requirements: Node.js 18+ and a Cloudflare account.

```bash
npm install
npx wrangler login
npm run dev
```

Open <http://localhost:5173>.

Workers AI has no local simulator, so `wrangler.jsonc` uses a remote AI binding.
Cloudflare authentication is therefore required for chat. The dashboard,
Durable Object, and Workflow run through the local development server.

Useful prompts:

- `Give me a concise incident status update.`
- `Inspect the metrics and recent deploys.`
- `Start the investigation and find the likely cause.`

You can also start the deterministic investigation directly from the workflow
card. It will collect evidence and stop at the approval gate.

## Commands

```bash
npm run dev       # local development
npm run check     # format check, lint, and TypeScript
npm run types     # regenerate Cloudflare binding types
npm run deploy    # build and deploy to Cloudflare
```

## Connect real observability providers

Replace the functions in `src/observability.ts` with API calls to your providers.
Keep returned data small and structured so the same adapters can be used by both
the chat tools and the durable workflow.

Recommended production adapters include:

- Cloudflare GraphQL Analytics or Workers Observability for service signals
- Datadog, Grafana, Honeycomb, or New Relic for metrics and traces
- Sentry or an indexed log provider for errors
- GitHub Deployments, Cloudflare API, or your CD system for recent changes

Store API credentials with Wrangler secrets, never in source:

```bash
npx wrangler secret put OBSERVABILITY_API_TOKEN
```

After adding a binding or environment variable to `wrangler.jsonc`, run
`npm run types`.

## Production hardening

Before using this against a real environment:

1. Authenticate users and map every incident room to an authorized team.
2. Make Agent connections read-only by default and authorize callable methods.
3. Split read tools from mutation tools; scope credentials independently.
4. Require a fresh approval for every concrete production change.
5. Use idempotency keys and verify preconditions inside workflow steps.
6. Send approval and change events to an immutable audit destination.
7. Add rate limits, tool timeouts, redaction, and prompt-injection defenses.
8. Replace the demo signal cards with values from synchronized state.

## Project structure

```text
src/
  app.tsx            React incident room and approval controls
  client.tsx         Browser entry point
  domain.ts          Shared incident and workflow types
  observability.ts   Demo provider adapters
  server.ts          AIChatAgent, tools, state, and callable methods
  workflow.ts        Durable investigation and approval workflow
  styles.css         Responsive dashboard styling
wrangler.jsonc       AI, Durable Object, assets, and Workflow bindings
```

## Deploy

```bash
npm run deploy
```

Cloudflare will provision the Durable Object class, Workflow binding, Workers AI
binding, and static assets declared in `wrangler.jsonc`.

## Documentation

- [Cloudflare Agents](https://developers.cloudflare.com/agents/)
- [Agents with Workflows](https://developers.cloudflare.com/agents/concepts/workflows/)
- [Workers AI Llama 3.3](https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/)
- [Human-in-the-loop patterns](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/)

## License

MIT
