## Summary
Add optional callback metadata (`callbackUrl`, `callbackSecret`, `callbackEvents`) to `POST /api/jobs/tradingview-analysis` and send a signed JSON payload to the URL on terminal job states.

## Context
The async job API currently requires clients to poll `GET /api/jobs/:jobId` until completion. Outbound completion contracts are needed for external automations so they don't have to use tight polling loops.

## Acceptance Criteria
- Jobs without callback metadata behave exactly as they do today.
- Callback payloads are stable JSON and do not expose secrets.
- Terminal states trigger at most one successful callback, with bounded retries on transient failures.
- Callback failures do not change the underlying job result.
- Tests cover success, timeout, invalid URL, signing, and retry/failure recording.

## References
- GitHub Issue: https://github.com/francovp/cabros-bot/issues/72
