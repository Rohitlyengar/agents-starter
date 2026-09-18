These are seven  prompts that helped build the project:

## 1. Start the project

Change this Cloudflare Agents starter into an **Incident Commander** app.
- Remove packages we don't need.
- Add shared types for: incident, severity, status, timeline, evidence, hypothesis, and workflow progress.
- Add one demo incident: SEV-1, checkout is slow.
- Add helpers to make new IDs and the starting state.
- Keep the types free of any framework, so the Worker, workflow, and React app can all use them.

## 2. Add fake monitoring data

Make one small module for monitoring data. The agent and the workflow both use it.
- Add demo functions to: check metrics, search logs, list recent deploys.
- The fake data should tell one story:
    - Checkout gets slow and errors go up.
    - The database runs out of connections.
    - Logs show connection timeouts.
    - A deploy with a fraud check went out 6 minutes before the alert.
- Keep the functions easy to swap for real tools later (Datadog, Grafana, Sentry).

## 3. Build the workflow

Build an `InvestigationWorkflow` with Cloudflare Agent Workflows.
- Steps: collect metrics, group the logs, check recent deploys, send each finding to the agent, then make a main guess with a suggested rollback.
- Show progress the whole time.
- Before fixing anything, wait for a human to approve (up to 7 days).
- After approval, run a fake rollback (safe to run twice), then check that latency and errors are back to normal.
- Never fix anything without approval.

## 4. Build the agent

Replace the starter Worker with an `AIChatAgent` named `IncidentCommander`.
- Save chat and incident state in a Durable Object.
- Use Workers AI (Llama 3.3 70B) and stream the replies.
- Give the model tools to: check metrics, search logs, list deploys, add a hypothesis, add a timeline note, and start the workflow.
- Also support MCP tools.
- Add methods to open/reset an incident and to approve/reject the fix.
- Handle workflow progress, evidence, finish, and errors by updating the state and timeline.
- Rules:
    - Status questions are read-only.
    - Start an investigation only when asked.
    - Every production action needs approval.

## 5. Set up Cloudflare

Set up Wrangler for this Worker.
- Add: remote Workers AI, the `IncidentCommander` Durable Object (with SQLite), the `InvestigationWorkflow`, single-page-app files, Node.js support, and observability.
- Regenerate the TypeScript types so all bindings are typed.
- Make sure agent and OAuth routes reach the Worker before the static file fallback.

## 6. Build the screen

Replace the starter UI with a React incident dashboard.
- Connect it to the agent with WebSocket sync and typed RPC.
- Add:
    - Top bar with incident and connection status.
    - AI chat that streams, with tool cards.
    - Suggested prompts.
    - Workflow card with progress and clear Approve / Reject buttons.
    - Panels for live signals, evidence, ranked hypotheses, and timeline.
    - Buttons to reset, stop generating, and show raw messages.
- Style: dark and clean, strong SEV-1 and approval colors, easy to use, scrolling areas, animations, works on desktop, tablet, and phone.

## 7. Docs and checks

Write a short README.
- Explain: how it is built, the demo story, local setup, commands, folders, deploy, and how to replace the fake monitoring.
- Say clearly: the rollback is fake, but the approval flow is real.
- List what is needed before real use: login, permissions, audit logs, safe repeat runs, rate limits, hiding secrets, and protection from prompt injection.
- Add scripts for: format, lint, TypeScript check, type generation, dev, and deploy.
- Run the full check command at the end to make sure it all works.
