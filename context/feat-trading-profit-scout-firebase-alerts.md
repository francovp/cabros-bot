## Summary

Incorporate production Firebase alert telemetry analysis into the `/trading-profit-opportunity-scout` skill workflow and evidence requirements.

## Key Changes

### 🎯 Skill Enhancement

- Updated `.agents/skills/trading-profit-opportunity-scout/SKILL.md`:
  - Added hard rule and step to fetch stored production Firebase alerts from the target window (e.g. last 2 weeks) using Render deployment endpoints (`GET /api/alerts/summary`, `GET /api/alerts/export`, `GET /api/alerts`) authenticated via `WEBHOOK_API_KEY`.
  - Updated Workflow Step 1 to audit recent alert texts, exchange venue prefixes (`BATS:`, `BINANCE:`), symbol classification (`bySymbol`), enrichment insights, grounding sources, token usage, delivery results, and errors.
  - Added detection of entity hallucinations (e.g. `BATS:` exchange prefix confused with `BAT` crypto or `LSE:BATS` stock) and unparsed symbol indexing (`bySymbol: { unknown: ... }`).
  - Updated Workflow Step 3 to compare recent alerts against live TradingView data from TradingView MCP tools (`coin_analysis`, `combined_analysis`, `multi_timeframe_analysis`, `volume_confirmation_analysis`) or search grounding.
  - Updated Evidence Checklist and Issue Template to require production Firebase alert telemetry logs as empirical evidence.

## Technical Implementation

### File Modified

- `.agents/skills/trading-profit-opportunity-scout/SKILL.md`

## References

- Linked to GitHub Issues [#221](https://github.com/francovp/cabros-bot/issues/221) and [#222](https://github.com/francovp/cabros-bot/issues/222) filed during live telemetry inspection.

---

**Review Checklist:**

- [x] Skill instructions accurate and aligned with repository conventions
- [x] Render deployment alert endpoint contract and authentication documented
- [x] Evidence checklist includes production telemetry snippets
