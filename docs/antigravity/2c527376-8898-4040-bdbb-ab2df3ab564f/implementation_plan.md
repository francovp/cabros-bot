# Expose Job Lifecycle Control (Cancel and Retry) Endpoints

Expose protected job lifecycle actions to cancel running TradingView jobs and retry failed/timed-out/cancelled jobs.

## User Review Required

> [!IMPORTANT]
> The endpoints require `validateApiKey` middleware just like the other job endpoints.
> We will add the following endpoints under `/api`:
> - `POST /api/jobs/:jobId/cancel` - Cancels an active job. Returns 409 if the job is already terminal.
> - `POST /api/jobs/:jobId/retry` - Retries a failed, timed_out, or cancelled job by starting a new job with the same request inputs.
> - `POST /api/jobs/:jobId/retry-failed` - Retries only the failed/timed-out indicators/scans of a completed or failed job.

## Proposed Changes

### Routes & Controllers

---

#### [MODIFY] [routes/index.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/implement-issue-automator/src/routes/index.js)
- Register the cancellation and retry routes:
  - `POST /jobs/:jobId/cancel` mapped to `postCancelJob`
  - `POST /jobs/:jobId/retry` mapped to `postRetryJob(botOrGetter)`
  - `POST /jobs/:jobId/retry-failed` mapped to `postRetryFailedJob(botOrGetter)`

#### [NEW] [jobs.js (controllers)](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/implement-issue-automator/src/controllers/webhooks/handlers/jobs/jobs.js)
- Export and implement:
  - `postCancelJob(req, res)`: Invokes `jobService.cancelJob(jobId)`. Returns `409` if the job is terminal, `404` if not found, or `200` on success.
  - `postRetryJob(botOrGetter)`: Invokes `jobService.retryJob(jobId, botOrGetter)`. Returns `201` with both `oldJobId` and `newJobId` on success, `404` if not found, `409` if job is not in a retryable status.
  - `postRetryFailedJob(botOrGetter)`: Invokes `jobService.retryFailedJob(jobId, botOrGetter)`. Returns `201` on success, `404` if not found, `409`/`400` if no failed items to retry.

---

### Service Layer

#### [MODIFY] [JobService.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/implement-issue-automator/src/services/jobs/JobService.js)
- Maintain `this.activeControllers = new Map()` to track active `AbortController`s by `jobId`.
- In `createJob(type, payload, botOrGetter)`:
  - Parse and validate payload synchronously.
  - Store the sanitized inputs as `job.requestMetadata` on the job object.
- In `_runBackgroundJob(jobId, parsed, payload, botOrGetter)`:
  - Create the `AbortController` and add it to `this.activeControllers`.
  - In `catch(error)` and `finally`:
    - Clean up `this.activeControllers`.
    - Check if the job was cancelled (via `status === 'cancelled'`). If cancelled, preserve the `cancelled` status.
    - If timed out, set status to `timed_out` instead of `failed` when no items were successfully processed.
- In `_executeExpandedAnalysis` and `_executeMarketScanner`:
  - After breaking due to abort signal, check if the status is `cancelled`. If so, skip rendering report/sending alert.
- Implement:
  - `cancelJob(jobId)`: Retrieve job. If terminal, return `{ success: false, code: 'TERMINAL_JOB', message: 'Job is already terminal' }`. If active, set status to `cancelled`, abort the controller, and persist.
  - `retryJob(jobId, botOrGetter)`: Retrieve job. If not `failed`, `timed_out`, or `cancelled`, return `{ success: false, code: 'NOT_RETRYABLE' }`. Otherwise, call `createJob` using `requestMetadata` as payload.
  - `retryFailedJob(jobId, botOrGetter)`: Retrieve job. If `processing`, return `{ success: false, code: 'JOB_ACTIVE' }`. Parse completed vs failed indicators/scans. Create a new job containing only the failed/timed-out items.

---

### Postman Collection

#### [MODIFY] [CabrosBot.postman_collection.json](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/implement-issue-automator/CabrosBot.postman_collection.json)
- Add new endpoints and request/response examples for `cancel`, `retry`, and `retry-failed`.

## Verification Plan

### Automated Tests
We will add new unit and integration tests under:
- `tests/unit/job-service.test.js`: Test job cancel, retry, retry-failed logic, and checking `requestMetadata` sanitization.
- `tests/unit/jobs-controller.test.js`: Test status codes (`200`, `201`, `404`, `409`) and error paths.
- `tests/integration/jobs-endpoint.test.js`: Test full lifecycle of job cancellation and retry workflows.

Run the test suites using:
```bash
pnpm test -- tests/unit/job-service.test.js
pnpm test -- tests/unit/jobs-controller.test.js
pnpm test -- tests/integration/jobs-endpoint.test.js
```
And final verification:
```bash
pnpm test
```
