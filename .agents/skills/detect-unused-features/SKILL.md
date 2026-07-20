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

Load `WEBHOOK_API_KEY` from the operator's approved secret mechanism. The key is sent only as the protected `x-api-key` header and is never printed. If it is unavailable, stop before parsing downstream data.

```bash
if ! CAPABILITIES="$(.agents/skills/detect-unused-features/scripts/fetch-capabilities.sh)"; then
  echo 'Capability audit stopped: authenticated /api/capabilities evidence is unavailable.' >&2
  exit 78
fi
echo "$CAPABILITIES" | jq '.'
```

Extract these sections:
- `.featureFlags` — all boolean feature gates
- `.deliveryChannels` — channel enablement and status
- `.dependencies` — dependency readiness

## Step 2: Identify Disabled Features

Parse every `false` entry in the fresh `.featureFlags` object. Do not copy the
result into this skill or rely on a dated example:

```bash
jq -r '.featureFlags | to_entries[] | select(.value == false) | .key' <<<"$CAPABILITIES"
```

For each returned flag, inspect the matching fresh dependency data and the
current source before making a finding:

```bash
while IFS= read -r flag; do
  jq --arg flag "$flag" '{flag: .featureFlags[$flag], dependencies: .dependencies}' <<<"$CAPABILITIES"
done < <(jq -r '.featureFlags | to_entries[] | select(.value == false) | .key' <<<"$CAPABILITIES")
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

This table is enablement guidance only; it is not evidence that any listed
flag is currently disabled. If a fresh flag is not listed, inspect its runtime
gate and dependency path instead of guessing.

## Step 3: Detect Unexposed Capabilities

Cross-reference the current source against the current `featureFlags` object;
never use a maintained list of known gaps:

```bash
rg -n 'process\.env\.ENABLE_[A-Z0-9_]+' src
rg -n 'featureFlags|dependencies' src/controllers/status.js
```

For each code gate that lacks a corresponding status capability, capture the
exact file and line from the command output, then inspect open issues and PRs
before filing it.

For each gap, file a GitHub issue titled e.g.:
> `Expose ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION in /api/capabilities`

Include:
- The env var and where it's used (file:line)
- The proposed feature flag name (e.g. `tradingViewVolumeConfirmation`)
- The proposed dependency entry
- Code references and a sample PR-ready patch sketch

## Step 4: Audit .env.example Completeness

Compare current source usage against the current template on every run:

```bash
comm -23 \
  <(rg -o --no-filename 'process\.env\.[A-Z][A-Z0-9_]*' src \
    | sed 's/^process\.env\.//' | sort -u) \
  <(rg -o --no-filename '^[A-Z][A-Z0-9_]*=' .env.example \
    | sed 's/=$//' | sort -u)
```

Report this delta to the user. Offer to create issues or directly update `.env.example`.

### Healthy-data dry run

Use a small fixture to prove that stale snapshot findings are ignored when the
fresh response and template are healthy:

```bash
FIXTURE_CAPABILITIES='{"featureFlags":{"discordAlerts":true},"dependencies":{"sentry":{"profiling":{"status":"ready"}}}}'
! jq -e '.featureFlags | to_entries[] | select(.value == false)' <<<"$FIXTURE_CAPABILITIES" >/dev/null
test "$(jq -r '.dependencies.sentry.profiling.status' <<<"$FIXTURE_CAPABILITIES")" = ready
FIXTURE_ENV_EXAMPLE=$'ENABLE_DISCORD_ALERTS=true\nSENTRY_PROFILE_SESSION_SAMPLE_RATE=0.1'
! comm -23 \
  <(printf '%s\n' ENABLE_DISCORD_ALERTS SENTRY_PROFILE_SESSION_SAMPLE_RATE | sort) \
  <(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' <<<"$FIXTURE_ENV_EXAMPLE" | sort) \
  | grep -q .
```

## Step 5: Check Sentry Profiling Misconfiguration

Read the current response instead of assuming a configuration state:

```bash
PROFILING_STATUS=$(jq -r '.dependencies.sentry.profiling.status // "unknown"' <<<"$CAPABILITIES")
if [ "$PROFILING_STATUS" = misconfigured ]; then
  echo "Sentry profiling requires a targeted issue; cite the fresh .dependencies.sentry.profiling response."
else
  echo "Sentry profiling status: $PROFILING_STATUS; do not file the stale-snapshot issue."
fi
```

Only when the fresh status is `misconfigured`, file a targeted issue:

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
- <fresh `.featureFlags` key> — [issue #N | already in progress | skip reason]

### Unexposed Capabilities in status.js (<count>):
- <fresh source/status comparison> — [issue #N | skip]

### .env.example Gaps (<count>):
- <fresh `comm -23` result> — [issue #N | skip]

### Sentry Profiling:
- [issue #N | skip]
- DBG: cite the fresh `.dependencies.sentry.profiling` object

### Production vs Master:
- <N> commits behind — [expected | deploy needed]
```

## Evidence Checklist

Before completing, collect:
- [ ] Fresh curl output from production `/api/capabilities`
- [ ] List of all `false` feature flags
- [ ] Current `src/controllers/status.js` featureFlags/dependencies mapping
- [ ] Grep results for all `ENABLE_*` vars used in `src/`
- [ ] Current `.env.example` delta from `comm -23`
- [ ] Healthy-data dry run passes without stale findings
- [ ] GH issue search confirming no duplicates
- [ ] Production commit vs master commit comparison

## Stop Conditions

- Stop without filing if `gh` CLI is not authenticated.
- Stop without filing if all findings already have open issues.
- Stop and ask if the user wants bulk filing vs selective issues.
- Stop and ask if the user wants you to directly update `.env.example` instead of filing issues.
