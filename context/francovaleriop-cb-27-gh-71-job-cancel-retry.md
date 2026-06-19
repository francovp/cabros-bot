feat: add async job cancellation and retry endpoints (CB-27)

## Summary

Exposes protected job lifecycle actions (`cancel`, `retry`, and `retry-failed`) for long-running scan or analysis jobs under the `/api` routing namespace.

## Key Changes

### :wrench: Expose Job cancellation and retries

- Exposes three new protected routes:
  - `POST /api/jobs/:jobId/cancel` - Cancels an active/processing job by aborting its remote stream queries.
  - `POST /api/jobs/:jobId/retry` - Retries a failed, timed-out, or cancelled job by starting a new job with the same request inputs.
  - `POST /api/jobs/:jobId/retry-failed` - Retries only the subset of indicators or scans that failed or timed out during the original run.
- Ensures all new endpoints validate the `x-api-key` header/param just like core webhook alert endpoints.
- Avoids mutating completed or failed history by returning a brand new `jobId` for retries, providing clear traceability back to the `oldJobId`.
- Preserves terminal statuses: `completed`, `failed`, `cancelled`, and `timed_out`.

## Technical Implementation

### Service Layer

- Track active `AbortController` instances inside `JobService` using `this.activeControllers`.
- Maintain sanitized request metadata (`requestMetadata`) on the stored job object upon job creation, avoiding leaks of any credentials or secrets.
- Add cancellation checks inside loop iterations of `_executeExpandedAnalysis` and `_executeMarketScanner` to stop remote TradingView MCP requests instantly.
- Protect `_persistJob` to prevent race conditions or state overwriting where a processing background thread could overwrite a terminal cancelled status.

### Routes & Controllers

- Add `postCancelJob`, `postRetryJob`, and `postRetryFailedJob` controllers under `src/controllers/webhooks/handlers/jobs/jobs.js`.
- Mount routes and apply validation middleware in `src/routes/index.js`.
- Update Postman Collection `CabrosBot.postman_collection.json` with the new endpoint contract examples.

## Testing

### Automated Tests

- New unit tests added in `tests/unit/job-service.test.js` validating:
  - Cancellation of active jobs and 409 responses for terminal states.
  - Retry functionality with correct duplication of `requestMetadata`.
  - Selective retry of only failed items.
- New unit tests added in `tests/unit/jobs-controller.test.js` asserting status codes and Sentry monitoring.
- Integration tests in `tests/integration/jobs-endpoint.test.js` checking end-to-end cancellation and retry lifecycle flow.

## References

- GitHub Issue: https://github.com/francovp/cabros-bot/issues/71
- **Linear**: [CB-27](https://linear.app/knil/issue/CB-27/add-async-job-cancellation-and-retry-endpoints)
