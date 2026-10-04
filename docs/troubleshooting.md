# Troubleshooting Guide

[← Back to README](../README.md)

## Troubleshooting

### News Monitoring Issues

#### News Monitor Endpoint Not Responding

1. Verify `ENABLE_NEWS_MONITOR=true` in environment
2. Verify `GEMINI_API_KEY` is set (required for Gemini analysis)
3. Check application logs for `[NewsMonitor] Handler initialized` when news monitoring is enabled
4. Verify `/api/news-monitor` route is registered (check logs for route mounting)

#### News Alerts Not Sending

1. Verify `NEWS_ALERT_THRESHOLD` setting (default: 0.7). Confidence scores below threshold will be filtered
2. Check `NEWS_TIMEOUT_MS` is not too aggressive (default: 30000 ms is reasonable)
3. Verify notification channels (Telegram, WhatsApp) are properly configured
4. Check application logs for per-symbol analysis status and confidence scores
5. Test with explicit GET request: `GET /api/news-monitor?crypto=BTCUSDT`

#### Duplicate Alerts (Cache Not Working)

1. Verify `NEWS_CACHE_TTL_HOURS` is set (default: 6 hours). Set to 0 for no caching
2. Check application logs for "Cache hit" messages
3. Verify symbols and event categories match between requests (cache key is `(symbol, event_category)`)
4. Different event categories will NOT be deduplicated (e.g., "price_surge" + "regulatory" = 2 alerts)

#### Binance Price Not Being Fetched

1. Verify `ENABLE_BINANCE_PRICE_CHECK=true`
2. Verify symbol format is correct for Binance (e.g., `BTCUSDT` not `BTC`)
3. Check that crypto symbols are placed in `crypto` array (not `stocks`)
4. If Binance fails, system automatically falls back to Gemini GoogleSearch
5. Verify Binance API is accessible: `curl https://api.binance.com/api/v3/avgPrice?symbol=BTCUSDT`

**Symbol Classification**: The system trusts that you've correctly classified symbols into `crypto` and `stocks` arrays. If a symbol is misclassified (e.g., "NVDA" in the `crypto` array), Binance will return an error like `Invalid symbol: NVDA`. In this case:
- Verify the symbol exists on Binance: `https://api.binance.com/api/v3/avgPrice?symbol=NVDA` (will fail)
- Move stock symbols to the `stocks` array
- Use Binance symbol format (e.g., BTCUSDT for Bitcoin, not BTC)
- System will fall back to Gemini GoogleSearch if symbol is not found on Binance

#### Secondary LLM Enrichment Not Working

1. Verify `ENABLE_LLM_ALERT_ENRICHMENT=true`
2. Verify Azure AI Inference credentials: `AZURE_LLM_ENDPOINT`, `AZURE_LLM_KEY`, `AZURE_LLM_MODEL`
3. Check application logs for enrichment errors (will fall back to Gemini if unavailable)
4. Verify enrichment timeout is not exceeded (default: 10s per symbol)
5. If enrichment fails, alert is still sent using Gemini confidence (graceful degradation)

#### High Response Latency

1. Check `NEWS_TIMEOUT_MS` setting (each symbol waits up to this timeout)
2. Multiple symbols with timeouts = longer overall response. Per-symbol timeout: 30s. For 10 symbols, max wait: ~30s.
3. Enable only symbols that are actively traded (unused symbols slow down requests)
4. Reduce `NEWS_CACHE_TTL_HOURS` to refresh data more frequently (trades off cache hits vs. freshness)
5. Monitor external API latencies (Gemini, Binance) in application logs

### WhatsApp Alerts Not Sending

1. Verify `ENABLE_WHATSAPP_ALERTS=true`
2. Check `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID` are set
3. Test WhatsApp API connection: `curl -X POST https://api.green-api.com/...`
4. Check application logs for detailed error messages

### Telegram Alerts Not Sending

1. Verify `BOT_TOKEN` is correct (from BotFather)
2. Verify `TELEGRAM_CHAT_ID` is correct (use `/start` to find)
3. Ensure bot has permission to send messages to the chat
4. Check Telegram API status

### URL Shortening

**URLs not being shortened**:
1. Verify `URL_SHORTENER_SERVICE` is set to `picsee`, `tinyurl`, or `cuttly`
2. Check that alert text contains valid HTTP/HTTPS URLs
3. Verify `PICSEE_API_KEY` or `CUTTLY_API_KEY` is set when the selected service requires it
4. Check application logs for "URLShortener" error messages

**Shortening timeout errors**:
- Default timeout: 5 seconds per URL batch
- If the selected provider is slow, increase timeout or reduce parallel URLs
- URLs gracefully fallback to original if shortening fails
- Alert still sends with original URLs

**Cache issues**:
- URL shortening cache is session-scoped (clears after request)
- Same URL requested multiple times in quick succession uses cache
- To clear cache manually, restart the application

**WhatsApp message still too long**:
- Shortening reduces URL length, not entire message
- If full alert text > 20,000 chars, it is automatically split into sequential chunks and delivered in parts
- Reduce alert detail or enable Gemini enrichment to summarize

### Retry Logic

- Failed alerts automatically retry per channel (WhatsApp up to 3 attempts with 1s → 2s → 4s exponential backoff per chunk; Telegram and Discord for 429 rate limits up to their configured retry limits)
- ±10% jitter prevents thundering herd on exponential backoff
- All retries logged at WARN/ERROR level

### Stored Alerts Return 503 STORAGE_UNAVAILABLE

Symptom: `GET /api/alerts`, `/api/alerts/summary`, `/api/alerts/export`, and replay all answer `503`, while `/api/status` reports Firestore as healthy and `firestoreWriteMetrics` shows a perfect success rate. That combination means **the write path works and the read queries are being rejected** — it is not a credentials problem, despite what older response text suggested.

1. **Read the `category` on the 503 body.** It is a closed, sanitized enum and is the fastest discriminator:

   | `category` | What it means | Fix |
   | :--- | :--- | :--- |
   | `failed_precondition` (+ `missingIndex: true`) | Firestore refused the *query* because no index backs it | Deploy the declared composite indexes (see below) |
   | `uninitialized` | The Firestore client never built | Check `FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS` and `FIREBASE_PROJECT_ID` |
   | `permission_denied` | IAM or `firestore.rules` rejected the call | Check the service account's roles and the rules file |
   | `unauthenticated` | Credentials missing, expired, or revoked | Rotate the service-account key |
   | `unavailable` / `deadline_exceeded` | Backend unreachable | Usually transient; retry |
   | `resource_exhausted` | Quota or rate limit | Back off, then check quotas |

2. **Check `dependencies.firestore.readHealth` on `/api/status`.** `degraded` forces `ready: false` and `status: "degraded"`, which is the authoritative signal that the read path — not the credentials — is broken. `unknown` means no read has been attempted yet, which is *not* evidence of health.

3. **Missing composite index (the usual cause).** Stored-alert reads order by `receivedAt` **and** `FieldPath.documentId()` so pagination has a deterministic tie-breaker. Firestore applies a free final `__name__` **ascending** sort, so ordering `__name__` **descending** requires the composite index `alerts { receivedAt DESC, __name__ DESC }` declared in `firestore.indexes.json`. Adding the declaration to the file does **not** create it in the live project — audit and deploy it with the repo helper, which is dry-run by default:

   ```bash
   pnpm run deploy:firestore:indexes                 # audit only, exits 1 if not ready
   pnpm run deploy:firestore:indexes -- --apply      # deploy, then wait for READY
   ```

   Composite indexes build asynchronously and a query is rejected until the build reaches `READY`, so the helper polls the Firestore REST API for each index's build state and exits non-zero until every declared index is `READY`. Do **not** confirm with `firebase firestore:indexes`: that command routes its output through `makeIndexSpec()`, which projects each index down to its field list and **drops `state`**, so it cannot distinguish `READY` from `BUILDING` — which is precisely how a completed deploy leaves every read returning `503`.

   Read the exit code precisely: **0** = every declared index `READY`, **1** = at least one missing or still building (this is the actionable state), **2** = the listing could not be read authoritatively — unauthenticated, a truncated page, or an unreadable template. Exit 2 is *not* "the indexes are missing"; it means the tool refuses to guess, so fix auth and re-run rather than creating indexes.

4. **`GET /api/alerts/:alertId` does not need an index — so a `503` there is a different fault.** A detail read is a document get by id, which requires no composite index. If it answers `503`, the cause is **not** the missing-index fault above: read the `category` on the body and act on it (`uninitialized` / `unauthenticated` / `permission_denied` mean the client or its credentials are the problem; `unavailable` / `deadline_exceeded` is usually transient). Note that `GET /api/alerts/zzz-not-real` must answer `404`, never `503` — if it answers `503` the failure happens before any document lookup, so the client itself is unusable. Deploying indexes will not fix that case.

5. **Confirm the read path with `/ready`.** `GET /ready?depth=dependencies` executes the same indexed read (bounded to one document) and fails closed with `503` while it is broken, so it can be used as an external alert signal. `GET /api/alerts/summary` and `GET /api/alerts` reproduce the fault directly.

6. **Do not chase credentials for a `failed_precondition`.** If `firestoreWriteMetrics` shows writes succeeding, the credential is demonstrably valid; the rejection is per-query.

> The provider's own message (which contains the project/database path and the index definition) is written to the log only and is never returned in a response body or a status payload. Grep the logs for `[AlertStorageService]` with the `category` to find the exact provider detail.