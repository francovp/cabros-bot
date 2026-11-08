#!/usr/bin/env python3
"""Post Virgin Trainee engagement comments on recent PRs/issues without existing engagement."""

import jwt
import time
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

APP_ID = "4766306"
KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_token():
    with open(KEY_PATH, "rb") as key_file:
        private_key = serialization.load_pem_private_key(
            key_file.read(), password=None, backend=default_backend()
        )
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    headers = {"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    res = requests.get("https://api.github.com/app/installations", headers=headers)
    installation_id = res.json()[0]["id"]
    token_res = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens", headers=headers
    )
    return token_res.json()["token"]

def post_comment(token, issue_number, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    res = requests.post(url, headers=headers, json={"body": body})
    if res.status_code == 201:
        print(f"✅ Posted to #{issue_number}")
        return True
    else:
        print(f"❌ Failed #{issue_number}: {res.status_code} - {res.text}")
        return False

# Engagement comments for PRs without existing trainee comments
PR_COMMENTS = {
    1194: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1194: Postman invalid outcomes summary request variants — great for API documentation coverage! 📋

1. **Variant strategy**: The PR adds request variants for "invalid outcomes" — are these negative test cases (expecting 4xx/5xx) or valid requests that produce "invalid" business outcomes (e.g., signal rejected, insufficient data)? The distinction affects how consumers use these examples.

2. **Outcome taxonomy**: What constitutes an "invalid outcome" in the Postman collection? `validation_error`, `auth_failure`, `rate_limited`, `signal_rejected`, `data_unavailable`? A shared taxonomy with the error envelope from #1098 would help consistency.

3. **Automation potential**: Could these variants be generated from OpenAPI spec `error` responses + example values, rather than hand-maintained? The `type/feature` + `area/api` labels suggest this might be a recurring need across endpoints.

4. **CI integration**: Are these variants executed in CI (Newman/Postman CLI) to verify the API actually returns the documented error shapes? Living documentation > static examples.

5. **Channel parity**: Since WhatsApp/Telegram have different formatting limits (per the SOC boundary in AGENTS.md), do the error response examples account for channel-specific truncation or formatting differences?

Love the investment in API consumer experience — good examples save hours of trial and error!""",

    1193: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1193: Classify alerts with `signalClass` enum — type-safe alert routing! 🎯

1. **Enum completeness**: What `signalClass` values are defined? `trading`, `news`, `scanner`, `volume_confirmation`, `system`, `test`? Is the enum closed (exhaustive) or open for future extension? A `unknown` fallback helps with forward compatibility.

2. **Routing impact**: How does `signalClass` affect delivery? Different channels per class? Different rate limits? Different formatting templates? The `area/telegram` + `area/whatsapp` labels suggest channel-specific handling.

3. **Backward compatibility**: Existing alerts without `signalClass` — do they default to a legacy class, or is there a migration? The `type/feature` label suggests new functionality, but classification often touches existing flows.

4. **Observability**: Does `/api/status` or `/api/alerts/summary` expose `signalClass` breakdowns (counts, latencies, error rates per class)? Per-class metrics would help identify class-specific issues.

5. **Filtering API**: Can consumers filter `/api/alerts` by `signalClass`? The `area/api` label suggests query capabilities — `signalClass=trading,scanner` would be powerful for dashboards.

Type-safe classification is a force multiplier for alert routing logic — clean foundation!""",

    1192: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1192: Document notification redrive zero-channel telemetry in Postman — observability docs FTW! 📊

1. **Telemetry scope**: "Zero-channel telemetry" — does this mean alerts where *all* delivery channels failed (Telegram + WhatsApp + any others), or alerts that had zero configured channels from the start? The distinction matters for alerting on "silent failures" vs. "misconfiguration."

2. **Redrive integration**: The redrive service (`NotificationRedriveService`) — does it expose metrics for `zeroChannelAttempts`, `zeroChannelSuccesses`, `zeroChannelPermanentFailures`? The PR #1191 (admin paging guard) suggests this is related.

3. **Postman as source of truth**: Is the Postman collection the canonical documentation, or does it sync from OpenAPI/generated docs? Hand-maintained Postman collections drift; generated ones stay current.

4. **SLA connection**: Zero-channel outages should probably trigger the admin paging from #1191. Is there a `zeroChannelOutage` alert rule defined, or is that a follow-up?

5. **Historical queries**: Can operators query "show me all zero-channel alerts in the last 7 days" via API? The `area/api` + `area/observability` labels suggest query capability.

Documenting failure modes is as important as documenting success paths — this prevents the "we didn't know it was broken" conversations!""",

    1191: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1191: Enable admin paging + guard redrive dead-letters on zero-channel outage — critical ops hardening! 🚨

1. **Paging trigger**: What constitutes a "zero-channel outage" that triggers admin paging? All channels failing for a single alert? Sustained failure rate > X% over Y minutes? The threshold determines signal-to-noise for on-call.

2. **Dead-letter guard**: "Guard redrive dead-letters on zero-channel outage" — does this mean pausing redrive retries when zero-channel is detected (to avoid hammering broken channels), or routing to a separate dead-letter queue for manual inspection?

3. **PagerDuty/on-call integration**: Is admin paging a direct Telegram message to @francovp, or does it integrate with PagerDuty/OpsGenie/VictorOps? The `area/telegram` label suggests direct Telegram, but production systems often need escalation policies.

4. **Flapping protection**: If zero-channel oscillates (channel recovers, fails, recovers), does paging debounce? Alert storms during partial outages are a classic ops nightmare.

5. **Runbook linkage**: Does the page include a runbook link (e.g., "Check Telegram bot token", "Verify WhatsApp Business API status")? Context-rich pages reduce MTTR dramatically.

6. **Observability**: `/api/status` exposure of `adminPagingEnabled`, `lastPageSent`, `zeroChannelOutageActive` — operators need to verify state without checking logs.

This is exactly the kind of "defense in depth" that prevents 3 AM surprises. Paging on *delivery failure* (not just *service failure*) is a maturity milestone!""",

    1187: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1187: SDK major drift audit — dependency hygiene at its finest! 📦

1. **Drift catalog**: 10 packages with untracked major drift (`@google/genai`, `firebase-admin`, `bullmq`, `ioredis`, `openai`, `binance`, `undici`, `uuid`, `helmet`, `dotenv`). For each, what's the *actual* risk? Breaking API changes? Performance regressions? Security fixes missed?

2. **Compatibility holds**: "Revisit dates 2026-12-31" — is this a hard deadline or a review trigger? What happens on 2027-01-01 if no action taken? Auto-upgrade? Alert? Block deploy?

3. **Dependabot ignore rules**: Ignoring `version-update:semver-major` silences noise but also hides *security* major updates. Is there a separate process for security-only major upgrades (e.g., `npm audit fix --force` equivalent)?

4. **Testing strategy**: How do you validate compatibility before upgrading? Integration test suite? Contract tests? Canary deployments? The audit doc should reference the validation pipeline.

5. **Lockfile discipline**: Are `package-lock.json` / `pnpm-lock.yaml` committed and enforced? Drift often starts with unlocked transitive deps.

6. **Monorepo considerations**: If this is a monorepo, does the audit cover all workspaces? Shared dependencies can drift differently per package.

7. **Automation**: Could this be a scheduled job (weekly?) that fails CI if new major drift detected? "Audit once" becomes "audit continuously."

Proactive dependency management prevents the "it worked yesterday, why is prod broken today" 3 AM pages. Solid work!""",

    1186: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1186: TradingView MCP per-tool metrics in `/api/status` — observability for the trading brain! 🧠

1. **Tool catalog**: 6 tools listed (`coin_analysis`, `volume_confirmation_analysis`, `combined_analysis`, `multi_timeframe_analysis`, `multi_agent_analysis`, individual scanners). Are these all the tools, or are there more? The list should be exhaustive.

2. **Metric granularity**: Per-tool `latencyMs` (p50, p95, p99?) and `successRate`. Are errors categorized (timeout, MCP protocol error, TV API error, rate limit)? Bucketing errors helps triage.

3. **Window**: What's the metrics window? Rolling 5m? 1h? Since process start? Rolling windows are more actionable for alerting.

4. **Cardinality control**: If tools are dynamically registered, cardinality could explode. Is there a max-tools limit or aggregation for rarely-used tools?

5. **`/api/capabilities` exposure**: "Surfaces them under `dependencies.tradingViewMcp.toolMetrics`" — does this include the actual metrics values or just the *schema* (what metrics exist)? Capabilities usually describes *what's available*, not current values. Status endpoint = current values.

6. **Alerting integration**: With per-tool success rates, can we alert on `coin_analysis.successRate < 0.95` for 5m? This would catch TV API degradation early.

7. **Correlation with upstream**: Do these metrics correlate with TradingView's own status page / API health? Cross-referencing reduces false positives.

Per-tool observability is a force multiplier for debugging — "which tool is slow?" becomes answerable instantly!""",

    1185: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1185: Rate limit isolation for all webhook/news-monitor POST endpoints — closing the ingress protection gap! 🛡️

1. **Bucket capacity**: "High-capacity 1,000-request webhook ingest bucket" — is 1000 req/window the limit? What's the window (1m, 5m, 15m)? Burst handling matters for TradingView webhook storms.

2. **Key derivation**: What's the rate limit key for these endpoints? IP? API key? `X-Forwarded-For` behind proxy? The PR #1165 (proxy-aware key derivation) should apply here — are they integrated?

3. **Endpoint coverage**: 7 endpoints listed. Are there any other POST ingest endpoints not covered? `/api/webhook/*` catch-all? MCP tool endpoints? A test that scans routes for `POST /api/webhook/**` and verifies bucket assignment would prevent gaps.

4. **News-monitor inclusion**: `/api/news-monitor` is POST but typically called by *our* scheduler, not external webhooks. Does it need the same generous bucket, or a separate one? Self-inflicted rate limits are embarrassing.

5. **Response on limit**: 429 with `Retry-After`? Structured error envelope (from #1098)? The response should be machine-readable for TradingView webhook retry logic.

6. **Observability**: `/api/status` exposure of ingest bucket utilization (`used`, `limit`, `window`, `rejectedCount`)? Operators need to see "we're at 95% capacity" before it hits 100%.

7. **Interaction with global limiter**: Does the ingest bucket sit *before* or *after* the global API rate limiter? Ingress-specific bucket first, then global — or vice versa? Order affects which limit hits first.

This completes the ingress hardening story — webhook storms can't take down the API anymore!""",
}

# Engagement comments for Issues without existing trainee comments
ISSUE_COMMENTS = {
    1184: """Hi @francovp! 🤖

Issue #1184: Expose `ENABLE_API_ONLY_MODE` in `/api/capabilities` featureFlags — runtime config visibility! ⚙️

1. **Flag semantics**: What does `ENABLE_API_ONLY_MODE=true` actually disable? Webhook ingestion? Telegram/Whatalert delivery? Admin UI? The name suggests "API only" but the boundary needs to be explicit for consumers.

2. **Capabilities contract**: `/api/capabilities` is the source of truth for "what's available right now." Adding feature flags there is great — but should it also expose *why* a flag is off (env var, remote config, dependency failure, manual override)?

3. **Consumer use case**: Who consumes this? Frontend admin panel? Health checks? Deployment verification scripts? Knowing the consumer shapes the schema (boolean vs. enum vs. object with metadata).

4. **Consistency**: Are there other `ENABLE_*` flags not yet exposed? A grep for `ENABLE_` in the codebase vs. what's in `featureFlags` would reveal gaps.

5. **Dynamic toggles**: If `ENABLE_API_ONLY_MODE` can flip at runtime (via Remote Config), does `/api/capabilities` reflect the change immediately, or is there a cache TTL? Stale capabilities = confused consumers.

Runtime feature visibility is a superpower for debugging "why is X not working?" — love this direction!""",

    1183: """Hi @francovp! 🤖

Issue #1183: Expose `ENABLE_TELEGRAM_COMMAND_RATE_LIMITING` in `/api/capabilities` — rate limit transparency! 📊

1. **Rate limit scope**: Does this flag control rate limiting for *all* Telegram commands (`/analisis`, `/scanner`, `/alert`, etc.) or specific ones? Per-command limits would be more granular.

2. **Limit configuration**: What are the actual limits (requests/window)? Are they configurable per-command, or one global limit? The flag name suggests on/off, but the *values* matter for capacity planning.

3. **Capabilities exposure**: Beyond on/off, should `/api/capabilities` expose the *current* limit values and window? `telegramCommandRateLimit: { enabled: true, limit: 30, window: "60s", scope: "per-user" }` is more actionable than just `true/false`.

4. **Bypass/allowlist**: Are there users/roles that bypass this limit (admins, premium)? If so, the capabilities response might need to reflect the *effective* limit for the authenticated user.

5. **Observability correlation**: When this flag is off, do we see Telegram 429 errors from the Bot API? Correlating internal rate limits with upstream provider limits prevents double-limiting or gaps.

Rate limit observability is often overlooked until users hit mysterious failures — proactive exposure prevents that!""",

    1182: """Hi @francovp! 🤖

Issue #1182: Expose `ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT` in `/api/capabilities` — multi-agent transparency! 🤝

1. **Multi-agent behavior**: What does "multi-agent" mean for symbol analysis? Parallel LLM calls with different personas? Sequential pipeline (analyst → risk manager → formatter)? The implementation affects latency, cost, and result variance.

2. **Feature flag granularity**: Is this a single on/off, or are there sub-flags (e.g., `ENABLE_RISK_AGENT`, `ENABLE_FORMATTER_AGENT`)? The flag name suggests a bundle.

3. **Capabilities schema**: Beyond boolean, should capabilities expose the *agent composition* when enabled? `symbolAnalysis: { multiAgent: true, agents: ["technical", "fundamental", "risk"], timeoutMs: 30000 }` helps consumers set expectations.

4. **Fallback behavior**: When disabled, does it fall back to single-agent analysis, or return an error/unavailable? Graceful degradation > hard failure.

5. **Cost observability**: Multi-agent = N× LLM calls. Does `/api/status` expose token spend per analysis mode? The FinOps tracker from #1189 should correlate.

Multi-agent architectures are powerful but opaque — exposing the composition in capabilities is a great pattern for debuggability!""",

    1181: """Hi @francovp! 🤖

Issue #1181: Expose `ENABLE_ALERT_HTF_RENDER` in `/api/capabilities` — HTF rendering visibility! 📈

1. **HTF definition**: "HTF" = Higher Timeframe? (e.g., 4H, 1D, 1W charts rendered alongside the signal timeframe). Clarifying the acronym in the flag name or docs helps future readers.

2. **Render scope**: Does this flag control chart *generation* (Puppeteer/Playwright), chart *delivery* (image upload to Telegram/WhatsApp), or both? The `area/telegram` + `area/whatsapp` labels suggest delivery.

3. **Resource impact**: Chart rendering is CPU/memory intensive. Is there a queue/worker pool? Does the flag control the worker pool size, or just enable/disable the feature entirely?

4. **Capabilities detail**: Should `/api/capabilities` expose supported timeframes, image formats, max concurrent renders? `htfRender: { enabled: true, timeframes: ["4H", "1D", "1W"], format: "png", maxConcurrent: 3 }`

5. **Failure modes**: If rendering fails (timeout, OOM, browser crash), does the alert still deliver without the chart? The `area/observability` label suggests this should be monitored.

HTF charts are a premium feature — making the capability visible helps consumers understand what they'll receive!""",

    1180: """Hi @francovp! 🤖

Issue #1180: Enable news analysis Firestore persistence in production (`ENABLE_FIRESTORE_NEWS_ANALYSIS=true`) — historical intelligence! 📰

1. **Persistence scope**: What exactly gets persisted? Full `NewsAlert` with `analysis`, `sentiment`, `invalidation_hint`, `stop_loss`, `take_profit`? Or a distilled version for trending queries?

2. **Schema & indexing**: Firestore queries need composite indexes. What are the query patterns? By symbol + date range? By sentiment + eventCategory? By source credibility? The indexes should be defined in `firestore.indexes.json` and deployed.

3. **Retention & TTL**: News volume can be high. What's the retention policy? 90 days (matching #1177)? TTL field on documents? Partitioned collections by date (e.g., `newsAnalysis_2026_09`)?

4. **Cost control**: Firestore reads/writes/storage cost money. Is there a budget guard (like #1189's token budget) for news analysis persistence? Write-heavy workloads can surprise.

5. **Migration/backfill**: Enabling in production — is there a backfill for historical news alerts, or forward-only from enablement? Backfills need careful throttling to avoid quota exhaustion.

6. **Query API**: Will there be a `/api/news-monitor/history` or `/api/alerts?source=news` endpoint to query persisted analyses? The `area/api` label suggests yes.

Persistence turns ephemeral news alerts into a knowledge base — foundation for the "closed-loop learning" discussed in #1106!""",

    1179: """Hi @francovp! 🤖

Issue #1179: Enable symbol analysis Firestore persistence in production (`ENABLE_SYMBOL_ANALYSIS_STORAGE=true`) — decision history foundation! 📊

1. **Persistence schema**: What's stored per analysis? Symbol, timeframe, `prediction` (direction, confidence, entry/target/stop), `analysis` (text), `metadata` (model, tokens, latency)? The schema should support the "accuracy trending" queries from #1096.

2. **Outcome attribution**: How are outcomes linked to predictions? Separate `outcomes` collection with `predictionId` foreign key? Or embedded in the analysis document? The `area/database` label suggests schema design matters.

3. **Accuracy computation**: "Accuracy trending" — comparing `prediction.direction` vs. `outcome.priceMovement` after N candles? Time-horizon specific (1h, 4h, 1D)? The computation logic should be versioned alongside the schema.

4. **Partitioning & indexes**: Time-partitioned collections (monthly?) with composite indexes on `symbol + createdAt`, `symbol + outcome.verifiedAt`? Firestore costs scale with index count.

5. **Privacy & access control**: Trading signal history is sensitive. `area/auth` label — are there Firestore security rules restricting reads to authenticated users with specific roles? Encryption at rest is default but field-level encryption for PII?

6. **Backfill strategy**: Forward-only or historical backfill? If backfill, from what date? The scanner presets (`tech`, `chile`, `indexes`, `crypto`, `fx`) generate significant volume.

This pairs with #1180 (news) for a unified "decision history" — are the schemas aligned for cross-analysis queries?""",

    1178: """Hi @francovp! 🤖

Issue #1178: Enable Langfuse dynamic prompts in production (`ENABLE_LANGFUSE_PROMPTS=true`) — prompt management maturity! 🎭

1. **Prompt scope**: Which prompts are managed in Langfuse? News analysis, symbol analysis, scanner prompts, Telegram command handlers? The `area/llm` label suggests broad coverage.

2. **Versioning & rollback**: Langfuse supports prompt versions. Is there a deployment strategy (canary % of traffic, feature flag per prompt)? Rollback on regression (quality drop, latency spike) should be instant.

3. **Dynamic variables**: Do prompts use runtime variables (symbol, timeframe, news context, user tier)? Langfuse's variable substitution handles this, but the variable contract must be stable.

4. **Observability**: Langfuse traces should correlate with our `/api/status` and token budget (#1189). Does each trace carry `requestId` (from #1071) for end-to-end debugging?

5. **Cost tracking**: Langfuse can track token usage per prompt version. Does this feed into the global token budget tracker, or is it separate? Unified FinOps view is ideal.

6. **Fallback**: If Langfuse is unavailable (API down, network partition), does the system fall back to embedded prompt templates? The `ENABLE_LANGFUSE_PROMPTS` flag suggests on/off, but graceful degradation matters.

Dynamic prompts separate "prompt engineering" from "code deployment" — a huge velocity unlock for LLM features!""",

    1177: """Hi @francovp! 🤖

Issue #1177: News monitor fully configured but never runs — zero news alerts in 90-day retention window! 🕵️

1. **Scheduler check**: Is the news-monitor scheduler actually running? Cloud Scheduler / cron / BullMQ worker? The `area/scheduler` or `area/worker` labels would help identify the component.

2. **Configuration vs. execution**: "Fully configured" — does this mean API keys, webhook URLs, scanner presets, Firestore collections are all set up, but the *trigger* never fires? Or does it fire but produce zero results?

3. **Upstream health**: News sources (RSS, APIs, webhooks) — are they returning data? A silent upstream failure (API key expired, RSS feed changed, webhook not receiving) looks like "zero alerts" but is actually "zero input."

4. **Filtering aggressiveness**: Are the relevance/quality filters so strict that legitimate news gets discarded? The `eventCategory` classification (from #1093) might be filtering everything out.

5. **Observability gap**: "Zero alerts in 90 days" suggests no alerting on *absence of alerts*. A dead man's switch / heartbeat alert ("news-monitor produced 0 alerts in 24h") would have caught this months ago.

6. **Manual trigger test**: Can you manually invoke the news-monitor (API endpoint, CLI, admin UI) to verify the pipeline works end-to-end? If manual works but scheduled doesn't, it's a scheduler issue.

This is a classic "silent failure" — the system is up, but the *business value* isn't flowing. Heartbeat alerts on business metrics (not just infra) are essential!""",
}

def main():
    print("Getting GitHub App token...")
    token = get_token()
    
    print("Posting engagement comments on PRs...")
    for issue_num, comment in PR_COMMENTS.items():
        post_comment(token, issue_num, comment)
        time.sleep(2)  # Rate limit courtesy
    
    print("Posting engagement comments on Issues...")
    for issue_num, comment in ISSUE_COMMENTS.items():
        post_comment(token, issue_num, comment)
        time.sleep(2)  # Rate limit courtesy
    
    print("Done!")

if __name__ == "__main__":
    main()