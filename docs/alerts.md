# Stored Alerts API

[← Back to README](../README.md) | [API Reference](api-reference.md)

### Stored Alerts API

When `ENABLE_FIRESTORE_ALERT_STORAGE=true`, successful `POST /api/webhook/alert`, news-monitor deliveries, and delivered `POST /api/webhook/market-scanner-alert` / `POST /api/webhook/expanded-analysis-alert` reports are persisted to Firestore and can be inspected through the protected alerts read API. Each stored record carries a `source` field of one of `webhook`, `news-monitor`, `market-scanner`, or `expanded-analysis`. Stored alert text is capped at 20,000 characters; when clipped, the record exposes `truncated: true` and `originalLength` so the read API, export, and replay can flag the loss — `replay` will redeliver the truncated text only.

Stored `alerts` and `alertReplays` records default to 90 days of retention. The service filters expired records before list, detail, export, and summary responses while Firestore's native TTL deletion is eventual. New records carry an `expiresAt` timestamp; `bash ops/configure-firestore-alert-retention.sh` backfills legacy records from `receivedAt`/`replayedAt` before enabling both TTL policies, shortens existing expiries when the configured deadline is earlier, removes legacy raw replay idempotency keys after hashing them, reports scanned/updated/skipped counts, and fails if a record has no usable timestamp. Replay audit documents retain only a SHA-256 `idempotencyKeyHash`, never the raw key. Inspect the TTL policies with `gcloud firestore fields ttls list`.

All endpoints below require the same `x-api-key` header used by the webhook routes.
If alert storage is enabled but Firestore cannot serve the request, they return `503 STORAGE_UNAVAILABLE` instead of a generic `500`. The body carries a sanitized `category` (and `missingIndex: true` for a missing composite index) so a rejected query is distinguishable from a credential/init failure — see the [runbook](troubleshooting.md#stored-alerts-return-503-storage_unavailable). Both fields are optional.

List, summary, and export order by `receivedAt` **and** `FieldPath.documentId()` for deterministic pagination. Firestore sorts `__name__` ascending for free but requires a composite index for the descending direction, so `alerts { receivedAt DESC, __name__ DESC }` must be declared in `firestore.indexes.json` **and** deployed (`pnpm run deploy:firestore:indexes -- --apply`) or those three endpoints answer `503`. Detail reads (`GET /api/alerts/:alertId`) are document gets and need no index, so a `503` there — including for an id that does not exist, which must answer `404` — indicates a client or credential fault rather than the missing index. See the [runbook](troubleshooting.md#stored-alerts-return-503-storage_unavailable).

#### GET /api/alerts

List stored alerts ordered by `receivedAt` descending.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either a legacy ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `source` - Optional source filter. Valid values include `webhook`, `news-monitor`, `market-scanner`, and `expanded-analysis`.
- `enriched` - Optional boolean filter (`true` or `false`)
- `symbol` - Optional symbol filter (e.g. `BTCUSDT`, `BINANCE:BTCUSDT`, `AAPL`). Case-insensitive and matched against extracted symbol and exchange fields. Up to 64 characters.
- `exchange` - Optional exchange filter (e.g. `BINANCE`, `COINBASE`). Case-insensitive and matched against the extracted exchange field. Up to 64 characters.
- `eventCategory` - Optional event category filter (e.g. `price_surge`, `price_decline`, `regulatory`). Case-insensitive and matched against `eventCategory`. Up to 64 characters.
- `include` - Optional projection filter. Allowed value: `enrichment_summary`. When set, each returned alert item includes a sanitized `enrichmentSummary` projection object (with `sentiment`, `sentiment_score`, `setup_type`, `invalidation_level`, `target_level`, `risk_reward_ratio`, `sourceCount`, `sourceDomains`, `tradingViewEnrichmentApplied`, `tradingViewEnrichmentStatus`, and `promptProvenance`) and a sanitized `enrichmentData` payload without requiring N+1 detail fetches.

**Response (200 OK):**
```json
{
  "success": true,
  "alerts": [
    {
      "id": "alert-1",
      "receivedAt": "2026-06-06T12:00:00.000Z",
      "text": "BTC alert",
      "enriched": true,
      "enrichmentData": {
        "sentiment": "bullish"
      },
      "tokenUsage": {
        "totalTokens": 42
      },
      "deliveryResults": [
        {
          "channel": "telegram",
          "success": true
        }
      ],
      "source": "webhook",
      "useTradingViewData": false,
      "tradingViewEnrichmentApplied": false
    }
  ],
  "pagination": {
    "hasMore": false,
    "limit": 50,
    "nextBefore": "eyJ2IjoxLCJyZWNlaXZlZEF0IjoiMjAyNi0wNi0wNlQxMjowMDowMC4wMDBaIiwiaWQiOiJhbGVydC0xIn0"
  }
}
```

#### GET /api/alerts/export

Export bounded stored alerts as JSONL or CSV. CSV serialization prefixes string fields whose leading control characters (`tab`/`LF`/`CR`) are followed by `=`, `+`, `-`, or `@`—or that begin directly with those markers—with an apostrophe so spreadsheet clients treat them as inert text; finite numeric strings such as `-42` remain unchanged. Feature-attributed records include a `feature` column containing comma-separated tags. JSONL output is unchanged.

**Query Parameters:**
- `format` - `jsonl` or `csv` (default: `jsonl`)
- `from` / `to` - Required bounded ISO-8601 timestamps
- `limit` - Integer between `1` and `1000` (default: `500`)
- `source` / `enriched` - Optional filters
- `includeText` - Optional boolean; raw alert text is excluded unless `true`
- `includeEnrichment` - Optional boolean; safe bounded projection of `enrichmentData` is excluded unless `true`

#### GET /api/alerts/summary

Return bounded JSON-only analytics for stored alerts without exposing raw alert text or credentials.

Each enriched alert records only safe prompt provenance (`name`, `source`, `label`, and `version`) when a prompt was resolved. The `enrichment.riskMetadataCoverage` block uses enriched alerts as its denominator and reports populated counts/percentages for `invalidation_level`, `target_level`, `setup_type`, and `risk_reward_ratio`. `byPromptProvenance` groups the same metrics by Langfuse/local provenance; legacy records without provenance use `null`. Missing or invalid optional values remain zero coverage and are never synthesized.

Similarly, `enrichment.evidenceCoverage` tracks whether enriched alerts cited grounding sources, reporting `zeroSources`, `oneToTwoSources`, and `threePlusSources` distribution along with `averageSourceCount`, overall and grouped `byPromptProvenance`.

`enrichment.sentimentCalibration` reports whether the stored `sentiment_score` distribution can still rank alerts. A near-constant score is worse than no score: it cannot separate a strong setup from a weak one, so it cannot be used to tune thresholds or compare signal quality over time. See [Sentiment score calibration](#sentiment-score-calibration) below.

**Query Parameters:**
- `from` - Optional ISO-8601 lower bound; defaults to 24 hours before `to`
- `to` - Optional ISO-8601 upper bound; defaults to request time
- `limit` - Integer between `1` and `1000` (default: `500`)
- `source` - Optional source filter
- `enriched` - Optional boolean filter (`true` or `false`)
- `symbol` - Optional symbol filter (e.g. `BTCUSDT`, `BINANCE:BTCUSDT`, `AAPL`). Case-insensitive and matched against extracted symbol and exchange fields. Up to 64 characters.
- `exchange` - Optional exchange filter (e.g. `BINANCE`, `COINBASE`). Case-insensitive and matched against the extracted exchange field. Up to 64 characters.
- `eventCategory` - Optional event category filter (e.g. `price_surge`, `price_decline`, `regulatory`). Case-insensitive and matched against `eventCategory`. Up to 64 characters.
- `signalClass` - Optional signal class filter; repeatable and comma-separated (e.g. `signalClass=breakout&signalClass=reversal` or `signalClass=breakout,reversal`)
- `interval` - Optional bucket width for the time series: `hour` or `day`. Omit it for the aggregate-only response. See [Time-bucketed series](#time-bucketed-series-interval) below.

The service caps the queried window at 31 days to keep routine operator usage cheap.

The summary also returns `costByFeature` for `grounding`, `news-analysis`, `expanded-analysis`, `scanner`, and `enrichment`. Each bucket includes `alerts`, `batches`, `symbols`, `inputTokens`, `outputTokens`, `totalTokens`, and `totalCost`; the feature costs sum to `enrichment.tokenUsage.totalCost` without double-counting. Older records without feature tags are attributed conservatively from their stored source.

`totalCost` values are **estimates** derived from published list prices in `src/lib/tokenUsage.js` (`PRICING_PER_1M`), not provider invoices. Model names are normalized before lookup (provider prefixes such as `openai/` or `azure/` and revision suffixes are stripped, family heuristics fill gaps, and models marked `:free` or `/free` cost 0). A model that matches no known entry is priced at the documented default rate rather than 0, so an unpriced model is never reported as free. `alerts` counts stored documents, `batches` counts distinct news-monitor requests (grouped by `requestId`/`batchId`, not per document), and `symbols` counts distinct symbols across a batch — a multi-symbol expanded-analysis or scanner report contributes all of its symbols even though it is stored as one document.

An alert that persisted no real token usage is not attributed to any feature. Plain webhook alerts always store a `tokenUsage` object, but when grounding and TradingView enrichment are both disabled it is all-zero, so it contributes nothing to any bucket and carries no `feature` tag in CSV exports.

**Response (200 OK):**
```json
{
  "success": true,
  "summary": {
    "window": {
      "from": "2026-06-06T00:00:00.000Z",
      "to": "2026-06-07T00:00:00.000Z",
      "limit": 500,
      "maxDays": 31
    },
    "totalAlerts": 2,
    "bySource": {
      "webhook": 2
    },
    "bySymbol": {
      "BTCUSDT": 1,
      "ETHUSDT": 1
    },
    "byFeatureFlag": {
      "enriched": 1,
      "plain": 1,
      "tradingViewData": 1,
      "tradingViewDataApplied": 1,
      "withoutTradingViewData": 1
    },
    "enrichment": {
      "enrichedAlerts": 1,
      "plainAlerts": 1,
      "tradingViewStatusCounts": {
        "full": 0,
        "partial": 0,
        "failed": 0,
        "not_applicable": 1,
        "unrecorded": 1
      },
      "riskMetadataCoverage": {
        "denominator": 1,
        "fields": {
          "invalidation_level": { "populated": 0, "percentage": 0 },
          "target_level": { "populated": 0, "percentage": 0 },
          "setup_type": { "populated": 0, "percentage": 0 },
          "risk_reward_ratio": { "populated": 0, "percentage": 0 }
        },
        "byPromptProvenance": [
          {
            "provenance": null,
            "denominator": 1,
            "fields": {
              "invalidation_level": { "populated": 0, "percentage": 0 },
              "target_level": { "populated": 0, "percentage": 0 },
              "setup_type": { "populated": 0, "percentage": 0 },
              "risk_reward_ratio": { "populated": 0, "percentage": 0 }
            }
          }
        ]
      },
      "evidenceCoverage": {
        "denominator": 1,
        "zeroSources": { "populated": 1, "percentage": 100 },
        "oneToTwoSources": { "populated": 0, "percentage": 0 },
        "threePlusSources": { "populated": 0, "percentage": 0 },
        "totalSourceCount": 0,
        "averageSourceCount": 0,
        "byPromptProvenance": [
          {
            "provenance": null,
            "denominator": 1,
            "zeroSources": { "populated": 1, "percentage": 100 },
            "oneToTwoSources": { "populated": 0, "percentage": 0 },
            "threePlusSources": { "populated": 0, "percentage": 0 },
            "totalSourceCount": 0,
            "averageSourceCount": 0
          }
        ]
      },
      "sentimentCalibration": {
        "sampleCount": 1,
        "evaluated": false,
        "saturated": false,
        "reason": "insufficient_sample",
        "min": 0.55,
        "max": 0.55,
        "p10": 0.55,
        "p50": 0.55,
        "p90": 0.55,
        "spread": 0,
        "distinctValueCount": 1,
        "bucketCount": 1,
        "buckets": [
          { "lowerBound": 0.5, "upperBound": 0.6, "count": 1 }
        ],
        "topBandCount": 0,
        "topBandShare": 0,
        "rawScoreCapCount": 1
      },
      "tokenUsage": {
        "inputTokens": 10,
        "outputTokens": 20,
        "totalTokens": 30,
        "totalCost": 0.001
      }
    },
    "delivery": {
      "totalSuccess": 2,
      "totalFailure": 1,
      "byChannel": {
        "telegram": {
          "total": 2,
          "success": 1,
          "failure": 1
        },
        "whatsapp": {
          "total": 1,
          "success": 1,
          "failure": 0
        }
      }
    },
    "latency": {
      "averageProcessingMs": 250,
      "averageDeliveryMs": 150,
      "byChannel": {
        "telegram": {
          "averageMs": 170,
          "p95Ms": 200,
          "sampleCount": 2
        },
        "whatsapp": {
          "averageMs": 110,
          "p95Ms": 110,
          "sampleCount": 1
        }
      }
    },
    "feedback": {
      "total": 4,
      "up": 3,
      "down": 1,
      "ratio": 0.75,
      "bySource": { "webhook-alert": 3, "scanner": 1 },
      "bySymbol": { "BTCUSDT": 3, "ETHUSDT": 1 },
      "byExchange": { "BINANCE": 4 },
      "source": "firestore",
      "window": {
        "from": "2026-06-06T00:00:00.000Z",
        "to": "2026-06-07T00:00:00.000Z",
        "limit": 500
      }
    }
  }
}
```

For rollout validation, first verify the active prompt provenance and coverage in preview, then observe a bounded production/shadow window after aligning the remote `alert-enrichment` prompt with the local optional-risk schema. Treat missing fields as unavailable data; do not use zero coverage as a trading outcome or fabricate stops, targets, setup types, or R:R values.

The `feedback` block is always included regardless of the report filters so traders can correlate prompt calibration with raw trader outcomes. Counts are sourced from the `alertFeedback` collection (when `ENABLE_FIRESTORE_ALERT_FEEDBACK=true`) or the in-process memory surface; only SHA-256 chat hashes are persisted and raw chat ids are never returned.

#### Time-bucketed series (interval)

The aggregate response has no time axis, so a console cannot chart alert volume or delivery success over time. Client-side bucketing is not a workaround: `limit` bounds the sample, so a page of alerts is not the population.

Supply the optional `interval` parameter to add `summary.buckets`, a time-bucketed series over the requested window. **Omitting `interval` leaves the response byte-for-byte unchanged** — same keys, same order, same values — so existing consumers are unaffected.

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" \
  "$BASE_URL/api/alerts/summary?from=2026-06-06T00:00:00.000Z&to=2026-06-06T03:00:00.000Z&interval=hour"
```

| Behaviour | Detail |
| :--- | :--- |
| `interval` values | `hour` or `day`. Case-insensitive. |
| Window cap | `hour` → 31 days, `day` → 366 days. A wider window returns `400`. |
| Bucket alignment | UTC hours (`hour`) or UTC midnights (`day`). |
| Ordering | Ascending by `bucketStart`, starting at the aligned start of the window and running through `to`. |
| Empty buckets | Present with zero counts, never omitted, so a chart has no gaps and the array length is predictable for a given window and interval. |
| Filters | Every existing filter (`source`, `enriched`, `symbol`, `eventCategory`, `exchange`, `signalClass`, `from`/`to`/`limit`) narrows the buckets exactly as it narrows the totals. |
| Reads | The series is derived from the same bounded Firestore cursor scan as the aggregates. No unbounded collection read was introduced. |

Each bucket is `{ bucketStart, total, success, failure, byChannel }`:

```json
{
  "success": true,
  "summary": {
    "window": {
      "from": "2026-06-06T00:00:00.000Z",
      "to": "2026-06-06T03:00:00.000Z",
      "limit": 500,
      "maxDays": 31,
      "interval": "hour"
    },
    "buckets": [
      {
        "bucketStart": "2026-06-06T00:00:00.000Z",
        "total": 1,
        "success": 1,
        "failure": 0,
        "byChannel": { "telegram": { "total": 1, "success": 1, "failure": 0 } }
      },
      {
        "bucketStart": "2026-06-06T01:00:00.000Z",
        "total": 0,
        "success": 0,
        "failure": 0,
        "byChannel": {}
      }
    ],
    "totalAlerts": 1
  }
}
```

Two invariants a consumer can rely on:

- **`sum(bucket.total) === totalAlerts`.** The series and the aggregates are computed from the same bounded sample, so they cannot disagree. `bucket.total` counts *alerts*, not deliveries, so an alert with no recorded `deliveryResults` still increments it.
- **`bucket.success` / `bucket.failure` equal the sums of that bucket's `byChannel[*]` counts.** A delivery result with no usable channel name is counted under `unknown`.

`window.interval` and the interval-specific `window.maxDays` are reported only when `interval` is supplied.

**Validation failures are never silent.** An empty, unrecognised, or over-cap `interval` returns `400` rather than falling back to the aggregate-only response — a silent fallback is how a flag ends up reporting itself enabled while resolving to something else. Interval failures use the shared error envelope from `src/lib/errorEnvelope.js` (`success`, `error`, `code`, `requestId`, `retryable`); the endpoint's pre-existing timestamp and filter failures keep their original `{ error, code }` body.

Note the difference in window handling: with `interval` set, an over-cap window is **rejected**; with `interval` omitted, a window wider than 31 days is still **silently narrowed** to 31 days, as it always has been.

The `adminRead` guard and rate limiting are unchanged; this is an operator read surface and neither was weakened to make the aggregation cheaper.

`GET /api/outcomes/summary` has the same gap (aggregates with no time axis) and is tracked separately; this change is limited to the alerts summary.

#### Sentiment score calibration

The `alert-enrichment` prompt scores `sentiment_score` against five fixed reference anchors and must justify its choice in `sentiment_score_evidence`:

| abs score | anchor | means |
| --- | --- | --- |
| 0.90 | multi-source major catalyst | Two or more independent reputable outlets plus a regulatory/filing/earnings catalyst, with aligned technicals |
| 0.75 | corroborated | One reputable primary report plus confirming technical structure |
| 0.60 | partial | Mixed evidence, or a single low-relevance source |
| 0.45 | routine | A routine, largely anticipated event |
| 0.30 | negligible | Evidence absent, stale, or contradictory |

Without a reference point the model emitted whatever magnitude "felt" right, and production ended up with 87.6% of enriched scores at or above 0.75 — a channel that cannot tell a high-conviction breakout from a routine entry. `sentiment_score_evidence` records which anchor was chosen and the observation behind it, so an individual score can be audited.

`enrichment.sentimentCalibration` measures whether the window is saturated again. Scores are read as **absolute magnitudes** (a BEARISH `-0.9` contributes `0.9`), and only enriched alerts that stored a usable score count toward `sampleCount`.

Two independent rules are applied, because the reported production failure is not caught by a spread rule alone:

- `spread_collapse` — `p90 - p10` fell below the spread floor. This is the "everything reads 0.8" signature.
- `top_band_concentration` — at least 75% of samples sit at or above `0.75`. For the reported distribution `p90 - p10` was `0.15`, comfortably **above** a `0.1` floor, so a spread-only guard would have stayed silent on the exact incident this was written for.

`insufficient_sample` and `no_samples` mean no verdict was declared. That is deliberate: a cold window, or one that has just been widened by a long query, is never reported as saturated.

`distinctValueCount` and `bucketCount` are diagnostics, **not** triggers. Anchoring the prompt to score bands intentionally concentrates output onto band centres, so a low distinct-value count measures anchor adherence rather than calibration failure.

`rawScoreCapCount` counts alerts in the window that also stored `sentiment_score_raw`, meaning the zero-source cap rewrote their score (see [AI Grounding & Prompts](ai-grounding.md#zero-source-sentiment-cap)). A non-zero value proves the cap is live in the deployment you are querying; zero means either no capped alerts in the window or a build that predates the cap.

**Rollout validation.** Align the remote Langfuse `alert-enrichment` prompt with the local anchors first. Until it is republished, `promptProvenance.schemaDriftDetected` is `true` and `missingCalibrationGuidance` names the missing markers — that flag is the intended signal, not a failure. After cutover, sample two weeks and confirm `saturated` is `false` and `bucketCount` is at least 4. Do not gate any trading decision on `sentiment_score` until that observation window closes: `NEWS_ALERT_THRESHOLD` (`0.7`) consumes news confidence, not this field, but a prompt change still shifts the score population that any future threshold would be tuned against.

A process-local rolling window in `src/services/grounding/gemini.js` emits one structured `console.warn` per hour when it saturates, plus a recovery line on the state change. It is a fast early warning only: state is lost on restart, so it stays silent until it holds enough fresh observations. `enrichment.sentimentCalibration` is the durable view.

#### POST /api/alerts/feedback

Persist a trader verdict (👍 / 👎) for a stored alert. Re-clicks with the same `(alertId, chatId)` tuple update the verdict instead of appending a new row. Bounded by `ALERT_FEEDBACK_RETENTION_DAYS` (default: `90`, range `1`-`3650`). Requires `admin.operator` and the shared idempotency middleware (the `idempotency-key` header is recommended).

**Request Body:**
```json
{
  "alertId": "alert-123",
  "chatId": "120363422033474991@g.us",
  "verdict": "up",
  "symbol": "BTCUSDT",
  "exchange": "BINANCE",
  "source": "webhook-alert"
}
```

`verdict` must be exactly `"up"` or `"down"`. `source` is optional and is one of `webhook-alert`, `expanded-analysis`, `scanner`, `news`, or `unknown` (default). `symbol`/`exchange` are uppercased and used only for the per-symbol/per-exchange aggregates in the summary endpoint.

**Response (200 OK):**
```json
{
  "success": true,
  "persisted": true,
  "source": "firestore",
  "alertId": "alert-123",
  "verdict": "up"
}
```

`source` reports `firestore` when `ENABLE_FIRESTORE_ALERT_FEEDBACK=true` and the write succeeded; it reports `memory` when Firestore is disabled or unavailable (fail-open). The endpoint is fail-open in every path: any Firestore outage falls back to a process-local in-memory map that is bounded by the configured retention window and is cleared on process restart.

#### GET /api/alerts/feedback/summary

Aggregate trader verdicts within a bounded time window. Requires `admin.viewer`. Raw chat ids are never returned — only the SHA-256 chat hashes persisted on the alertFeedback documents are aggregated into the per-source/per-symbol/per-exchange counts.

**Query Parameters:**
- `from` - Optional ISO-8601 lower bound; defaults to 7 days before `to`
- `to` - Optional ISO-8601 upper bound; defaults to request time
- `limit` - Integer between `1` and `1000` (default: `500`)

**Response (200 OK):**
```json
{
  "success": true,
  "feedback": {
    "total": 4,
    "up": 3,
    "down": 1,
    "ratio": 0.75,
    "bySource": { "webhook-alert": 3, "scanner": 1 },
    "bySymbol": { "BTCUSDT": 3, "ETHUSDT": 1 },
    "byExchange": { "BINANCE": 4 },
    "source": "firestore",
    "window": {
      "from": "2026-06-06T00:00:00.000Z",
      "to": "2026-06-13T00:00:00.000Z",
      "limit": 500
    }
  }
}
```

#### POST /api/alerts/:alertId/replay

Replay a stored alert through the configured notification channels. The endpoint requires an idempotency key (`idempotency-key`/`x-idempotency-key` header or `idempotencyKey` body/query field) and an `ENABLE_FIRESTORE_ALERT_STORAGE=true` gate. Successful replays persist a `alertReplays` audit document with a SHA-256 hash of the key.

**Dry-run mode:** add `dryRun: true` to the body (or `?dryRun=true` to the URL) to fetch the stored alert and build the would-be payload, then return it without dispatching to any channel and without persisting a replay attempt. Use this to preview the text, enrichment data, and per-channel routing (resolving channel service defaults and `TELEGRAM_TOPIC_ROUTES` when the stored alert lacks explicit overrides) before triggering a real replay. The dry-run response returns the 12-character SHA-256 hash prefix `idempotencyKeyHashPrefix` without leaking the raw key into upstream caches (the live endpoint never returns it).

**Re-enrichment (`reEnrich`):** add `reEnrich: true` to the body to re-run the full enrichment
pipeline (Gemini grounding and TradingView MCP data) on the stored alert before dispatching.
Defaults to `false`, in which case the stored alert text is dispatched with its original enrichment
data. When re-enrichment succeeds the replay dispatches the refreshed payload and the persisted
`alertReplays` audit document records `reEnriched: true` together with the sanitized
`enrichmentData`. If both `ENABLE_GEMINI_GROUNDING=false` and
`ENABLE_TRADINGVIEW_MCP_ENRICHMENT=false`, the flag is safely ignored and the standard replay path runs.

**Request body:**
```json
{
  "channels": ["telegram", "whatsapp"],
  "dryRun": true
}
```

**Response (200 OK - dry-run):**
```json
{
  "success": true,
  "dryRun": true,
  "alertId": "alert-123",
  "channels": ["telegram"],
  "idempotencyKeyHashPrefix": "06bdeddf2a29",
  "payloadPreview": {
    "text": "BINANCE:ETHUSDT(240) pasó a señal de COMPRA",
    "enriched": { "sentiment": "BULLISH", "sentiment_score": 0.62 },
    "channelRouting": {
      "telegramChatId": "111",
      "telegramThreadId": 7,
      "whatsappChatId": "222"
    }
  }
}
```

**Response (200 OK - live replay):**
```json
{
  "success": true,
  "alertId": "alert-123",
  "replayId": "1700000000000_<uuid>",
  "results": [
    { "channel": "telegram", "success": true, "messageId": "tg-1" }
  ]
}
```

The same `403 FEATURE_DISABLED` (when `ENABLE_FIRESTORE_ALERT_STORAGE=false`), `503 STORAGE_UNAVAILABLE`, and `400 INVALID_REQUEST` mapping as the sibling endpoints applies. A reused idempotency key with a different request fingerprint returns `409 IDEMPOTENCY_CONFLICT`.
#### GET /api/alerts/replays

List bounded alert-replay audit records from the Firestore `alertReplays` collection, ordered by `replayedAt` descending. Each `POST /api/alerts/{alertId}/replay` writes a unique audit document so retries with the same idempotency key are preserved as history instead of overwriting prior attempts; the HTTP `Idempotency-Replay` contract remains upstream of storage. Raw idempotency keys are never stored or returned — only a SHA-256 hash prefix is exposed.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either a legacy ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `alertId` - Optional stored alert id to scope replays to a single document

**Response (200 OK):**
```json
{
  "success": true,
  "replays": [
    {
      "id": "1700000000000_<uuid>",
      "alertId": "alert-1",
      "idempotencyKeyHashPrefix": "06bdeddf2a29",
      "attemptId": "1700000000000_<uuid>",
      "channels": ["telegram"],
      "deliverySummary": [
        { "channel": "telegram", "success": true, "messageId": "tg-1" }
      ],
      "replayedAt": "2026-06-06T12:34:56.000Z"
    }
  ],
  "pagination": {
    "hasMore": false,
    "limit": 50,
    "nextBefore": null
  }
}
```

The same `403 FEATURE_DISABLED` (when `ENABLE_FIRESTORE_ALERT_STORAGE=false`) and `503 STORAGE_UNAVAILABLE` mapping as the sibling endpoints applies.

#### GET /api/alerts/:alertId

Retrieve a single stored alert by Firestore document ID. The response also surfaces `lastReplay` — the most recent `alertReplays` entry for the alert, or `null` if none has been recorded.

**Response (200 OK):**
```json
{
  "success": true,
  "alert": {
    "id": "alert-123",
    "receivedAt": "2026-06-06T10:30:00.000Z",
    "text": "Stored alert",
    "enriched": false,
    "enrichmentData": null,
    "tokenUsage": null,
    "deliveryResults": [],
    "source": "webhook",
    "useTradingViewData": true,
    "tradingViewEnrichmentApplied": false
  },
  "lastReplay": {
    "id": "1700000000000_<uuid>",
    "alertId": "alert-123",
    "idempotencyKeyHashPrefix": "06bdeddf2a29",
    "attemptId": "1700000000000_<uuid>",
    "channels": ["telegram"],
    "deliverySummary": [
      { "channel": "telegram", "success": true, "messageId": "tg-1" }
    ],
    "replayedAt": "2026-06-06T12:34:56.000Z"
  }
}
```

**Response (200 OK - Completed):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "type": "expanded-analysis",
  "status": "completed",
  "progress": {
    "total": 1,
    "current": 1,
    "status": "Completed analysis"
  },
  "results": [
    {
      "symbol": "BINANCE:BTCUSDT",
      "status": "analyzed",
      "price": 65430,
      "rsi": 43.5
    }
  ],
  "alertText": "📊 *ANÁLISIS AMPLIADO — Monday 25/05/2026*...",
  "deliveryResults": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "987654"
    }
  ],
  "summary": {
    "total": 1,
    "analyzed": 1,
    "error": 0,
    "delivered": 1
  },
  "createdAt": "2026-05-25T01:30:00.000Z",
  "updatedAt": "2026-05-25T01:30:12.000Z",
  "totalDurationMs": 12053
}
```
