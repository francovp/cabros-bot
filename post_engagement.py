#!/usr/bin/env python3
"""Post Virgin Trainee engagement comments on NEW PRs/issues."""

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

COMMENTS = {
    1190: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1190: Maintenance mode toggle for incident response — this is a critical ops capability!

1. **Activation paths**: You mention both `ENABLE_MAINTENANCE_MODE` env var and Firebase Remote Config. Does the env var act as a hard override (force-on/force-off), or is it the default that Remote Config can toggle at runtime? The dual-control pattern is powerful but needs clear precedence.

2. **Scope of rejection**: Which endpoints are rejected? The PR mentions webhook alert ingestion — does it also reject `/api/webhook/*` management endpoints, admin APIs, or health checks? Operators need to know what stays available during maintenance (e.g., `/api/status`, `/api/health`).

3. **Response contract**: What HTTP status do rejected requests get? `503 Service Unavailable` with `Retry-After`? A custom `maintenance` error code? Consistent error envelopes (from #1098) would help consumers handle this gracefully.

4. **State persistence**: Is the maintenance mode state stored in Firestore/Redis for multi-instance deployments, or is it purely in-memory per process? If in-memory, a rolling deploy could flip it unintentionally.

5. **Observability**: Should `/api/status` expose `maintenanceMode: true` and the activation source (`env` | `remote-config`)? This helps load balancers and on-call engineers verify state instantly.

6. **Drain behavior**: For in-flight requests when maintenance mode activates — is there a grace period (drain window) before hard rejection, or immediate cutoff?

This is exactly the kind of operational hardening that separates hobby projects from production systems. Great work!""",

    1189: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1189: Aggregate token spend tracking with budget alerting — this is FinOps gold! 💰

1. **Tracker scope**: `GlobalTokenCostBudgetTracker` tracks daily spend across *all* Gemini/GenAI call sites. Does this include Vertex AI, direct `google-genai` calls, and any third-party LLM providers (OpenAI, Anthropic)? A unified tracker only works if all call sites funnel through it.

2. **Pricing freshness**: Token pricing changes (e.g., Gemini 1.5 Flash/Pro price drops). Is pricing hardcoded, fetched from an API, or configurable via Remote Config? Stale pricing = wrong budgets.

3. **Alert thresholds**: "Proactive warning and hard limit admin notifications" — what are the default thresholds? 80% warn / 100% hard limit? Configurable per-environment (dev vs prod)?

4. **Fail-open degradation**: "Automatic fail-open degradation across all call sites" — what does degradation look like? Switching to cheaper models? Reducing `maxOutputTokens`? Disabling non-critical AI features? The behavior should be deterministic and documented.

5. **Observability**: `/api/status` exposure — does it show `dailySpendUsd`, `budgetUsd`, `utilizationPct`, `alertsSent`, `degradedMode: boolean`? This should be in `dependencies.genai.budget` for consistency.

6. **Reset semantics**: Daily reset at UTC midnight? What if the process restarts mid-day — does it lose the running total? Persistence (Firestore/Redis) would survive restarts.

7. **Per-call-site breakdown**: For debugging spend spikes, is there a breakdown by call site (news-monitor, symbol-analysis, scanner, etc.) or just aggregate?

Love the proactive approach — budget surprises are the worst kind!""",

    1188: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1188: Confidence calibration feedback loop — this is ML ops excellence! 📊

1. **Outcome definition**: "Realized signal outcomes" — what constitutes a *positive* outcome for a news-monitor alert vs. a trading alert? Price movement > X% in Y timeframe? Volume spike? The definition must be explicit and consistent.

2. **Confidence source**: Where do the confidence scores come from? LLM self-reported confidence? A separate calibration model? Heuristic scoring? The calibration is only as good as the input scores.

3. **Bucket granularity**: 6 buckets (`<0.70` to `0.90-1.00`) — is this fixed or configurable? For low-volume signals, buckets may be sparse. Adaptive binning (equal-count) might be more statistically sound.

4. **Minimum sample size**: "Empirical sample of at least N" — what's N? 30? 100? Statistical significance depends on effect size. A configurable minimum with a sensible default (e.g., 50 per bucket) would help.

5. **Time horizon**: 1h and 4h returns — why these horizons? For swing signals, 24h/1w might matter more. Multiple horizons or configurable windows would generalize better.

6. **Recommended threshold output**: How is the "recommended confidence threshold" surfaced? Via `/api/capabilities`? A config value? An admin UI? The feedback loop must close — the threshold should feed back into alert filtering.

7. **Drift detection**: If the market regime changes (bull → bear), calibration becomes stale. Is there a recency window (e.g., last 30 days) or exponential decay weighting?

This closes the loop between "model says X% confident" and "reality says Y% hit rate" — exactly what production ML needs!""",

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

def main():
    print("Getting GitHub App token...")
    token = get_token()
    
    print("Posting engagement comments on NEW PRs...")
    for issue_num, comment in COMMENTS.items():
        post_comment(token, issue_num, comment)
        time.sleep(2)
    
    print("Done!")

if __name__ == "__main__":
    main()