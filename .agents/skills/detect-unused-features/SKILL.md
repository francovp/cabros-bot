---
name: detect-unused-features
description: Analyze the production Render deployment for disabled feature flags and unexposed capabilities. Cross-reference the API response with the codebase to find disabled features, missing feature flag coverage, and .env.example gaps. File GitHub issues for every finding with enablement instructions.
---

# Detect Unused Features (Render Production Audit)

## Overview

Fetch the production `/api/capabilities` endpoint on Render, parse every disabled/false flag, cross-reference against all `ENABLE_*` vars in the codebase, find gaps in `src/controllers/status.js`, and file GitHub issues. Also audit `.env.example` for env vars that exist in code but are missing from the template.

## Hard Rules

1. **Never claim a feature is disabled without evidence** — always cite the exact field from the API response and the corresponding code path.
2. **Always check open GitHub issues first** before filing a duplicate.
3. **Always check open PRs first** — a feature might already be in flight.
4. **Always run the production curl** fresh each invocation — never hardcode a stale response.
5. **Never file speculative or vague issues** — every issue must include specific enablement instructions (env vars, config steps, and code paths).
6. **Keep protected API key auth, feature gates, MarkdownV2 formatting, and fail-open alert delivery intact** — never suggest removing safety checks.
7. **Always update `.env.example`** when filing an issue for a missing env var — or at minimum flag it as a gap.
8. **Never modify `.env.example` without explicit user approval** — just report the delta and wait for direction.

## Pre-flight

Confirm `gh` CLI is authenticated and you have access to the repo. If not, fall back to reporting the findings without filing issues.

```bash
gh auth status 2>/dev/null || echo "NOT_AUTHENTICATED"
```

## Step 1: Fetch Production Capabilities

Call the unauthenticated capabilities endpoint and store the result.

```bash
CAPABILITIES=$(curl -s -X 'GET' \
  'https://cabros-crypto-bot-telegram.onrender.com/api/capabilities' \
  -H 'accept: application/json')
echo "$CAPABILITIES" | jq '.'
```

Extract these sections:
- `.featureFlags` — all boolean feature gates
- `.deliveryChannels` — channel enablement and status
- `.dependencies` — dependency readiness

## Step 2: Identify Disabled Features

Parse every `false` entry in `.featureFlags`. For each one, determine:

**Reference: Production featureFlags (as of June 2026):**
```json
{
  "telegramBot": true,
  "whatsappAlerts": true,
  "discordAlerts": false,
  "geminiGrounding": true,
  "newsMonitor": true,
  "tradingViewMcpEnrichment": true,
  "tradingViewConfluenceEnrichment": false,
  "tradingViewConfluenceMultiTimeframe": false,
  "firestoreAlertStorage": true,
  "sentryMonitoring": true,
  "sentryProfiling": false,
  "langfusePrompts": false,
  "marketScanner": true,
  "binancePriceCheck": false,
  "llmAlertEnrichment": false,
  "signalOutcomeTracking": false
}
```

Check `.dependencies` for the same dependency to understand why it's disabled:
- Is the feature flag itself `false`? → suggest setting the env var
- Is the dependency `configured: false`? → missing credentials
- Is the dependency `misconfigured`? → partial/incomplete config
- Is the dependency `disabled` with `configured: true`? → flag off but credentials ready

### Disabled Feature Map (enablement instructions)

For each disabled flag, include the enablement action and reference:

| Feature Flag | ENABLE_ Var | Also Requires | Code Reference |
|---|---|---|---|
| `discordAlerts` | `ENABLE_DISCORD_ALERTS=true` | `DISCORD_WEBHOOK_URL` — Discord channel webhook URL | `src/services/notification/DiscordService.js` |
| `tradingViewConfluenceEnrichment` | `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true` | TradingView MCP configured (defaults work) | `src/controllers/webhooks/handlers/alert/grounding.js` (see `shouldRunConfluence`) |
| `tradingViewConfluenceMultiTimeframe` | `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true` | Also requires confluence enrichment enabled | Same chain as confluence enrichment |
| `sentryProfiling` | `SENTRY_PROFILE_SESSION_SAMPLE_RATE` (float 0.0-1.0) | Sentry must be enabled (`ENABLE_SENTRY=true`, `SENTRY_DSN`) | `src/services/monitoring/SentryService.js` (profiling init) |
| `langfusePrompts` | `ENABLE_LANGFUSE_PROMPTS=true` | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` (already configured — just flip the flag) | `src/services/prompts/langfuseClient.js` |
| `binancePriceCheck` | `ENABLE_BINANCE_PRICE_CHECK=true` | — | `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` |
| `llmAlertEnrichment` | `ENABLE_LLM_ALERT_ENRICHMENT=true` | `AZURE_LLM_ENDPOINT`, `AZURE_LLM_KEY`, `AZURE_LLM_MODEL` (already configured) | `src/services/inference/enrichmentService.js` |
| `signalOutcomeTracking` | `ENABLE_SIGNAL_OUTCOME_TRACKING=true` | Firestore configured (already configured) | `src/services/outcomes/OutcomeTrackerService.js` |

## Step 3: Detect Unexposed Capabilities

Cross-reference all `ENABLE_*` environment variables used in `src/` against what `src/controllers/status.js` exposes in `featureFlags`.

### Known gaps (env vars used in code but NOT in status.js featureFlags):

| Env Var | Used In | Not In status.js |
|---|---|---|
| `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION` | `src/services/tradingview/TradingViewMcpService.js:105` | Not in `featureFlags` or `dependencies` |
| `ENABLE_FIRESTORE_JOB_STORAGE` | `src/services/jobs/JobRepository.js:14`, `src/services/storage/AlertStorageService.js:52` | Not in `featureFlags` or `dependencies` |
| `ENABLE_NEWS_MONITOR_TEST_MODE` | `src/services/grounding/config.js:12`, multiple sites | Not in `featureFlags` or `dependencies` |
| `ENABLE_MESSAGE_FOOTER_METADATA` | `src/controllers/webhooks/handlers/alert/grounding.js:88` | Not in `featureFlags` or `dependencies` |
| `ENABLE_CLOUDFLARE_AIG` | `src/controllers/status.js:309` | In `dependencies` only, NOT in `featureFlags` |

For each gap, file a GitHub issue titled e.g.:
> `Expose ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION in /api/capabilities`

Include:
- The env var and where it's used (file:line)
- The proposed feature flag name (e.g. `tradingViewVolumeConfirmation`)
- The proposed dependency entry
- Code references and a sample PR-ready patch sketch

## Step 4: Audit .env.example Completeness

Compare `src/controllers/status.js` (all env vars it reads) + `src/` usage against `.env.example`.

### Env vars read by status.js and/or used in code but MISSING from .env.example:

| Env Var | In status.js | In Code | In .env.example |
|---|---|---|---|
| `GEMINI_MODEL_NAME` | Yes (line ~174) | Yes (`src/services/grounding/config.js`) | ❌ Missing |
| `BRAVE_SEARCH_API_KEY` | Yes (line ~238) | Yes | ❌ Missing |
| `FORCE_BRAVE_SEARCH` | Yes (line ~187) | Yes | ❌ Missing |
| `OPENROUTER_API_KEY` | Yes (line ~144) | Yes | ❌ Missing |
| `OPENROUTER_MODEL` | Yes (line ~144) | Yes | ❌ Missing |
| `ENABLE_DISCORD_ALERTS` | Yes (master) | Yes | ❌ Missing |
| `DISCORD_WEBHOOK_URL` | Yes (master) | Yes | ❌ Missing |
| `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT` | Yes (master) | Yes | ❌ Missing |
| `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME` | Yes (master) | Yes | ❌ Missing |
| `ENABLE_SIGNAL_OUTCOME_TRACKING` | Yes (master) | Yes | ❌ Missing |
| `SENTRY_PROFILE_SESSION_SAMPLE_RATE` | Yes (master) | Yes | ❌ Missing |
| `ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP` | Yes (master) | Yes | ❌ Missing |
| `CF_AIG_TOKEN` | Yes (master) | Yes | ❌ Commented out |
| `CF_AIG_BASE_URL` | Yes (master) | Yes | ❌ Commented out |
| `CF_AIG_MODEL` | Yes (master) | Yes | ❌ Commented out |
| `ENABLE_CLOUDFLARE_AIG` | Yes (master) | Yes | ❌ Commented out |
| `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION` | ❌ Missing | Yes | ✅ Present |
| `ENABLE_FIRESTORE_JOB_STORAGE` | ❌ Missing | Yes | ✅ Present |
| `ENABLE_NEWS_MONITOR_TEST_MODE` | ❌ Missing | Yes | ✅ Present |
| `ENABLE_MESSAGE_FOOTER_METADATA` | ❌ Missing | Yes | ✅ Present |

Report this delta to the user. Offer to create issues or directly update `.env.example`.

## Step 5: Check Sentry Profiling Misconfiguration

The production response shows:
```json
"sentry": {
  "enabled": true,
  "configured": true,
  "ready": true,
  "status": "ready",
  "profiling": {
    "enabled": true,
    "configured": false,
    "ready": false,
    "status": "misconfigured"
  }
}
```

This means Sentry profiling is **half-set-up**: `SENTRY_TRACES_SAMPLE_RATE` is set (which enables the profiling feature flag) but `SENTRY_PROFILE_SESSION_SAMPLE_RATE` is missing (which marks it as unconfigured). File a targeted issue:

> **Fix Sentry profiling misconfiguration** — Set `SENTRY_PROFILE_SESSION_SAMPLE_RATE` to a value (e.g. 0.1) in Render env vars to enable profiling.

## Step 6: Check for Recently-Merged Features Not in Production

Compare the production commit (`$.service.commit`) against the latest `master` commit. Fetch:

```bash
PROD_COMMIT=$(echo "$CAPABILITIES" | jq -r '.service.commit')
LATEST_MASTER=$(git rev-parse origin/master 2>/dev/null || echo "unknown")
if [ "$PROD_COMMIT" != "$LATEST_MASTER" ]; then
  echo "Production is behind master by $(git rev-list --count ${PROD_COMMIT}..origin/master 2>/dev/null || echo '?') commits"
  git log --oneline --no-merges ${PROD_COMMIT}..origin/master 2>/dev/null || true
fi
```

If a merged PR adds a new `ENABLE_*` flag or a new status.js feature flag but was not yet deployed, note it in the report. Do NOT file an issue for it — the fix is to deploy master.

## Step 7: File GitHub Issues

For each actionable finding:
1. Verify no open issue already covers it (`gh issue list --state open`).
2. Create a concise, one-issue-per-finding GitHub issue.
3. Include:
   - **Problem**: What's disabled / missing / misconfigured
   - **Evidence**: The exact API response field, code path (file:line)
   - **Enablement**: Exact env vars to set, dependency requirements
   - **Validation**: How to verify after enabling (re-curl the endpoint)

**DO NOT file issues for:**
- Features already covered by an open issue
- Features already in an open PR
- Features that need a deploy only (production behind master)

## Step 8: Report Summary

Return a compact summary of:

```
## Production Capability Audit

### Fetched: <datetime>
### Production Commit: <sha>

### Disabled Features (<count>):
- discordAlerts — [issue #N | already in progress | skip reason]
- ... (each disabled flag)

### Unexposed Capabilities in status.js (<count>):
- ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION — [issue #N | skip]
- ...

### .env.example Gaps (<count>):
- GEMINI_MODEL_NAME — [issue #N | skip]
- ...

### Sentry Profiling:
- [issue #N | skip]
- DBG: profiling.enabled=true (SENTRY_TRACES_SAMPLE_RATE set), but SENTRY_PROFILE_SESSION_SAMPLE_RATE missing

### Production vs Master:
- <N> commits behind — [expected | deploy needed]
```

## Evidence Checklist

Before completing, collect:
- [ ] Fresh curl output from production `/api/capabilities`
- [ ] List of all `false` feature flags
- [ ] `src/controllers/status.js` featureFlags array
- [ ] Grep results for all `ENABLE_*` vars used in `src/`
- [ ] `.env.example` current content
- [ ] GH issue search confirming no duplicates
- [ ] Production commit vs master commit comparison

## Stop Conditions

- Stop without filing if `gh` CLI is not authenticated.
- Stop without filing if all findings already have open issues.
- Stop and ask if the user wants bulk filing vs selective issues.
- Stop and ask if the user wants you to directly update `.env.example` instead of filing issues.
