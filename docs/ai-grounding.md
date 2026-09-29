# AI Grounding & Prompt Management

[← Back to README](../README.md)

## Alert Enrichment with Gemini Grounding (001)

The webhook alert system can optionally enrich alerts with verified sources and market context using Google Gemini API with GoogleSearch grounding.

### MCP Flow

When `ENABLE_GEMINI_GROUNDING=true`:

1. Alert text received via webhook
2. Gemini API queries with GoogleSearch grounding enabled
3. Returns summary and extracted sources (URLs with titles)
4. Enriched alert formatted and sent to all enabled channels (Telegram, WhatsApp)

### Enrichment Features

- **Sentiment Analysis**: Determines market sentiment (BULLISH/BEARISH/NEUTRAL) with confidence score
- **Key Insights**: Extracts bullet points of critical information
- **Technical Levels**: Identifies support and resistance levels mentioned in context
- **Risk Parameters**: Optionally reports invalidation level, target level, setup type, and estimated risk/reward ratio
- **Verified Sources**: Extracts URLs and titles from GoogleSearch results
- **Language Support**: Respects original language of alert text
- **Graceful Fallback**: If enrichment fails, original alert is sent without delays
- **Reusable Results**: Single grounding call shared across all notification channels

### Configuration

- `ENABLE_GEMINI_GROUNDING` - Enable/disable enrichment (default: `false`)
- `GEMINI_API_KEY` - Google API key with Generative AI enabled
- `ENABLE_TOKEN_COST_BUDGET` - Enable/disable global LLM daily token spend tracking and budget enforcement (default: `false`)
- `TOKEN_COST_DAILY_BUDGET_USD` - Daily LLM spend ceiling in USD before calls fail open (default: `5.00`)
- `TOKEN_COST_WARN_THRESHOLD_PCT` - Percentage of daily budget that triggers an admin Telegram alert (default: `80`)

### How Langfuse Prompt Management Works

When `ENABLE_LANGFUSE_PROMPTS=true`, runtime prompts are fetched from Langfuse through the centralized prompt service in `src/services/prompts/`.

The local fallback prompts now live as editable text templates under `src/services/prompts/defaults/`, which makes them much easier to review, diff, and version independently from the prompt registry code.

Managed prompts currently include:

- search-query derivation
- grounded summary generation
- webhook alert enrichment
- news analysis
- secondary confidence enrichment
- Gemini market price fetch query

Behavior notes:

- **Fail-open by design**: if Langfuse is disabled, misconfigured, unavailable, or missing a prompt, the app automatically falls back to the local prompt text files in `src/services/prompts/defaults/`.
- **Label-based rollout**: use `LANGFUSE_PROMPT_LABEL` (for example `latest`, `staging`, or `production`) to switch prompt versions without code changes.
- **SDK caching**: prompt fetches use the Langfuse SDK cache and can be tuned with `LANGFUSE_PROMPT_CACHE_TTL_SECONDS`.
- **Current architecture contract**: prompts are compiled into the existing `systemPrompt` / `userPrompt` flow, so provider routing for Gemini, Azure, and OpenRouter remains unchanged.
- **Alert enrichment schema**: Langfuse `alert-enrichment` versions should mirror the local fallback's optional `invalidation_level`, `target_level`, `setup_type`, and `risk_reward_ratio` fields. The prompt service inspects resolved remote prompts against `REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS`, records `schemaDriftDetected: true` and missing risk fields if any are omitted, and warns once per version without failing open delivery.

#### Prompt-resolution telemetry (is Langfuse actually serving prompts?)

"Langfuse is configured and reachable" and "prompts are actually being served from Langfuse" are **two different facts**, and `/api/status` now reports them separately. Configuration readiness alone is not enough: if every prompt fetch silently falls back to the local files, readiness stays green, `/api/status` looks healthy, and a prompt improvement published to Langfuse would appear to succeed while changing nothing in production.

| Field | Meaning |
|---|---|
| `dependencies.langfuse` | Configuration/reachability only — `ENABLE_LANGFUSE_PROMPTS` plus the presence of both keys. Unchanged by design. |
| `dependencies.langfusePrompts.servingStatus` | Actual serving state. See the table below. |
| `dependencies.langfusePrompts.servingPrompts` | `true` only when at least one prompt has actually been served from Langfuse in this process. |
| `dependencies.langfusePrompts.localResolutionRatePercent` | Share of resolutions served from the local fallback. `100` means Langfuse served nothing. |
| `dependencies.langfusePrompts.remoteFetchSuccessRatePercent` | Remote fetch success rate, or `null` when no attempt has been recorded. |
| `dependencies.langfusePrompts.lastSuccessfulFetchAt` | `null` is the direct signal that Langfuse has never served a prompt. |
| `dependencies.langfusePrompts.lastErrorCategory` | Sanitized failure category from a closed enum — never raw provider error text. |
| `dependencies.langfusePrompts.prompts[]` | Per-prompt resolved source and the last Langfuse version actually served. |

`servingStatus` values:

| Value | Meaning |
|---|---|
| `disabled` | `ENABLE_LANGFUSE_PROMPTS` is not `true`; local fallbacks are expected. |
| `unconfigured` | Enabled, but `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` are missing. |
| `no_traffic` | Configured and reachable, but no prompt has been resolved yet — serving is genuinely **unknown**, not healthy. |
| `serving` | Every resolution came from Langfuse. |
| `degraded` | At least one resolution came from Langfuse and at least one fell back. |
| `local_fallback` | Remote is enabled and reachable but **every fetch has failed**, so no prompt has ever been served from Langfuse. |
| `unknown` | Fail-open value used when telemetry itself is unavailable. |

The payload contains counts, tiers, timestamps, and error categories only — remote prompt content, prompt variables, and credential material are never returned. Counters reset on process restart, and Langfuse unavailability still fails open to `src/services/prompts/defaults/` without ever blocking alert delivery.

#### Rollout check for prompt changes

Before trusting any prompt-driven change:

1. Deploy to preview and confirm `dependencies.langfusePrompts.servingStatus` reaches `serving` and `servingPrompts` is `true`. A `local_fallback` or `no_traffic` status means Langfuse is not actually serving anything yet.
2. Confirm the `production` label exists in Langfuse and that `LANGFUSE_PROMPT_LABEL` resolves to it. A missing label makes the SDK fall back to its default version or fail, which surfaces as `prompt_not_found`.
3. Align the remote `alert-enrichment` prompt with the local optional-risk schema (`invalidation_level`, `target_level`, `setup_type`, `risk_reward_ratio`, plus the evidence-calibration guidance). Otherwise `schemaDriftDetected` is `true` and `riskMetadataCoverage` in `GET /api/alerts/summary` will understate the schema the remote prompt can actually produce.
4. Only then promote the label and re-check `servingStatus` and `prompts[].lastLangfuseVersion` to confirm the new version is the one being served.
