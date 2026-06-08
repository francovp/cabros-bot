# Implement Async Job Mode for Long-Running TradingView Reports

Add an asynchronous job mode to prevent HTTP timeout budgets (502/504) for slow TradingView MCP flows:
- `POST /api/jobs/tradingview-analysis` starts a background job and returns a `jobId`
- `GET /api/jobs/:jobId` returns the status, progress, final report, and delivery state

---

## User Review Required

> [!NOTE]
> All background job operations will run on an in-memory job store. The job store will automatically evict jobs older than 1 hour to prevent memory leaks.

## Proposed Changes

### Job Service

#### [NEW] [JobService.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/implement-github-issue-53/src/services/jobs/JobService.js)
Implement `JobService` to manage in-memory job state and execute background runs.
- **Attributes of a job**:
  - `jobId`: unique UUID
  - `type`: `'expanded-analysis'` or `'market-scanner'`
  - `status`: `'pending' | 'processing' | 'completed' | 'failed'`
  - `progress`: `{ total, current, status }`
  - `results` / `scanResults`: list of symbol/scan outputs populated dynamically
  - `alertText`: final formatted report markdown
  - `deliveryResults`: notifications dispatch outcome
  - `summary`: final status summary
  - `error`: failure message if job fails
  - `createdAt`, `updatedAt`, `totalDurationMs`
- **Background Execution**:
  - Automatically initializes and calls `NotificationManager.sendToAll()` upon completion.
  - Updates progress dynamically after each symbol is analyzed or scan is run.

### Controllers

#### [NEW] [jobs.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/implement-github-issue-53/src/controllers/webhooks/handlers/jobs/jobs.js)
Define HTTP controllers to create and retrieve jobs.
- `postCreateJob`:
  - Validates `type` parameter (`'expanded-analysis'` or `'market-scanner'`).
  - Runs request parsing/validation synchronously before creating the job so that bad inputs return a `400 Bad Request` immediately.
  - Checks if the requested feature is enabled (e.g. returns `404` or `400` if `market-scanner` is requested but `process.env.ENABLE_MARKET_SCANNER` is not `'true'`).
  - Spawns background execution and returns a `201 Created` response.
- `getJobStatus`:
  - Resolves `jobId` parameter.
  - Returns `404 Not Found` if the job does not exist.
  - Returns `200 OK` with the job details.

### Router

#### [MODIFY] [index.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/implement-github-issue-53/src/routes/index.js)
Register routes under the `validateApiKey` middleware:
- `POST /api/jobs/tradingview-analysis` -> `postCreateJob`
- `GET /api/jobs/:jobId` -> `getJobStatus`

---

## Verification Plan

### Automated Tests

- **Unit Tests**:
  - Create `tests/unit/job-service.test.js` to assert job lifecycle, progress transitions, and automatic eviction of expired entries.
  - Create `tests/unit/jobs-controller.test.js` to assert validation behavior (e.g., synchronous 400 for bad parameters, 404 for disabled market scanner).
- **Integration Tests**:
  - Create `tests/integration/jobs-endpoint.test.js` to assert end-to-end flow:
    1. Creating an `expanded-analysis` job.
    2. Polling progress until `'completed'` status.
    3. Verification of final `alertText`, `deliveryResults`, and `results` payload structure matching sync endpoint.

To run tests:
```bash
pnpm test -- tests/unit/job-service.test.js tests/unit/jobs-controller.test.js tests/integration/jobs-endpoint.test.js
```

### Manual Verification

Using curl, check route access and validation:
1. Create a job:
   ```bash
   curl -X POST -H "Content-Type: application/json" -H "x-api-key: YOUR_KEY" -d '{"type": "expanded-analysis", "symbols": ["BINANCE:BTCUSDT"]}' http://localhost:80/api/jobs/tradingview-analysis
   ```
2. Poll the job status:
   ```bash
   curl -H "x-api-key: YOUR_KEY" http://localhost:80/api/jobs/<jobId>
   ```
