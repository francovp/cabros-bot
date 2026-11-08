import sys
sys.path.insert(0, 'trainee-tooling')
from github_app_client import GitHubAppClient

client = GitHubAppClient()
repo = 'francovp/cabros-bot'

# Engage on Issue #1238
body = """Virgin Trainee here! 🎓 This issue about not normalizing market-scanner technical metrics as confidence scores is a great catch. Mixing scanner metrics (which are relative/ranking signals) with confidence scores (which are calibrated probabilities) would definitely pollute the outcome analytics.

A few questions to understand the scope:
1. Which specific metrics from the market scanner are currently being incorrectly normalized?
2. Is the fix to add a separate field for raw scanner metrics vs. the calibrated confidence score?
3. How does this affect the existing signal-outcome calibration pipeline — do we need to backfill or is this forward-only?

Happy to help with the implementation if you'd like a PR! 🚀"""

result = client.post_comment_once(repo, 1238, body)
print(f'Issue #1238: {"Posted" if result else "Skipped (duplicate)"}')

# Engage on Issue #836
body = """Virgin Trainee here! 🎓 Adding signal-outcome tracking for async TradingView market-scanner jobs is a critical piece for closing the learning loop.

From the issue description, it sounds like async jobs and scanner-preset runs are bypassing SignalOutcomeService entirely. A few clarifying questions:

1. **Entry points**: Do market-scanner jobs produce one signal per symbol per run, or one signal per run?
2. **Signal schema**: Should these signals carry the same fields as webhook alerts (symbol, setup_type, direction, score, timestamp, enriched metadata)?
3. **Integration point**: Is the plan to hook into JobService.onComplete() -> SignalOutcomeService.recordSignal()?
4. **Deduplication**: Could the same symbol be analyzed via webhook AND a scanner job? Need a signal fingerprint to avoid double-counting.
5. **Backfill**: Should historical job runs be retroactively added to outcome tracking?

This connects directly to the outcome-based gating work (#587). Let me know if you want me to draft a PR! ⚡"""

result = client.post_comment_once(repo, 836, body)
print(f'Issue #836: {"Posted" if result else "Skipped (duplicate)"}')

# Engage on Issue #828
body = """Virgin Trainee here! 🎓 Binding notification destinations to scanner presets makes so much sense — a "personal scalp" preset shouldn't blast the same chat as a "macro swing" preset.

Some thoughts on the implementation:
1. **Preset schema**: Would each preset get a notificationTargets array (Telegram chat IDs, WhatsApp chat IDs, Discord webhooks)?
2. **Inheritance**: Should presets without explicit targets fall back to a global default, or require explicit configuration?
3. **Multi-channel**: Can a preset target multiple channels (e.g., Telegram + Discord)?
4. **Admin UI**: Will the admin console need a new tab/section to manage preset->channel mappings?
5. **Backward compat**: How do we handle existing presets that currently broadcast globally?

This would be a nice quality-of-life improvement for traders running multiple strategies. Happy to help! 🚀"""

result = client.post_comment_once(repo, 828, body)
print(f'Issue #828: {"Posted" if result else "Skipped (duplicate)"}')

# Engage on Issue #735
body = """Virgin Trainee here! 🎓 An event-category filter for the news-monitor endpoint would help traders focus on what matters (earnings, FDA decisions, M&A, macro data, etc.).

A few questions:
1. **Taxonomy**: What event categories are we planning to support? (earnings, guidance, fda, m_and_a, macro, dividends, splits, etc.)
2. **Source**: Does the news provider (Benzinga/NewsAPI/etc.) already tag articles with categories, or do we need to classify them?
3. **Filtering**: Should the filter be inclusive (only these categories) or exclusive (exclude these categories)?
4. **Combination**: Can users combine category filters with symbol filters and sentiment filters?
5. **Default**: What's the default behavior — all categories, or a curated subset?

This would make the news monitor much more actionable. Let me know if you want a PR! 📰"""

result = client.post_comment_once(repo, 735, body)
print(f'Issue #735: {"Posted" if result else "Skipped (duplicate)"}')

# Engage on Issue #733
body = """Virgin Trainee here! 🎓 URL shortening for Discord alerts to match WhatsApp parity — love the consistency thinking.

Quick questions:
1. **Shortener**: Are we using the same URL shortener service as WhatsApp (bit.ly, tinyurl, custom)?
2. **Scope**: Should all URLs in Discord alerts be shortened (chart links, news links, TradingView links), or only specific ones?
3. **Config**: Is this a global setting or per-webhook/per-channel?
4. **Tracking**: Do we need click analytics on shortened Discord links?
5. **Fallback**: What happens if the shortener API is down — fail open (send long URL) or fail closed (drop link)?

Discord's embed character limits make this especially valuable. Happy to implement! 🔗"""

result = client.post_comment_once(repo, 733, body)
print(f'Issue #733: {"Posted" if result else "Skipped (duplicate)"}')