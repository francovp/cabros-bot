## Problem
The async job API currently requires clients to poll `GET /api/jobs/:jobId` until completion. That is workable for manual use, but poor for external automations that create long-running TradingView analysis or market-scanner jobs and then need to continue only when the final report and delivery summary are ready.

The current `JobService` already computes terminal summaries and delivery results; there is just no outbound completion contract.

## Proposed scope
Allow `POST /api/jobs/tradingview-analysis` to accept optional callback metadata, for example:
- `callbackUrl`
- `callbackSecret` or a server-side configured signing secret
- optional `callbackEvents`, defaulting to terminal states only

When a job reaches a terminal state, send a bounded JSON payload to the callback URL with:
- `jobId`, `type`, `status`, `createdAt`, `updatedAt`, `totalDurationMs`
- compact results or scan summary
- delivery summary
- failure `error` / `code` when applicable
- HMAC signature header so receivers can verify authenticity

## Security and reliability notes
- Use short HTTP timeouts and small retry counts.
- Restrict to `https://` callback URLs unless explicitly allowed for local development.
- Avoid sending raw secrets or full internal MCP payloads.
- Record callback attempt status in the job response for debugging.

## Why this matters
- External clients no longer need tight polling loops.
- Async jobs become easier to integrate with schedulers, dashboards, and workflow tools.
- Failures become observable by the caller even if they stop polling.

## Acceptance criteria
- Jobs without callback metadata behave exactly as they do today.
- Callback payloads are stable JSON and do not expose secrets.
- Terminal states trigger at most one successful callback, with bounded retries on transient failures.
- Callback failures do not change the underlying job result.
- Tests cover success, timeout, invalid URL, signing, and retry/failure recording.

---
**Linear**: [CB-28](https://linear.app/knil/issue/CB-28/add-async-job-completion-callbacks)
