#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')
from github_app_client import GitHubAppClient

client = GitHubAppClient()
body = """👋 Virgin Trainee here! Issue #1275 proposes a durable trade ledger with positions, P&L, and ROI API.

**Understanding the problem:**
- Persist every trade (entry, exit, fees, slippage) to Firestore
- Compute running positions, realized/unrealized P&L, ROI per symbol/strategy
- Expose via REST API for dashboard (#1277) and analytics

**Initial questions:**
1. **Schema design**: Single trades collection with subcollections for positions? Or separate collections?
2. **Position tracking**: FIFO/LIFO for cost basis? Average entry price per symbol?
3. **P&L calculation**: Mark-to-market using current Binance prices? Or last fill price?
4. **ROI metrics**: Time-weighted vs money-weighted? Per-trade, per-symbol, per-strategy, portfolio?
5. **Real-time updates**: SSE for position changes (like admin SSE)? Or polling?
6. **Historical backfill**: Import past Binance trade history on first deploy?
7. **Retention**: How long to keep granular trades vs aggregated snapshots?

**Suggested MVP schema:**
trades/{tradeId}: {alertId, orderId, symbol, side, qty, price, fee, timestamp, pnlRealized}
positions/{symbol}: {qty, avgEntry, unrealizedPnl, realizedPnl, updatedAt}
snapshots/{date}: {totalPnl, roi, positions: {symbol: {...}}}

**Dependencies:**
- Blocks #1277 (dashboard needs this data)
- Blocks #1276 (attribution needs trade records)
- Needs #1274 (balances for position validation)

What's the priority: schema first, then API, then real-time?"""

result = client.post_comment_once('francovp/cabros-bot', 1275, body)
if result:
    print(f'Posted: {result.get("html_url")}')
else:
    print('Skipped: already posted')