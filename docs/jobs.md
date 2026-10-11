# Asynchronous Analysis Jobs API

[← Back to README](../README.md) | [API Reference](api-reference.md)

### Asynchronous Jobs API

To run long-running technical analysis or market scans without hitting HTTP request limits or gateway timeouts (502/504), you can use the asynchronous jobs API. All endpoints require the `x-api-key` header to be configured.

#### POST /api/jobs/tradingview-analysis

Start a background analysis or scanner job.

**Request (JSON - Expanded Analysis):**
```json
{
  "type": "expanded-analysis",
  "symbols": ["BINANCE:BTCUSDT"],
  "timeframe": "1D",
  "includeMultiTimeframe": true
}
```

**Request (JSON - Market Scanner):**
```json
{
  "type": "market-scanner",
  "exchange": "BINANCE",
  "timeframe": "4h",
  "scans": ["top_gainers", "top_losers"],
  "limit": 5,
  "ranked": true,
  "includeMultiTimeframe": true
}
```

For market-scanner jobs, `ranked` and `includeMultiTimeframe` use the same scoring and fail-open higher-timeframe enrichment as the synchronous scanner endpoint. If the job deadline aborts enrichment after a scan completes, that scan is retained and only remaining scans are marked as timed out.

**Response (201 Created):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "status": "processing",
  "createdAt": "2026-05-25T01:30:00.000Z"
}
```

**Idempotency:** `POST /api/jobs/tradingview-analysis`, `POST /api/jobs/:jobId/retry`, and `POST /api/jobs/:jobId/retry-failed` accept an optional client-generated `idempotency-key` header. Matching concurrent or sequential requests replay the original response and `jobId`/`newJobId` without starting another worker. The first response sends `Idempotency-Replay: false`; a replay sends `Idempotency-Replay: true` and includes `"idempotencyReplayed": true` in the JSON response. `JOB_QUEUE_ACCEPTANCE_UNKNOWN` responses are also replayable and include the durable `jobId`, preventing a retry from creating a second queue item. Reusing a key with a different request fingerprint returns `409 IDEMPOTENCY_CONFLICT`. Requests without the header retain current behavior.

Example:
```http
POST /api/jobs/tradingview-analysis
idempotency-key: job-create-2026-07-26-001
```

The idempotency cache is in-memory, bounded, and retained for five minutes by default (`WEBHOOK_IDEMPOTENCY_TTL_MS` can override the TTL). Request fingerprints canonicalize nested object key order while preserving array order.

#### POST /api/jobs/:jobId/retry and /api/jobs/:jobId/retry-failed

Retry a cancelled/failed job or only its failed items. Supply the same `idempotency-key` when retrying a request after a timeout or lost response to receive the original `newJobId` instead of creating another background job.

When `callbackUrl` is configured, each callback POST includes:

- `x-callback-timestamp` - ISO-8601 delivery timestamp; reject stale values outside your freshness window.
- `x-callback-event` - job event (`processing`, `completed`, `failed`, `cancelled`, or `timed_out`).
- `x-callback-delivery-id` - UUID unique to this HTTP delivery attempt; use it for deduplication.
- `x-callback-signature` - included when `callbackSecret` or `JOB_CALLBACK_SIGNING_SECRET` is configured.

Before each delivery attempt, hostname callback URLs are resolved with all current DNS answers. Any private answer blocks the callback (unless `ALLOW_PRIVATE_CALLBACKS=true`), and the connection is pinned to the validated answers so the subsequent fetch cannot perform a second hostname lookup and bypass the SSRF check. Redirects remain disabled with `redirect: 'error'`.

`ALLOW_HTTP_CALLBACKS` and `ALLOW_PRIVATE_CALLBACKS` are local/testing security overrides and should remain `false` in production. `JOB_CALLBACK_RETRY_DELAY_MS` defaults to `1000` ms; `JOB_CALLBACK_SIGNING_SECRET` is an optional server-side HMAC secret and must never be committed.

Verify the signature with HMAC-SHA256 over this exact canonical string, using the shared secret and the raw JSON request body:

```text
x-callback-timestamp + "\n" + x-callback-event + "\n" + x-callback-delivery-id + "\n" + raw-request-body
```

Retries generate a new delivery ID and signature for every attempt. The `callbackStatus.attempts` records include the same `deliveryId` for audit and deduplication.

#### GET /api/jobs

List recent sanitized jobs. The endpoint includes jobs from the in-memory repository and, when Firestore job storage is enabled, jobs persisted in `tradingviewJobs`. Expired terminal jobs are excluded.

**Query Parameters:**
- `status` - Optional: `pending`, `processing`, `completed`, `failed`, `cancelled`, or `timed_out`
- `type` - Optional: `expanded-analysis` or `market-scanner`
- `limit` - Integer between `1` and `100` (default: `50`)

**Response (200 OK):**
```json
{
  "success": true,
  "jobs": [
    {
      "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
      "type": "expanded-analysis",
      "status": "completed",
      "progress": { "total": 1, "current": 1 },
      "createdAt": "2026-05-25T01:30:00.000Z",
      "updatedAt": "2026-05-25T01:30:12.000Z",
      "totalDurationMs": 12053
    }
  ]
}
```

#### GET /api/jobs/:jobId

Retrieve status, partial progress, final report, and delivery state of a job.
Jobs are retained in memory and, when Firestore job storage is enabled, persisted to the `tradingviewJobs` collection so status survives process restarts. Completed, failed, cancelled, and timed-out jobs are automatically evicted after 1 hour. Durable terminal documents receive an `expiresAt` timestamp based on `createdAt`; run `bash ops/configure-firestore-alert-retention.sh` once per Firebase project to backfill legacy terminal jobs and enable native TTL deletion for `tradingviewJobs`. Firestore TTL deletion is eventually consistent, while the API still filters expired jobs on reads.

For completed ranked market-scanner jobs, `scanResults[].scores[]` contains the structured `symbol`, numeric `score`, non-empty `reason`, and optional `trendConfluence` fields used by the alert report. This is also included in configured terminal callback payloads.

Set `ENABLE_FIRESTORE_JOB_STORAGE=true` plus the normal Firebase Admin credentials (`FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`) to enable durable job storage. The legacy in-memory path remains the fallback when Firestore is disabled or unavailable.

By default, jobs still execute in-process (`JOB_EXECUTION_MODE=local`). With `JOB_EXECUTION_MODE=render-worker` (BullMQ + Redis) or `JOB_EXECUTION_MODE=firestore-poller` (direct Firestore polling), the web service stores sanitized job metadata in Firestore and enqueues/persists the job for the dedicated `pnpm run start-worker` process. The worker claims eligible queued jobs transactionally, periodically reconciles durable rows still marked `processing`/`queued` plus expired `claimed`/`running` leases, renews its lease at persistence checkpoints, and drains active work on `SIGTERM`. Notification delivery is checkpointed durably before and after the external send; a redelivery with an unknown outcome fails closed as `JOB_DELIVERY_RECONCILIATION_REQUIRED` rather than sending the same alert twice. Missing Redis (in `render-worker` mode) or durable Firestore storage fails the create request with `503 JOB_QUEUE_UNAVAILABLE`.

**Response (200 OK - Processing):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "type": "expanded-analysis",
  "status": "processing",
  "progress": {
    "total": 2,
    "current": 1,
    "status": "Analyzing symbol BINANCE:BTCUSDT (1/2)"
  },
  "results": [
    {
      "symbol": "BINANCE:BTCUSDT",
      "status": "analyzed",
      "price": 65430,
      "rsi": 43.5
    }
  ],
  "createdAt": "2026-05-25T01:30:00.000Z",
  "updatedAt": "2026-05-25T01:30:05.000Z",
  "totalDurationMs": 5123
}
```
