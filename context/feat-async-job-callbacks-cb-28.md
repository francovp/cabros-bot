feat: add async job completion callbacks (CB-28)

## Summary
Add support for asynchronous job completion callbacks in TradingView analysis and market scanner background jobs. This allows clients to receive webhook callbacks when background jobs finish execution.

## Key Changes
- Modified `src/services/jobs/JobService.js` to accept `callbackUrl`, `callbackSecret`, and `callbackEvents` upon creating a job.
- Implemented node-native HTTPS/HTTP URL verification and format checks for callback targets.
- Added signature verification via HMAC-SHA256 in the `x-callback-signature` header using `callbackSecret` or the server-wide `JOB_CALLBACK_SIGNING_SECRET`.
- Designed background execution of callbacks with AbortController timeout (5s) and automatic retry logic (up to 3 retries, 4 total attempts) with exponential backoff.
- Configured retry delay to be customizable via the `JOB_CALLBACK_RETRY_DELAY_MS` environment variable for fast unit testing.
- Preserved the fail-open architecture: callback failures are logged and recorded in the job metadata (`callbackStatus`) but do not affect or block the completion/failure state of the core job.

## Technical Implementation
- URL parsing and validation is done using the native `URL` constructor.
- Signatures are constructed using `crypto.createHmac`.
- Retries are orchestrated in the fire-and-forget `_sendCallbackWithRetry` loop using `setTimeout`.
- Job status endpoints (`GET /api/jobs/:jobId`) automatically include the formatted `callbackStatus` containing attempts logs.

## Testing
- Added robust unit test coverage in `tests/unit/job-service.test.js` covering callback parameters validation, HTTP/HTTPS gating, HMAC signature generation, retry backoff delays, and fail-open behaviors.
- Added endpoint integration tests in `tests/integration/jobs-endpoint.test.js` validating authentication, bad requests on invalid callback URLs, and E2E callback execution on job completion.
- Verified that all unit and integration tests (24 JobService unit tests, 7 jobs integration tests) pass successfully.

## References
**Linear**: [CB-28](https://linear.app/francovp/issue/CB-28/add-async-completion-callbacks)
