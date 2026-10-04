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
- **Secondary Fallback Trade Plan**: When TradingView MCP supplies a price but its ATR-derived risk block is rejected (ATR `0`, non-finite, or a level failing the side/positivity check), the enrichment fills those three fields from the timeframe-based heuristic in `src/services/tradingview/fallbackTradePlan.js` and tags them `levelsSource: "fallback-trade-plan"`. A valid ATR-derived block always wins, and an invalid ATR is still never turned into a synthetic ATR stop. Heuristic levels are provenance-tagged precisely so downstream consumers can weigh them below real ATR levels.
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

### Sentiment score calibration

The `alert-enrichment` prompt scores `sentiment_score` against five fixed reference anchors — `0.90` multi-source major catalyst, `0.75` corroborated, `0.60` partial, `0.45` routine, `0.30` negligible — and must justify its choice in `sentiment_score_evidence` (bounded to 240 characters, omitted when absent). The previous rubric gave ranges (`0.9+`, `0.6-0.8`) but no reference point and no justification, which is how 87.6% of production scores ended up at or above 0.75 — a channel that cannot separate a high-conviction breakout from a routine entry.

`promptProvenance.schemaDriftDetected` reports `true` and `missingCalibrationGuidance` names `sentiment_score_evidence`, `0.90`, `0.60`, and `0.30` when a resolved prompt lacks them. The local fallback is inspected by the same function, so both surfaces stay in lockstep. Republish the remote prompt to clear the flag; the drift state never blocks alert delivery.

Whether the emitted scores are still spread out is measured, not assumed:

- `enrichment.sentimentCalibration` in `GET /api/alerts/summary` is the durable view, computed from stored alerts. See [Stored Alerts → Sentiment score calibration](alerts.md#sentiment-score-calibration).
- A process-local rolling window in `src/services/grounding/gemini.js` emits one structured `console.warn` per hour when it saturates, plus a recovery line on the state change. It is a fast early warning only: a restart clears the window, so it stays silent until it has enough fresh observations, and `minSamples` is what stops a cold process from declaring saturation.

### Zero-source sentiment cap

When grounding returns **no** sources there is no evidence for a confident score, so the effective `sentiment_score` is clamped to an absolute magnitude of `0.55` (`ZERO_SOURCE_SENTIMENT_SCORE_CAP` in `src/services/grounding/gemini.js`). The pre-cap value is preserved as `sentiment_score_raw` for auditing. The field appears only when the cap actually rewrote the score, so its presence is the proof that the cap ran.

To confirm the cap is live in the deployment you are querying, read `enrichment.sentimentCalibration.rawScoreCapCount` from the summary endpoint. Zero there means either no zero-source enriched alerts in the window, or a build that predates the cap.

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
- **Alert enrichment calibration**: the same inspection also checks the sentiment anchor markers (`sentiment_score_evidence`, `0.90`, `0.60`, `0.30`), reported separately as `missingCalibrationGuidance`. See [Sentiment score calibration](#sentiment-score-calibration).

> **Adding or changing a prompt?** Use the `langfuse-prompt-sync` skill to publish the new version/label. The local fallback under `src/services/prompts/defaults/` and the remote Langfuse prompt must carry the same anchors, or `schemaDriftDetected` stays `true` for the remote copy.

### Persisted Gemini-Grounding Entry Price (GH-599)

The alert-enrichment prompt can now extract an optional `current_price` (with optional `price_currency`) from grounded snippets. Values are validated to be finite positive numbers; any malformed entry is silently dropped (fail-open). When the field is present it propagates through `alert.enriched` and the stored alert document, and is mirrored as top-level `currentPrice` / `priceCurrency` on `GET /api/alerts` and the JSONL/CSV export records.

Outcomes-tracking benefits from this in two ways:

- `signalOutcomeService.recordSignal()` now treats a Gemini-grounding-sourced `current_price` as a valid entry-price fallback when TradingView MCP is absent — `priceSource` is set to `'gemini-grounding'` and `entryPriceSourceBreakdown` gains that bucket in `GET /api/outcomes/summary`, so BINANCE alerts stop landing in `missing_entry_price` whenever grounding returns a price.
- `AlertStorageService` deterministically derives `risk_reward_ratio` from `current_price`, `invalidation_level`, `target_level`, and the parsed signal `side` whenever the model omitted the ratio. The directional computation matches the trade side (`BUY` ⇒ `(target - entry) / (entry - invalidation)`, `SELL` ⇒ `(entry - target) / (invalidation - entry)`); positive numeric and non-empty string model ratios are preserved, and the new field `risk_reward_ratio_source: "computed"` only appears when we filled it in.

Both changes are purely additive. Existing alert-delivery behavior, MarkdownV2 formatting, and fail-open semantics remain unchanged; when grounding omits `current_price` nothing new is written and all existing fields stay untouched.

### Optional price fields and schema drift (GH-599)

`current_price` and `price_currency` are deliberately **excluded** from `REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS`. That set is what produces `schemaDriftDetected`, so including the price fields would flag every production Langfuse prompt still on the pre-GH-599 schema — the drift guard would punish correct behavior and make the flag useless as a rollout signal. The risk fields remain the drift contract; price fields are validated for shape only when present.

Note the asymmetry this creates, stated plainly in the API contract as well: `current_price` is the model's *reading* of grounded context, not a snippet-level price extraction, so it carries no field-level citation. Field-level citation alignment would require provider-level support and is out of scope for GH-599.
