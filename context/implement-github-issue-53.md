## Summary

Adds an asynchronous job mode for long-running TradingView analysis and market scanner workflows to avoid HTTP gateway timeout budgets (502/504).

## Key Changes

### :hourglass_flowing_sand: Asynchronous Jobs API

- Added `POST /api/jobs/tradingview-analysis` to create a job and start background execution, returning a `201 Created` response with the `jobId`.
- Added `GET /api/jobs/:jobId` to retrieve job status, progress, final analysis reports, and delivery state.

### :card_index_dividers: Job State Management

- Added `JobService` to manage in-memory job states, update partial progress dynamically as symbols are analyzed or scans run, and clean up expired jobs (older than 1 hour) automatically.

### :shield: Synchronous Validation

- Handles parameter and feature validation synchronously prior to creating jobs, ensuring bad requests receive immediate `400 Bad Request` feedback.

## Technical Implementation

### Architecture changes

#### `JobService`
Coordinates background executions, handles deadline controllers, processes symbols/scans sequentially with retry and signal propagation, and dispatches notifications via `NotificationManager`.

#### `JobsController`
Exposes endpoint handlers for creating and polling jobs, incorporating Sentry error reporting.

### File Structure Additions

```text
src/
├── controllers/webhooks/handlers/jobs/
│   └── jobs.js
└── services/jobs/
    └── JobService.js
```

## Testing infraestructure

### Test Suite

- **16 Unit Tests**
- **4 Integration Tests**

### Test Coverage

- Synchronous input and feature validation.
- In-memory job lifecycle transitions (`pending` -> `processing` -> `completed`/`failed`).
- Real-time progress updates.
- Background execution timeouts and MCP failure handling.
- Automatic job eviction for entries older than 1 hour.
- Authorization checks on job endpoints.

### Test Files

- `tests/unit/job-service.test.js`: JobService lifecycle and eviction tests.
- `tests/unit/jobs-controller.test.js`: Jobs controller parameter parsing and validation tests.
- `tests/integration/jobs-endpoint.test.js`: End-to-end integration tests with progress polling.

## Documentation Updates

- **README.md** Documents the new Asynchronous Jobs API endpoints, payloads, and response structures.
- **agents.md** Documents key files, architecture details, and failure behavior of the jobs feature.

## Testing

### Pre-merge Verification

- [x] `npx jest --runInBand --detectOpenHandles` (All 512 tests passed successfully)

### Post-merge Verification

- [ ] Deploy and verify POST `/api/jobs/tradingview-analysis` with valid `x-api-key` header starts a job.
- [ ] Verify GET `/api/jobs/:jobId` returns complete job summary, report, and delivery outcomes once done.

## References

- Closes #53.

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
