#!/usr/bin/env python3
"""Post Virgin Trainee engagement comments on NEW issues/PRs since last scan."""

import jwt
import time
import requests

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_app_token():
    with open(PRIVATE_KEY_PATH, "r") as key_file:
        private_key = key_file.read()

    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")

    headers = {"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    
    res = requests.get("https://api.github.com/app/installations", headers=headers)
    res.raise_for_status()
    installations = res.json()
    installation_id = installations[0]['id']
    
    token_res = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers=headers
    )
    token_res.raise_for_status()
    return token_res.json()['token']

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

def main():
    print("Getting GitHub App token...")
    token = get_app_token()
    
    # New issues/PRs from scan since 2026-09-19T18:59:23Z
    comments = {
        1184: """Hi @francovp and @gigachad-senior-dev! 🤖

Regarding exposing `ENABLE_API_ONLY_MODE` in `/api/capabilities` featureFlags — this is a great observability addition. A few trainee questions:

1. **Feature flag vs. runtime config**: Is `ENABLE_API_ONLY_MODE` a build-time flag, a runtime env var, or a Firebase Remote Config gate? The `/api/capabilities` endpoint typically surfaces runtime-detectable capabilities — does this flag change at runtime or only on deploy?

2. **Consumer impact**: When `ENABLE_API_ONLY_MODE=true`, which endpoints are disabled? Does it affect webhook endpoints (`/api/webhook/*`), admin endpoints (`/api/admin/*`), or just the Telegram/WhatsApp command handlers? Understanding the boundary helps API consumers know what to expect.

3. **Status endpoint parity**: Should `/api/status` also reflect this mode (e.g., `mode: "api_only"`)? Currently it reports `dependencies` and `featureFlags` — adding a top-level `mode` field could help health checks and load balancers route traffic appropriately.

4. **Migration path**: If this is for a gradual rollout (e.g., splitting webhook handling from API serving), is there a plan for draining in-flight requests before the mode switch?

Looking forward to seeing the implementation!""",
        
        1183: """Hi @francovp and @gigachad-senior-dev! 🤖

Exposing `ENABLE_TELEGRAM_COMMAND_RATE_LIMITING` in `/api/capabilities` — excellent for transparency! A few questions:

1. **Rate limit scope**: Does this gate the per-user Telegram command rate limiter (from #658), the global API rate limiter (from #692), or both? The `featureFlags` surface suggests it's a toggleable capability — is it per-deployment or per-user?

2. **Limit configuration**: When enabled, what are the default limits? Requests per minute? Per hour? Are they configurable via env vars (`TELEGRAM_CMD_RATE_LIMIT_RPM`, etc.) or hardcoded?

3. **Response on limit**: What does the user see when rate limited? A structured error message? A retry-after hint? Silent drop? The `area/telegram` label suggests user-facing behavior matters.

3. **Observability**: Should `/api/status` expose current rate limit utilization (e.g., `telegramRateLimit: { used: 45, limit: 60, window: "1m" }`)? This would help operators tune limits proactively.

Great addition for production hardening!""",
        
        1182: """Hi @francovp and @gigachad-senior-dev! 🤖

`ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT` in featureFlags — this sounds like a significant architecture toggle! 

1. **Multi-agent vs single-agent**: What's the difference in behavior? Does multi-agent mean parallel analysis from multiple specialized agents (technical, fundamental, sentiment) with consensus, or a pipeline where agents hand off to each other?

2. **Consensus mechanism**: If multiple agents run, how is disagreement handled? Majority vote? Confidence-weighted average? First-agent-wins? The `area/analysis` label suggests this affects signal quality directly.

3. **Resource implications**: Multi-agent likely means 2-3x the LLM calls per analysis. Is there a cost/latency budget? Does the feature flag also control fallback to single-agent when multi-agent times out?

4. **Observability**: Should `/api/capabilities` or `/api/status` expose which mode is active? Consumers might want to know if they're getting multi-agent consensus or single-agent analysis.

This could be a game-changer for signal quality — excited to see the design!""",
        
        1181: """Hi @francovp and @gigachad-senior-dev! 🤖

`ENABLE_ALERT_HTF_RENDER` — HTF = Higher Timeframe? This sounds like a rendering/delivery enhancement for alerts.

1. **HTF context in alerts**: Does this add higher-timeframe context (e.g., daily/weekly trend) to lower-timeframe alert notifications? Like "15m breakout 📈 but Daily trend is 📉"?

2. **Render vs. compute**: "Render" suggests formatting/presentation. Is the HTF analysis computed separately and passed to the renderer, or computed on-demand during alert formatting?

3. **Channel-specific**: Does this affect all channels (Telegram, WhatsApp, Discord) or only specific ones? The `area/telegram` + `area/whatsapp` labels suggest channel-aware rendering.

4. **Performance**: Adding HTF data to every alert could increase payload size and computation. Is there a cache for HTF context (e.g., daily trend cached for 4h)?

Love the idea of richer alert context — helps operators make faster decisions!""",
        
        1180: """Hi @francovp and @gigachad-senior-dev! 🤖

Enabling Firestore persistence for news analysis in production (`ENABLE_FIRESTORE_NEWS_ANALYSIS=true`) — this connects to #695 (Firestore write observability) and #1093 (persist news-monitor results).

1. **Write path**: Does this write every news analysis result, or only alerts that pass the fatigue/throttling filters (#690)? Writing all analyses vs. only delivered alerts has very different volume implications.

2. **Schema alignment**: Is the Firestore schema aligned with the symbol-analysis persistence (#1096)? A unified `analysis_results` collection with `type: "news" | "symbol"` would enable cross-analysis trending.

3. **Observability**: With #695 adding write-success metrics, will this new write path be instrumented from day one? Silent write failures on news analysis would be hard to detect without metrics.

4. **Retention/TTL**: News analysis volume can be high during volatile markets. What's the TTL? 30 days? 90 days? Partitioned by date?

5. **Cost control**: Firestore writes have cost. Is there a daily write budget or circuit breaker if costs spike?

This completes the observability loop for news-monitor — exciting!""",
        
        1179: """Hi @francovp and @gigachad-senior-dev! 🤖

`ENABLE_SYMBOL_ANALYSIS_STORAGE=true` for production — pairs with #1180 (news) and #1096 (symbol-analysis persistence).

1. **Storage trigger**: Is this writing on every `/api/webhook/symbol-analysis` call, or only on scheduled scanner runs? The volume difference matters for Firestore costs and query patterns.

2. **Outcome linkage**: For "accuracy trending" (mentioned in #1096), how are outcomes linked? Does the stored analysis include a `prediction` field that gets matched against future price data via a background job?

3. **Query patterns**: What are the primary read paths? 
   - Operator: "Show me last 30 days of BTCUSDT analyses"
   - Automation: "Get accuracy stats for strategy X"
   - Alerting: "Find analyses that predicted this move"
   The schema should optimize for the hottest query.

4. **Deduplication**: If the same symbol is analyzed multiple times in a short window (e.g., scanner + manual trigger), are both stored or deduplicated?

This is the foundation for closed-loop learning — getting the schema right is critical!""",
        
        1178: """Hi @francovp and @gigachad-senior-dev! 🤖

`ENABLE_LANGFUSE_PROMPTS=true` for dynamic prompts — this is a significant observability/ops upgrade!

1. **Prompt versioning**: Does Langfuse handle prompt versioning (v1, v2, v3...) with rollback capability? Or is it just a prompt template store with runtime variable injection?

2. **A/B testing**: Can we run prompt A/B tests (e.g., 10% traffic on new prompt, 90% on current) with automatic metric comparison? This would be huge for prompt optimization.

3. **Fallback behavior**: If Langfuse is unreachable, does the system fall back to embedded prompts? Fail-open or fail-closed? The `area/observability` label suggests reliability matters.

4. **Cost/latency**: Fetching prompts from Langfuse adds a network hop. Is there local caching with TTL? What's the cache invalidation strategy when prompts are updated in Langfuse?

5. **Trace integration**: Do Langfuse traces automatically link to the prompt version used? This would make debugging "why did the LLM say X?" much easier.

Moving from hardcoded prompts to managed prompts is a maturity milestone — great direction!""",
        
        1177: """Hi @francovp and @gigachad-senior-dev! 🤖

"News monitor fully configured but never runs — zero news alerts in 90 days" — this is a critical ops gap! 🚨

1. **Scheduler vs. trigger**: Is the news-monitor supposed to run on a cron schedule (e.g., every 15m), or is it event-driven (webhook from news provider)? The "never runs" suggests the scheduler isn't firing.

2. **Configuration validation**: The issue says "fully configured" — does that mean all env vars are set (`NEWS_API_KEY`, `NEWS_ALERT_THRESHOLD`, etc.) but the cron job isn't deployed? Or is the worker process not starting?

3. **Health check gap**: If the news-monitor worker isn't running, does `/api/status` show it as `healthy`? There might be a gap in the worker health reporting.

4. **Alert on silence**: Should there be a "dead man's switch" alert — if no news-monitor execution in X hours, fire an ops alert? This would catch silent failures faster than 90-day discovery.

5. **Firestore persistence link**: With #1180 enabling Firestore persistence, once the monitor runs, we'll have visibility. But first we need it to *run*.

This feels like a deployment/configuration issue rather than code — but the impact is total signal loss. High priority to diagnose!""",
        
        1176: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1176: "fix(admin): preserve cached operation state after Playground filtering" — this relates to #1161 and #1163.

1. **Root cause**: Was the issue that `previousDefinition` cache wasn't updating when filtering auto-selected a new operation? So edits got written to the wrong cache key?

2. **Fix approach**: Does the fix update `previousDefinition` on auto-selection, or does it change the cache key derivation to include filter state?

3. **Dirty state**: Does this also fix the "unsaved changes indicator" showing incorrectly when filtering changes the selection?

4. **Test coverage**: Are there tests for rapid filter changes (keystroke-level) to ensure no race conditions in the cache update?

Playground state management is subtle — filtering + auto-selection + caching = classic React state sync bug territory. Good catch!""",
        
        1173: """Hi @francovp and @gigachad-senior-dev! 🤖

"Trim whitespace in batch alert ID lookups and deletes" — a small but important data hygiene fix!

1. **Source of whitespace**: Where does the whitespace come from? User input (copy-paste with trailing spaces)? API consumers sending ` "alert-123" `? Internal job payloads?

2. **Scope**: Is this trimming at the API boundary (controller), in the service layer, or in the storage layer? Trimming at the boundary (controller) catches it early for all consumers.

3. **Other fields**: Are there other ID-like fields that might have the same issue? `clientOrderId`, `origClientOrderId`, `jobId`? A centralized ID sanitization helper could prevent this class of bug.

4. **Test case**: Simple test: `deleteAlerts([" alert-1 ", "alert-2 "])` should find and delete both. Does the test cover leading/trailing spaces, tabs, newlines?

Small fix, prevents silent "not found" errors — love these hygiene improvements!""",
        
        1163: """Hi @francovp and @gigachad-senior-dev! 🤖

"Record actual Playground outcomes in request history" — this addresses the misleading `200 OK` for failed requests.

1. **Failure categories**: The issue mentions authorization, construction, cancellation failures. Should these map to HTTP status codes (`401`, `400`, `499`) or custom codes (`AUTH_FAILED`, `BUILD_FAILED`, `CANCELLED`)?

2. **History schema change**: Does the request history store a `status` field (HTTP code) and `errorCategory` field? Or a unified `outcome: "success" | "auth_failed" | "build_failed" | "cancelled"`?

3. **UI impact**: How does the history UI display these? Color-coded badges? Tooltips with error details? The `area/admin` label suggests console UI changes.

4. **Backfill**: For existing history entries with `200 OK` that actually failed — is there a backfill strategy, or do they stay as-is?

Accurate history is essential for debugging — this fix will save operators hours of "why did this 200 fail?" confusion.""",
        
        1161: """Hi @francovp and @gigachad-senior-dev! 🤖

"Preserve cached operation state after Playground filtering" — I commented on this earlier! 🤖

1. **Auto-selection flow**: When filtering narrows to one operation and it auto-selects, does `previousDefinition` still point to the *pre-filter* operation? Then Save writes to the wrong key?

2. **Cache key design**: Is the cache key just `operationId`, or `operationId + filterHash`? If it's just `operationId`, filtering doesn't change the key — but the selected operation *does* change, causing the mismatch.

3. **Fix strategy**: Update `previousDefinition` on auto-select? Or make cache key include filter context? The former is simpler; the latter preserves history per filter view.

4. **Dirty state sync**: Does the "unsaved changes" indicator also get confused? If I edit, then filter (changing selection), does the dirty flag persist incorrectly?

This is a classic React state synchronization bug — filtering changes selection, but cached state doesn't follow. The fix in #1176 should address it. Curious to see the approach!""",
    }
    
    print("Posting engagement comments on NEW issues...")
    for issue_num, comment in comments.items():
        post_comment(token, issue_num, comment)
        time.sleep(2)  # Rate limit courtesy
    
    print("Done!")

if __name__ == "__main__":
    main()