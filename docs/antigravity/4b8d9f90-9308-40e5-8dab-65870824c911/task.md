# Task: Implement Async Job Mode for Long-Running TradingView Reports

- [x] CHK001 - Implement `JobService.js` to manage in-memory job state and execute background runs.
- [x] CHK002 - Implement `jobs.js` controller to handle `POST /api/jobs/tradingview-analysis` and `GET /api/jobs/:jobId`.
- [x] CHK003 - Register job routes with API key validation in `src/routes/index.js`.
- [x] CHK004 - Implement unit tests for `JobService` (`tests/unit/job-service.test.js`).
- [x] CHK005 - Implement unit tests for jobs controller (`tests/unit/jobs-controller.test.js`).
- [x] CHK006 - Implement integration tests for the endpoints (`tests/integration/jobs-endpoint.test.js`).
- [x] CHK007 - Verify all tests pass.
- [x] CHK008 - Archive session artifacts to `docs/antigravity/` folder before completion.
- [x] CHK009 - Modify `_cleanExpiredJobs()` to not evict processing or pending jobs.
- [x] CHK010 - Store validated `timeoutMs` directly on the job object and reuse it in background execution.
- [x] CHK011 - Add unit tests for the new eviction rules and the parsed `timeoutMs` representation.
- [x] CHK012 - Run all tests and verify.
- [x] CHK013 - Commit local changes and reply to the PR comments.
