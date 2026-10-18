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

### Firestore Reads Return 503 STORAGE_UNAVAILABLE

Firestore reads and writes exercise different operations. Successful writes or a healthy aggregate status do not identify why a particular read failed. Start with the sanitized `category` in the 503 response and the corresponding `[AlertStorageService]` log entry; the provider's raw message is kept out of responses.

| `category` | What it indicates | Next step |
| :--- | :--- | :--- |
| `failed_precondition` with `missingIndex: true` | Firestore rejected a query because it needs an index | Identify the failing query and audit the declared indexes below |
| `uninitialized` | The Firestore client could not be constructed | Check credential source and project configuration |
| `permission_denied` | Firestore denied the configured service account | Check the account's IAM permissions |
| `unauthenticated` | Firestore rejected credentials at call time | Check credential validity and runtime identity |
| `unavailable` / `deadline_exceeded` | The backend could not complete the request | Check provider reachability and retry behavior |
| `resource_exhausted` | A quota or concurrency limit was reached | Check quotas and back off |
| `not_found`, `invalid_argument`, `aborted`, `internal`, `unknown_error` | A different operation or provider failure | Use the category and service logs to investigate; do not infer an index problem |

`dependencies.firestore.readHealth` on `/api/status` is an aggregate signal: `degraded` means a tracked Firestore read failed, while `unknown` is not evidence of health. It does not identify which operation failed. A `GET /api/alerts/:alertId` request is a document lookup and does not need a composite index; if even a nonexistent id returns `503` instead of `404`, deploying indexes will not fix that failure.

For a confirmed missing-index error, use the repository helper. It audits every declared composite index against Firestore REST state; `--apply` deploys the default database indexes and waits for `READY`:

```bash
pnpm run deploy:firestore:indexes                 # audit only
pnpm run deploy:firestore:indexes -- --apply      # deploy, then wait for READY
```

The audit exits `0` when all declared indexes are `READY`, `1` when an index is missing or still building, and `2` when it cannot read the full index listing authoritatively. Exit `2` is an operational or authentication error, not proof that indexes are missing. The helper checks REST build state; `firebase firestore:indexes` lists index definitions but does not expose that state. Composite builds are asynchronous, so do not treat a successful deploy command alone as proof of readiness.

The stored-alert list's `receivedAt DESC` plus document-id tie-breaker is served by Firestore's automatic single-field index; it does not require an `alerts` composite. Signal-outcome calibration recovery uses two declared composites on `tradingSignalOutcomes`: `source ASC, receivedAt DESC` and `source ASC, confidenceScoreOrigin ASC, receivedAt DESC`. Use the helper to audit or deploy them before relying on the calibration query. See [Signal Outcomes](signal-outcomes.md#get-apioutcomescalibration).

The audit needs `datastore.databases.get` and `datastore.indexes.list`; `--apply` also needs Firebase CLI index-deployment permissions. Deployment and REST auditing use the same Application Default Credentials from `FIREBASE_SERVICE_ACCOUNT_JSON`, `GOOGLE_APPLICATION_CREDENTIALS`, or the runtime ADC provider. `--apply` targets the default database and the indexes selected by `firebase.json`; custom `--database` and `--indexes` values are dry-run only. The CLI subprocess is bounded to 10 minutes. The helper exits `2` for a timed-out deploy or repeated pagination token because it cannot claim an authoritative result.

### Configured Firebase Credentials Rejected at Startup

Symptom: after a credential change, durable features (alert storage, idempotency, news dedup, chat preferences) silently serve from memory. Alerts still deliver and requests still succeed, but nothing is persisted and restarts lose state. One warning per affected service names the problem:

```
[AlertStorageService] Firebase credentials are configured but invalid (FIREBASE_CREDENTIALS_INVALID_JSON); skipping Firestore and using in-memory fallback.
```

This is deliberate fail-fast behavior (issue #1128). When a credential source **is** configured but fails validation, the service does not call `admin.initializeApp({})`. Initializing with empty options would drop the process into the Firebase SDK's default-auth discovery path, where the first read or write pays for authentication and network round-trips and then fails — instead of rejecting the misconfiguration at startup.

| `code` | Meaning | Fix |
| :--- | :--- | :--- |
| `FIREBASE_CREDENTIALS_INVALID_JSON` | `FIREBASE_SERVICE_ACCOUNT_JSON` is not valid JSON | Re-export the service-account JSON; it must be a single-line JSON object |
| `FIREBASE_CREDENTIALS_MISSING_FIELDS` | `project_id`, `private_key`, or `client_email` absent | Include all three fields (camelCase aliases are accepted) |
| `FIREBASE_CREDENTIALS_INVALID_KEY` | `private_key` is not a valid PEM key | Check that the value kept its literal `\n` escapes |
| `FIREBASE_CREDENTIALS_UNREADABLE_FILE` | `GOOGLE_APPLICATION_CREDENTIALS` is not a readable regular file | Verify the path exists inside the container and the process can read it |
| `FIREBASE_CREDENTIALS_UNSUPPORTED_TYPE` | Inline `FIREBASE_SERVICE_ACCOUNT_JSON` holds an `authorized_user` / `external_account` document | Store the credentials in a file and point `GOOGLE_APPLICATION_CREDENTIALS` at it, or provide a service-account JSON inline |
| `FIREBASE_CREDENTIALS_LOAD_FAILED` | The credential parsed but the SDK rejected the document | Usually a truncated or re-encoded key; re-download the service-account JSON |

Distinguish this from an unconfigured deployment: with **no** credential source at all the behavior is unchanged and intentional — the app still calls `initializeApp({})` so Application Default Credentials (managed runtimes, the well-known `gcloud` file) keep working. The shared helper reports that case as `unconfigured`, not `invalid`.

`isFirestoreConfigured()` in `src/services/storage/firestoreConfig.js` is the independent credential-*shape* check behind `dependencies.firestore.configured` on `/api/status`. A deployment can report `configured: true` and still fail here, because it validates shape rather than proving the SDK can use the document.

No endpoint, environment variable, or Remote Config key changed with this behavior; it is a startup-time fail-fast guard on the existing fail-open paths.
