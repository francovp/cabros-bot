# Cabros Bot Operator Runbook

> **Audience:** On-call operators triaging production pages at 02:00.
> **How to use:** Find the page you received, jump to the matching section, follow the *First check* and *Mitigation* steps, then verify with the listed command.
> **Source of truth:** This file is updated whenever a new paging surface ships. PRs that touch paging code must update the matching section in the same change.
> **Companion documents:** [README.md](./README.md) for setup, [AGENTS.md](./AGENTS.md) for architecture, [docs/incidents/](./docs/incidents/) for postmortems.

---

## Before paging — decision tree

When a page lands in `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` or surfaces in Sentry, work this decision tree **before** paging a human:

1. Is the failure class one of the 12 sections below? → Jump to that section.
2. Is the page a duplicate of a recent page? → Check the dedupe cooldown; do not re-page.
3. Is the service in a known-deploy window (e.g. `RENDER_DEPLOY_HOOK` is firing)? → Wait 90s and re-check `/api/status`.
4. Is the failure self-recovering within 30s? → Log and move on; auto-recovery is intentional.
5. Only escalate to a human after the *Mitigation* step fails or the *First check* shows a confirmed outage.

---

## 1. Gemini 429 burst

**Symptoms** — Sentry tag `provider: "google-ai-studio"` with `provider_status_code: 429`, `/api/status > dependencies.newsMonitor.geminiQuota.cooldownUntil` is set in the future, news-monitor page quoting `quota_exhausted`.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.newsMonitor.geminiQuota, .dependencies.geminiQuota'
```

If `cooldownActive: true`, the manager is already gating. If `quotaExhausted: true`, the cooldown will last the remaining minutes in `cooldownRemainingMs / 60000`.

**Mitigation (≤5 min)** —

1. Verify `NEWS_GEMINI_CONCURRENCY=3` is set in production; if a deploy regressed to legacy fan-out, set the env var and redeploy.
2. If 429s persist > 10 min, temporarily raise `NEWS_GEMINI_QUOTA_MAX_RETRIES` (default `2`) and `NEWS_GEMINI_QUOTA_RETRY_BASE_MS` (default `1000`) in the remote config to spread load.
3. As a last resort, set `ENABLE_NEWS_MONITOR=false` to stop analysis until the daily quota resets (UTC midnight).

**Verification** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/news-monitor?dryRun=true" \
  | jq '.summary.quota_exhausted, .summary.error_count'
```

`quota_exhausted: 0` and `error_count: 0` confirm the burst is over.

**Postmortem prompt** — Were the bursts caused by a single user's symbol list, a CI dry-run loop, or a webhook flood?

---

## 2. Telegram 429 exhaustion

**Symptoms** — Repeated `TelegramService` `category: "RATE_LIMITED"` in Sentry with `provider: "telegram-api"`, `deliveryMetrics.telegram.failure` rising, Telegram page quoting `retry_after`. A `category: "PAYLOAD_ERROR"` (HTTP 400/401/403/404) is a *configuration* problem (bot token revoked, forum topic deleted, MarkdownV2 parse failure) — see [§12](#12-telegram-deep-link-chat-id-discovery) for token reissue and forum topic recovery.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.telegram, .dependencies.deliveryMetrics.telegram'
```

If `deliveryMetrics.telegram.successRate < 0.5`, the bucket is exhausted.

**Mitigation (≤5 min)** —

1. Confirm `BOT_TOKEN` is unchanged; a rotated token still hits the same per-chat limit.
2. Set `ENABLE_TELEGRAM_BOT=false` to stop polling until the global limit clears (Telegram resets per-chat `retry_after` seconds; check the page's quoted value).
3. If a single chat is the source, route around it with `TELEGRAM_TOPIC_ROUTES` or a per-channel `telegramChatId` override on the calling webhook.
4. As a last resort, drop the affected chat to a backup admin chat (`TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID_FALLBACK`) and stop accepting writes from the throttled chat.

**Verification** — `deliveryMetrics.telegram.successRate` should rebound above 0.9 within 5 minutes of mitigation; `X-RateLimit-*` response headers from a manual `curl` to the bot's `getMe` endpoint confirm the bucket is fresh.

**Postmortem prompt** — Which chat generated the burst? Was it a single webhook or a chat-wide alert storm?

---

## 3. WhatsApp GreenAPI outage

**Symptoms** — `WhatsAppService` `category: "PROVIDER_ERROR"` repeating, `deliveryMetrics.whatsapp.failure` spiking, Sentry `provider: "greenapi"`.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.whatsapp, .deliveryMetrics.whatsapp'
```

Also probe GreenAPI directly: `curl -sS "$WHATSAPP_API_URL/waInstance*/status/$WHATSAPP_API_KEY"`.

**Mitigation (≤5 min)** —

1. If GreenAPI is down, set `ENABLE_WHATSAPP_ALERTS=false`; the redrive queue (`dependencies.notificationRedrive`) absorbs the backlog and replays once the channel returns.
2. Verify `NOTIFICATION_REDRIVE_MAX_AGE_MS` (default 24h) is large enough to cover the outage window.
3. If GreenAPI is rate-limiting, respect `retry_after` from the response and let the existing `sendWithRetry` drain naturally.

**Verification** — `deliveryMetrics.whatsapp.successRate` recovers; `/api/alerts/export?includeText=true` shows the queued alerts eventually delivered. The redrive worker logs `lastRunDeliveredCount > 0` in `/api/status > dependencies.notificationRedrive`.

**Postmortem prompt** — Was the outage GreenAPI-side or our misconfiguration? Were redrive replays successful?

---

## 4. Discord 429 exhausted

**Symptoms** — `DiscordService` `category: "RATE_LIMITED"`, `attemptCount` reaches `DISCORD_MAX_RETRIES` (default 3), Sentry `provider: "discord-webhook"`.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.discord, .dependencies.deliveryMetrics.discord'
```

Inspect `attemptCount` and the last error message in the Sentry event.

**Mitigation (≤5 min)** —

1. Respect the `Retry-After` floating-point header — do not integer-truncate it. The existing `sendWithRetry` does this; verify it in the Sentry payload.
2. If retries are exhausted, increase `DISCORD_MAX_RETRIES` (remote-config tunable) by 1 and redeploy.
3. For sustained outages, route alerts around Discord by setting `ENABLE_DISCORD_ALERTS=false` and rely on the redrive queue once it returns.

**Verification** — `deliveryMetrics.discord.successRate` recovers above 0.9 within the next sweep; the redrive worker drains the queue (`dependencies.notificationRedrive.queueDepth` returns to 0).

**Postmortem prompt** — Was the burst caused by a single scanner preset or a webhook flood? Should we shard by source (see #798)?

---

## 5. TradingView MCP black-hole

**Symptoms** — `TradingViewMcpService` `enrichmentStatus: "partial"` or `"failed"`, `dependencies.tradingViewMcp.runtime.status: "degraded"`, `dependencies.tradingViewMcp.enrichment.alertPath.appliedPercent` drops below 50%.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.tradingViewMcp'
```

Then probe the MCP directly:

```bash
curl -sS -X POST "$TRADINGVIEW_MCP_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Mitigation (≤5 min)** —

1. If the MCP returns 5xx, alerts are fail-open — verify the basic alert pipeline still delivers by checking `/api/alerts` for the last hour.
2. Increase `TRADINGVIEW_MCP_MAX_RETRIES` (default 3) and `TRADINGVIEW_MCP_TIMEOUT_MS` (default 12000) in Remote Config if the MCP is throttling, not down.
3. If the outage is sustained, set `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=false` and `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=false` to skip optional enrichment and keep base analysis.

**Verification** — `dependencies.tradingViewMcp.runtime.status: "ready"` and `enrichment.alertPath.appliedPercent >= 80` after the recovery.

**Postmortem prompt** — Was the outage the upstream MCP or a network path? Did the fail-open path preserve user-facing alert quality?

---

## 6. Binance Spot order rejected

**Symptoms** — `BinanceOrderService` returns `ORDER_REJECTED` with `errorCode: -1021` (timestamp), `-2010` (balance), or `-1022` (signature); Sentry `provider: "binance-spot"`.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/trading/binance/orders?limit=5" \
  | jq '.orders[] | {symbol, status, errorCode, errorMessage}'
```

**Mitigation (≤5 min)** —

1. If `errorCode: -1021`, sync the system clock (`chrony tracking`) and redeploy.
2. If `errorCode: -2010`, the symbol is outside `BINANCE_TRADING_ALLOWED_SYMBOLS` or the notional exceeds `BINANCE_TRADING_MAX_NOTIONAL`; either whitelist it or raise the cap.
3. If `errorCode: -1022`, the API secret rotated; update `BINANCE_API_SECRET` and redeploy.
4. As a kill-switch, set `ENABLE_BINANCE_TRADING=false` to halt all new orders.

**Verification** — `POST /api/trading/binance/orders` with a small test order returns `status: "NEW"`. `/api/status > dependencies.binanceTrading` reports `ready: true`.

**Postmortem prompt** — Was the rejection a misconfiguration, a market move, or a credential rotation? Should the kill-switch be auto-triggered on a sustained error rate?

---

## 7. Firestore credential rotation

**Symptoms** — `AlertStorageService` falls back to in-memory mode, `/api/status > dependencies.firestore*` shows `ready: false` with `errorCategory: "credentials"` or `"permission-denied"`, Sentry `provider: "firestore-admin"`.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.firestoreAlertStorage, .dependencies.firestoreJobStorage, .dependencies.firestoreScannerPresets'
```

**Mitigation (≤5 min)** —

1. Rotate `FIREBASE_SERVICE_ACCOUNT_JSON` in the platform secret store. The lazy `firebase-admin` singleton picks up the new credential on the next request after the secret propagates.
2. Run `ops/configure-firestore-alert-retention.sh` to backfill legacy terminal `alerts` documents with `expiresAt` once the new credential is live.
3. If the rotation is in response to a leak, also rotate `FIREBASE_WEB_API_KEY` (separate secret).

**Verification** — All `dependencies.firestore*` blocks report `ready: true` and `mode: "durable"`. The TTL backfill script reports `updated: N` matching the expected legacy document count.

**Postmortem prompt** — What triggered the rotation? How long was the in-memory fallback active? Did any alerts drop during the gap?

---

## 8. Signal-outcome worker dead

**Symptoms** — `/api/status > dependencies.signalOutcomeWorker.status: "degraded"` or `heartbeat.stale: true`, Sentry `feature: "signal-outcome"` with consecutive `worker_error` events.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.signalOutcomeWorker'
```

If `role: "worker"` and `ready: false`, the dedicated Render worker is down. If `role: "web"`, the in-process scheduler is the only evaluator.

**Mitigation (≤5 min)** —

1. If the worker is in a crash loop, check the worker's Render logs for the most recent stack trace. The fail-open drain keeps the queue durable.
2. Restart the dedicated worker via the Render dashboard; the durable lease is released after 60s and the next sweep takes over.
3. If the worker is permanently unavailable, flip `SIGNAL_OUTCOME_WORKER_ROLE=web` to fall back to the in-process timer, then investigate.
4. To prevent a backlog, raise `SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT` (default 50) so the next sweep catches up faster.

**Verification** — `dependencies.signalOutcomeWorker.heartbeat.stale: false` and `scannedCount` is increasing on the next sweep (visible in `/api/status`).

**Postmortem prompt** — Was the crash a Firestore quota, a Binance rate-limit, or an unhandled exception in the evaluator?

---

## 9. Scanner-preset scheduler dead

**Symptoms** — `dependencies.scannerPresetScheduler.stale: true`, presets not firing on schedule, Sentry `feature: "scanner-preset-scheduler"`.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.scannerPresetScheduler'
```

**Mitigation (≤5 min)** —

1. Check `SCANNER_PRESET_SCHEDULER_WORKER_ROLE` (default `web`); if the dedicated worker is down, restart it.
2. If the scheduler is the legacy in-process timer and is starved, raise the sweep interval via Remote Config.
3. If a single preset is stuck, cancel it via `DELETE /api/scanner-presets/{id}` (operator-confirmed) and the lease releases on the next sweep.

**Verification** — `dependencies.scannerPresetScheduler.stale: false`; a manual `POST /api/scanner-presets/{id}/run` returns `202` and a successful scan result.

**Postmortem prompt** — Did a single preset's sweep exhaust the deadline, or is the scheduler itself stuck?

---

## 10. Notification redrive backlog

**Symptoms** — `dependencies.notificationRedrive.queueDepth` rising, `lastRunDeliveredCount: 0` for > 1 hour, Sentry `feature: "notification-redrive"`.

**First check (≤30 s)** —

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" \
  | jq '.dependencies.notificationRedrive'
```

**Mitigation (≤5 min)** —

1. Verify the redrive worker's `role` is `web` or `worker`; if `disabled`, flip it via `NOTIFICATION_REDRIVE_WORKER_ROLE=web`.
2. If a channel is down (see #2–#4), the redrive will accumulate; once the channel returns, the backlog drains automatically.
3. To force a manual sweep, restart the worker process; the next iteration picks up the durable queue.
4. Cap the queue age with `NOTIFICATION_REDRIVE_MAX_AGE_MS` (default 24h) so dead-letter entries eventually drop and do not block fresh replays.

**Verification** — `queueDepth` trends down to 0; `lastRunDeliveredCount` > 0 within 5 minutes of mitigation.

**Postmortem prompt** — Which channel caused the backlog? Was the redrive itself throttled by the same channel?

---

## 11. Rate-limit storm (public IP behind proxy)

**Symptoms** — `429` responses from non-ingest endpoints, `/api/status` reports `X-RateLimit-Remaining: 0`, Sentry `category: "RATE_LIMITED"`.

**First check (≤30 s)** —

```bash
curl -sI -H "x-api-key: $WEBHOOK_API_KEY" "$NOTIFY_BASE_URL/api/status" | grep -i ratelimit
```

Inspect `src/lib/rateLimiter.js` to confirm the bucket math.

**Mitigation (≤5 min)** —

1. If behind a proxy, confirm `TRUST_PROXY` matches the hop count (Render uses 1; Cloudflare uses 2 with `cloudflare:true`).
2. The webhook ingest bucket is isolated (1,000 requests per window) — if the storm is on the ingest path, that bucket is decoupled from the global bucket.
3. To temporarily raise the global cap, set `RATE_LIMIT_MAX` higher in Remote Config (bounded 1–10000).
4. As a last resort, restart the service to reset the in-memory bucket (the limiter is per-replica, so a restart does not propagate).

**Verification** — `X-RateLimit-Remaining` is non-zero on the next request; Sentry `RATE_LIMITED` events drop to 0.

**Postmortem prompt** — Was the storm from a single IP, a CDN, or a webhook loop? Should we deprecate the in-memory limiter for Redis (see #692)?

---

## 12. Telegram deep-link chat ID discovery

**Symptoms** — Operator needs to enroll a new Telegram group or topic for alerts but does not have the chat ID.

**First check (≤30 s)** —

1. Add the bot to the group and send `/start@<bot>`.
2. Hit `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates` to read `chat.id` and (if it's a forum) the `message_thread_id` of any reply.

**Mitigation (≤5 min)** —

1. Record the chat ID in `TELEGRAM_CHAT_ID` (or the per-alert override `telegramChatId`).
2. If the group is a forum, set `TELEGRAM_TOPIC_ROUTES[<category>]` to the discovered `message_thread_id`, or pass `telegramThreadId` per request.
3. Use the admin Telegram page to test the new destination: `POST /api/webhook/message` with `telegramChatId: <new id>` and confirm a `Routed to <chat_id>` footer.

**Verification** — The test message lands in the new chat. The next production alert that targets the category shows up in the topic.

**Postmortem prompt** — Document the new chat ID and topic in `TELEGRAM_TOPIC_ROUTES` so future alerts route there by default.

---

## After mitigation — checklist

- [ ] **Confirm the fix took** via the *Verification* step in the matching section.
- [ ] **Remove any temporary disable flags** (`ENABLE_*=false`) you flipped during the incident; the service is fail-open but the feature is off.
- [ ] **Write a postmortem** under `docs/incidents/YYYY-MM-DD-<short-slug>.md` using the prompts from each section.
- [ ] **Open a follow-up issue** if the incident exposed a missing feature or a runbook gap; link it from the postmortem.
- [ ] **Update this runbook** if the mitigation or verification commands changed.

---

## Appendix — paging surface → section map

| Sentry tag / Telegram page keyword | Runbook section |
|------------------------------------|-----------------|
| `provider: "google-ai-studio"` + `429` | §1 Gemini 429 burst |
| `category: "RATE_LIMITED"` + `channel: "telegram"` | §2 Telegram 429 exhaustion |
| `category: "PAYLOAD_ERROR"` + `channel: "telegram"` | §12 Telegram deep-link chat ID discovery |
| `feature: "telegram-bot"` + `consecutiveFailures >= 5` | §2 Telegram 429 exhaustion |
| `provider: "greenapi"` | §3 WhatsApp GreenAPI outage |
| `provider: "discord-webhook"` + `429` | §4 Discord 429 exhausted |
| `feature: "tradingview-mcp"` + `enrichmentStatus: "failed"` | §5 TradingView MCP black-hole |
| `provider: "binance-spot"` + `errorCode: -1021 / -2010 / -1022` | §6 Binance Spot order rejected |
| `provider: "firestore-admin"` + `errorCategory: "credentials"` | §7 Firestore credential rotation |
| `feature: "signal-outcome"` + `status: "degraded"` | §8 Signal-outcome worker dead |
| `feature: "scanner-preset-scheduler"` + `stale: true` | §9 Scanner-preset scheduler dead |
| `feature: "notification-redrive"` + `queueDepth > 0` | §10 Notification redrive backlog |
| `category: "RATE_LIMITED"` + `provider: "express-rate-limit"` | §11 Rate-limit storm |
| Telegram onboarding flow | §12 Telegram deep-link chat ID discovery |
