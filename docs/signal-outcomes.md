# Signal Outcomes Tracking (CB-199)

[← Back to README](../README.md) | [API Reference](api-reference.md)

### Signal Outcomes (CB-199)

#### GET /api/outcomes

Query durably recorded signal outcomes record-by-record with pagination and filtering by symbol, exchange, status, window, and date range. Requires `x-api-key` header (or deprecated `api-key` query parameter — see [GH-756](https://github.com/francovp/cabros-bot/issues/756)) or Firebase Bearer token with `admin.viewer` or `admin.operator` role. Returns `403 FEATURE_DISABLED` if `ENABLE_SIGNAL_OUTCOME_TRACKING !== 'true'`, and `503 STORAGE_UNAVAILABLE` if Firestore is enabled but inaccessible.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either an ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `symbol` - Filter by trading symbol (e.g. `BTCUSDT` or `BINANCE:BTCUSDT`)
- `exchange` - Filter by exchange identifier (e.g. `BINANCE`, `NASDAQ`)
- `status` - Filter by evaluation status (`pending`, `evaluated`, `unavailable`)
- `window` - Filter by measurement window (`1h`, `4h`, `1D`, `1W`)
- `from` - Optional ISO-8601 lower bound timestamp
- `to` - Optional ISO-8601 upper bound timestamp

**Response (200 OK):**
```json
{
  "success": true,
  "outcomes": [
    {
      "id": "outcome-doc-1",
      "receivedAt": "2026-08-23T12:00:00.000Z",
      "observedAt": "2026-08-23T12:00:00.000Z",
      "decisionBarClosedAt": null,
      "tradableAt": "2026-08-23T12:00:00.000Z",
      "anchorMode": "raw_received_at",
      "anchorVersion": "v1",
      "calendarId": null,
      "calendarTimeZone": null,
      "sessionContext": "crypto_24_7",
      "measurementCohort": "raw_received_at",
      "requestId": "req-1",
      "source": "news-monitor",
      "symbol": "BTCUSDT",
      "exchange": "BINANCE",
      "assetClass": "crypto",
      "timeframe": "1h",
      "setupType": "breakout",
      "score": 0.9,
      "side": "BUY",
      "price": 65000,
      "observedPrice": 65000,
      "tradablePrice": 65000,
      "entryPriceSource": "tradingview-mcp",
      "stop": 63000,
      "target": 68000,
      "marketDataProvider": "binance",
      "eligibilityState": "supported_provider",
      "eligibilityReason": null,
      "outcomeEvaluated": true,
      "outcomes": {
        "1h": {
          "status": "evaluated",
          "reason": null,
          "targetTime": "2026-08-23T13:00:00.000Z",
          "anchorMode": "raw_received_at",
          "anchorVersion": "v1",
          "measurementCohort": "raw_received_at",
          "price": 66000,
          "return": 1.5385,
          "maxFavorableExcursion": 2.0,
          "maxAdverseExcursion": -0.2,
          "firstHit": null,
          "targetHit": false,
          "stopHit": false,
          "firstHitTime": null,
          "rMultiple": 0.5
        }
      },
      "sources": [],
      "tokenUsage": {
        "inputTokens": 100,
        "outputTokens": 40,
        "totalTokens": 140,
        "totalCost": 0.00003
      },
      "processingTimeMs": 150
    }
  ],
  "pagination": {
    "limit": 50,
    "hasMore": false,
    "nextBefore": null
  }
}
```

Equity records also persist `sessionContext`, `decisionBarClosedAt`, `tradableAt`, and separate observed/tradable price fields. Post-close or holiday records are labeled `raw_received_at_after_hours` or `raw_market_closed`; they remain in the shadow raw-observation cohort until a separate executable-session price is available.

#### GET /api/outcomes/summary

Query aggregated performance and coverage metrics for recorded signal outcomes, with optional filtering by symbol, exchange, status, window, and date range. Explicit `from`/`to` ranges may include archived records restored from backups; requests without `from` remain bounded by the configured retention window. When no outcomes match the filters or tracking is enabled with an empty dataset, the endpoint returns `200 OK` with `available: false` and a typed empty summary structure. Requires `x-api-key` header (or deprecated `api-key` query parameter — see [GH-756](https://github.com/francovp/cabros-bot/issues/756)) or Firebase Bearer token with `admin.viewer` or `admin.operator` role.

**Query Parameters:**
- `limit` - Maximum number of recent outcomes to aggregate (integer between `1` and `100`, default: `50`)
- `symbol` - Filter by trading symbol (e.g. `BTCUSDT` or `BINANCE:BTCUSDT`)
- `exchange` - Filter by exchange identifier (e.g. `BINANCE`, `NASDAQ`)
- `status` - Filter by evaluation status (`pending`, `evaluated`, `unavailable`)
- `window` - Filter by measurement window (`1h`, `4h`, `1D`, `1W`)
- `from` - Optional ISO-8601 lower bound timestamp
- `to` - Optional ISO-8601 upper bound timestamp

**Response (200 OK):**
```json
{
  "success": true,
  "summary": {
    "available": true,
    "totalSignalsReceived": 50,
    "totalSignalsEligible": 45,
    "totalSignalsEvaluated": 40,
    "totalSignalsPending": 5,
    "totalSignalsUnavailable": 5,
    "coveragePercent": 80,
    "isCoverageComplete": false,
    "targetHitRatePercent": 65.5,
    "stopHitRatePercent": 25,
    "expectancyR": 1.25,
    "populationNote": "Metrics represent 40 evaluated signals out of 50 total received signals (80% coverage).",
    "exchangeBreakdown": {
      "BINANCE": {
        "received": 40,
        "eligible": 40,
        "evaluated": 35,
        "pending": 3,
        "unavailable": 2
      }
    },
    "providerBreakdown": {
      "binance": {
        "received": 40,
        "eligible": 40,
        "evaluated": 35,
        "pending": 3,
        "unavailable": 2
      }
    },
    "entryPriceSourceBreakdown": {
      "tradingview-mcp": 40
    },
    "eligibilityBreakdown": {
      "supported_provider": 45
    },
    "windows": {
      "1h": {
        "totalSignals": 35,
        "hitRatePercent": 60,
        "targetEligibleWindows": 30,
        "stopEligibleWindows": 30,
        "targetHitRatePercent": 55,
        "stopHitRatePercent": 20,
        "expectancyR": 0.85,
        "averageReturnPercent": 2.15,
        "averageMfePercent": 3.45,
        "averageMaePercent": -1.1,
        "maxAdverseExcursionPercent": -4.5
      }
    },
    "drawdownProxy": {
      "averageMaxAdverseExcursionPercent": -1.85,
      "absoluteMaxAdverseExcursionPercent": -7.2
    },
    "falsePositiveCandidatesCount": 0,
    "falsePositiveCandidates": [],
    "latencyCostMetadata": {
      "averageProcessingTimeMs": 450,
      "tokenUsage": {
        "inputTokens": 1200,
        "outputTokens": 400,
        "totalCost": 0.0035
      }
    }
  }
}
```

#### GET /api/outcomes/calibration

Query empirical confidence calibration feedback metrics comparing news-monitor and alert confidence scores against realized signal outcomes. Groups evaluated signals into confidence buckets (`<0.70`, `0.70-0.75`, `0.75-0.80`, `0.80-0.85`, `0.85-0.90`, `0.90-1.00`), calculating count, average 1h and 4h returns, and target hit rate per bucket. Also computes a recommended confidence threshold with deterministic rationale once an empirical sample of at least 20 scored alerts is available. Requires `x-api-key` header (or `api-key` query parameter) or Firebase Bearer token with `admin.viewer` or `admin.operator` role.

**Query Parameters:**
- `limit` - Maximum number of recent signals to evaluate for calibration (integer between `1` and `1000`, default: `1000`)
- `symbol` - Filter by trading symbol (e.g. `BTCUSDT` or `BINANCE:BTCUSDT`)
- `exchange` - Filter by exchange identifier (e.g. `BINANCE`, `NASDAQ`)
- `window` - Evaluation window for hit-rate benchmark (`1h`, `4h`, `1D`, `1W`, default: `4h`)
- `from` - Optional ISO-8601 lower bound timestamp
- `to` - Optional ISO-8601 upper bound timestamp

**Response (200 OK):**
```json
{
  "success": true,
  "calibration": {
    "available": true,
    "totalScoredAlerts": 45,
    "buckets": [
      {
        "range": "0.70-0.75",
        "count": 10,
        "avgReturn1h": 0.45,
        "avgReturn4h": 0.82,
        "targetHitRate": 0.4
      },
      {
        "range": "0.75-0.80",
        "count": 15,
        "avgReturn1h": 1.12,
        "avgReturn4h": 1.85,
        "targetHitRate": 0.6
      },
      {
        "range": "0.80-0.85",
        "count": 12,
        "avgReturn1h": 1.45,
        "avgReturn4h": 2.3,
        "targetHitRate": 0.67
      },
      {
        "range": "0.85-0.90",
        "count": 6,
        "avgReturn1h": 1.95,
        "avgReturn4h": 3.1,
        "targetHitRate": 0.83
      },
      {
        "range": "0.90-1.00",
        "count": 2,
        "avgReturn1h": 2.4,
        "avgReturn4h": 3.8,
        "targetHitRate": 1.0
      }
    ],
    "suggestedThreshold": 0.75,
    "suggestedThresholdRationale": "Alerts at 0.75+ show 60%+ target hit rate at 4h window"
  }
}
```

---

### Evaluation Worker: Single-Evaluator Guarantee

`ENABLE_SIGNAL_OUTCOME_TRACKING=true` (enabled in production) records signals on the alert path and starts the evaluation sweep. The sweep runs in whichever process matches its own `SIGNAL_OUTCOME_WORKER_ROLE` — `web` for the web service, `worker` for the dedicated `cabros-crypto-bot-signal-outcome-worker`, `disabled` to suppress it. Both services are declared in `render.yaml` and may be enabled at the same time.

Each sweep is therefore claimed with a Firestore lease in the `signalOutcomeLocks` collection:

- The replica that loses the claim skips with `reason: "lease-held"` and makes no market-data calls, so a pending signal is never evaluated twice.
- Ownership is also checked while the sweep runs. A renewal that proves the lease was taken over mid-sweep **halts** the sweep before the next document, so a losing replica stops pricing signals rather than finishing the batch.
- An expired lease is taken over rather than skipped indefinitely.
- If Firestore is unavailable or the lease write cannot be attempted, the sweep **proceeds anyway**. A lock-service failure degrades to single-process behaviour instead of stopping outcome evaluation. Only *proven* ownership loss stops a sweep; an unchecked lease is not proof of loss.
- Duration: `SIGNAL_OUTCOME_EVALUATION_LEASE_MS` (`10000`-`600000`, default `120000`). The worker warns at startup if the lease does not exceed `SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS`, because a sweep that outlives its own lease can legitimately be taken over mid-run.

Check `GET /api/status` (or `/api/capabilities`) under `dependencies.signalOutcomeWorker`:

| Field | Meaning |
| :--- | :--- |
| `leaseMs` | Configured lease duration. |
| `lastRunLeaseHeld` | The most recent sweep did not run to completion as the lease holder. |
| `leaseHeldSkipCount` | Cumulative sweeps since start that did not run to completion as the lease holder. |

A sweep halted by a lost lease can still report a non-zero `lastRunEvaluatedCount` for the documents it finished before ownership moved on — the abort is counted, not the individual documents. A replica whose `leaseHeldSkipCount` keeps climbing while its `lastRunEvaluatedCount` stays at `0` is not the evaluator — that is how you identify which process is actually doing the work. A `lastRunAt` that never advances, or counters stuck at zero, means the sweep is not running at all regardless of what `featureFlags.signalOutcomeTracking` reports.
