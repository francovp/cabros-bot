# New TradingView MCP Features — Proposal

## Discovery Summary

I performed **live tool discovery** against `https://tradingview-mcp.onrender.com/mcp` and found **31 tools** available on the server. The bot currently uses only **1** (`coin_analysis`). This opens up significant opportunities.

## Available Tools on TradingView MCP Server

### Currently Used ✅
| Tool | Description | Used By |
|------|-------------|---------|
| `coin_analysis` | Detailed technical analysis for a specific asset | `expanded-analysis-alert`, alert enrichment |

### Unused — Market Screening 🔍
| Tool | Description | Params |
|------|-------------|--------|
| `top_gainers` | Top gainers by Bollinger Band analysis | `exchange`, `timeframe`, `limit` |
| `top_losers` | Top losers for an exchange | `exchange`, `timeframe`, `limit` |
| `bollinger_scan` | Squeeze detection (low BB Width) | `exchange`, `timeframe`, `bbw_threshold`, `limit` |
| `rating_filter` | Filter by Bollinger Band rating | `exchange`, `timeframe`, `rating`, `limit` |
| `consecutive_candles_scan` | Consecutive green/red candle patterns | `exchange`, `timeframe`, `pattern_type`, `candle_count`, `min_growth`, `limit` |
| `advanced_candle_pattern` | Multi-timeframe candle pattern analysis | `exchange`, `base_timeframe`, `pattern_length`, `min_size_increase`, `limit` |

### Unused — Volume Analysis 📊
| Tool | Description | Params |
|------|-------------|--------|
| `volume_breakout_scanner` | Volume + price breakout detection | `exchange`, `timeframe`, `volume_multiplier`, `price_change_min`, `limit` |
| `volume_confirmation_analysis` | Detailed volume confirmation for a specific coin | `symbol` (req), `exchange`, `timeframe` |
| `smart_volume_scanner` | Volume + technical analysis combo scanner | `exchange`, `min_volume_ratio`, `min_price_change`, `rsi_range`, `limit` |

### Unused — Multi-Agent & Combined 🤖
| Tool | Description | Params |
|------|-------------|--------|
| `multi_agent_analysis` | Multi-agent debate (Technical, Sentiment, Risk) | `symbol` (req), `exchange`, `timeframe` |
| `combined_analysis` | **POWER TOOL**: TradingView + Reddit sentiment + Financial news | `symbol` (req), `exchange`, `timeframe` |
| `multi_timeframe_analysis` | Multi-TF alignment (Weekly → Daily → 4H → 1H → 15m) | `symbol` (req), `exchange` |

### Unused — Backtesting 📈
| Tool | Description | Params |
|------|-------------|--------|
| `backtest_strategy` | Backtest with institutional-grade metrics | `symbol` (req), `strategy` (req), `period`, `initial_capital`, ... |
| `compare_strategies` | Run all 6 strategies and rank them | `symbol` (req), `period`, `initial_capital` |
| `walk_forward_backtest_strategy` | Walk-forward validation (overfitting detection) | `symbol` (req), `strategy` (req), `period`, ... |

### Unused — Yahoo Finance / Market Data 💰
| Tool | Description | Params |
|------|-------------|--------|
| `yahoo_price` | Real-time price from Yahoo Finance | `symbol` (req) |
| `market_snapshot` | Global market overview (indices, crypto, FX, ETFs) | _(none)_ |
| `bitcoin_market_pulse` | BTC macro context: price, dominance, risk assessment | _(none)_ |

### Unused — US Stock Options & Extended Hours 🏦
| Tool | Description | Params |
|------|-------------|--------|
| `stock_extended_hours` | Pre-market / after-hours prices | `symbol` (req) |
| `stock_options_chain` | Full options chain (calls + puts) | `symbol` (req), `expiry` |
| `stock_options_unusual_activity` | Institutional positioning via V/OI ratio | `symbol` (req), `top_n`, `min_volume`, `expiries` |

### Unused — Market Intelligence 📰
| Tool | Description | Params |
|------|-------------|--------|
| `market_sentiment` | Real-time Reddit sentiment analysis | `symbol` (req), `category`, `limit` |
| `financial_news` | RSS news from Reuters, CoinDesk, etc. | `symbol`, `category`, `limit` |

### Unused — EGX-Specific (Egyptian Exchange) 🇪🇬
| Tool | Description |
|------|-------------|
| `egx_market_overview` | EGX market overview |
| `egx_sector_scan` | EGX sector screening |
| `egx_sector_scanner` | EGX sector rotation scanner |
| `egx_index_analysis` | EGX index analysis |
| `egx_stock_screener` | EGX stock ranking engine |
| `egx_trade_plan` | EGX trade plan generator |
| `egx_fibonacci_retracement` | EGX Fibonacci retracement analysis |

---

## Proposed New Features

### Feature 1: Market Scanner Alert Endpoint (HIGH PRIORITY) ⭐

**New endpoint**: `POST /api/webhook/market-scanner-alert`

Uses the screening tools (`top_gainers`, `top_losers`, `bollinger_scan`, `volume_breakout_scanner`, `smart_volume_scanner`) to generate a periodic market scan report and send it through notification channels.

**Use case**: Scheduled call (e.g., via cron/TradingView alert) that scans Binance for breakout opportunities and sends a consolidated Telegram/WhatsApp alert.

**Request body**:
```json
{
  "exchange": "BINANCE",
  "timeframe": "4h",
  "scans": ["top_gainers", "top_losers", "bollinger_scan", "volume_breakout_scanner"],
  "limit": 5
}
```

**Report output** (Spanish, like existing reports):
```
📡 SCANNER DE MERCADO — Friday 23/05/2026

🟢 TOP GANADORES (BINANCE 4h)
1. SOLUSDT +8.5% | RSI 62 | Rating 4
2. ETHUSDT +3.2% | RSI 55 | Rating 3
...

🔴 TOP PERDEDORES (BINANCE 4h)
1. XRPUSDT -5.1% | RSI 28 | Rating -3
...

💥 BREAKOUT DE VOLUMEN
1. AVAXUSDT Vol 3.2x | +4.1% | RSI 58
...

🔥 SQUEEZE BOLLINGER (BBW < 0.05)
1. DOTUSDT BBW 0.03 | Precio $7.45
...
```

**Architecture**:
- New handler: `src/controllers/webhooks/handlers/marketScanner/marketScanner.js`
- New report builder: `src/services/tradingview/marketScannerReport.js`
- Add `callScanTool(toolName, params)` generic method to `TradingViewMcpService`
- Reuse `NotificationManager.sendToAll()` for delivery
- Feature-gated via `ENABLE_MARKET_SCANNER=true`

---

### Feature 2: Enhanced Expanded Analysis with Multi-Timeframe (HIGH PRIORITY) ⭐

**Upgrade existing** `POST /api/webhook/expanded-analysis-alert` to optionally include `multi_timeframe_analysis` data alongside `coin_analysis`.

**Use case**: When the expanded analysis runs for BTCUSDT on the 4h timeframe, also fetch the multi-TF alignment (Weekly → Daily → 4H → 1H → 15m) to show whether higher timeframes confirm or contradict the current signal.

**Request body** (backward-compatible — new optional field):
```json
{
  "symbols": ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"],
  "timeframe": "4h",
  "includeMultiTimeframe": true
}
```

**Report additions** (appended per symbol):
```
📊 ALINEACIÓN MULTI-TIMEFRAME (BTCUSDT)
- Semanal: Alcista (RSI 58)
- Diario: Alcista (RSI 52)
- 4H: Neutral (RSI 48)
- 1H: Bajista (RSI 38)
→ Confluencia: 2/4 alcista — Precaución en TF cortos
```

**Architecture**:
- Add `callMultiTimeframeAnalysis({ symbol, exchange })` to `TradingViewMcpService`
- Extend `analyzeSymbols()` in the expanded-analysis handler to optionally call `multi_timeframe_analysis` after `coin_analysis`
- Extend `buildExpandedAnalysisAlertReport()` to render multi-TF section
- Fail-open: if multi-TF call fails, still send the base report

---

### Feature 3: Volume Breakout Alerts (MEDIUM PRIORITY)

**Enhance existing** `POST /api/webhook/alert` to optionally add volume confirmation data when TradingView MCP enrichment is active.

**Use case**: When a TradingView signal arrives (e.g., "BTCUSDT(240) pasó a señal de COMPRA"), also call `volume_confirmation_analysis` to validate whether volume supports the signal.

**Architecture**:
- Add `callVolumeConfirmation({ symbol, exchange, timeframe })` to `TradingViewMcpService`
- In `enrichFromSignal()`, after `callCoinAnalysis()`, optionally call volume confirmation
- Add volume confidence to the enriched alert output (e.g., `"Volume confirms: YES (3.2x avg)"`)
- Feature-gated via `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`
- Fail-open: volume call failure doesn't block alert

---

### Feature 4: Combined Analysis Upgrade for Expanded Alert (MEDIUM PRIORITY)

**Replace or augment** `coin_analysis` with `combined_analysis` in the expanded-analysis-alert flow for richer reports.

**What `combined_analysis` adds over `coin_analysis`**:
- Reddit sentiment data
- Financial news integration
- All of `coin_analysis` technical data

**Architecture**:
- Add `callCombinedAnalysis({ symbol, exchange, timeframe })` to `TradingViewMcpService`
- New request param: `"analysisMode": "combined"` (default: `"standard"`)
- When `combined`, call `combined_analysis` instead of `coin_analysis`
- Extend report to include sentiment summary and news headlines section
- Backward-compatible: default behavior unchanged

---

### Feature 5: Market Snapshot Daily Digest (LOW PRIORITY)

**New endpoint**: `POST /api/webhook/market-snapshot` or a scheduled Telegram command `/mercado`

Uses `market_snapshot` + `bitcoin_market_pulse` to send a daily overview.

**Report output**:
```
🌐 RESUMEN DE MERCADO — 23/05/2026

₿ BITCOIN PULSE
Precio: $68,450 (+2.1% 24h)
Dominancia BTC: 54.2% | ETH: 17.8%
Market Cap Total: $2.45T (+1.8%)
Evaluación: ALT_FAVORABLE — Altcoins liderando con BTC estable

📈 ÍNDICES PRINCIPALES
S&P 500: 5,320 (+0.5%)
NASDAQ: 16,890 (+0.8%)
...

💱 CRIPTO TOP
BTC: $68,450 (+2.1%)
ETH: $3,890 (+3.2%)
SOL: $175 (+5.5%)
...
```

**Architecture**:
- Add `callMarketSnapshot()` and `callBitcoinMarketPulse()` to `TradingViewMcpService`
- New handler: `src/controllers/webhooks/handlers/marketSnapshot/marketSnapshot.js`
- Optionally wire as Telegram command `/mercado`
- Feature-gated via `ENABLE_MARKET_SNAPSHOT=true`

---

## User Review Required

> [!IMPORTANT]
> **Which features to build?** The 5 proposals are ranked by estimated value. Please indicate which ones you'd like me to implement, and I'll create detailed specs and tasks for each.

> [!IMPORTANT]
> **EGX tools**: The MCP server has 7 Egyptian Exchange (EGX) tools. These seem specific to one market. Should I include any EGX features, or skip them entirely?

> [!IMPORTANT]
> **Backtesting tools**: The server has 3 backtesting tools (`backtest_strategy`, `compare_strategies`, `walk_forward_backtest_strategy`). These could power a Telegram command like `/backtest BTCUSDT rsi 1y`. Want me to include a backtesting feature proposal?

> [!IMPORTANT]
> **Options tools**: The server has options chain and unusual activity tools for US stocks. These could power a `/opciones AAPL` command or an unusual activity alert. Relevant for your use case?

## Open Questions

1. **Scheduling**: For the Market Scanner (Feature 1) and Market Snapshot (Feature 5), do you want these to be **webhook-triggered** (called by an external scheduler like a cron job or TradingView alert) or should I also build an **internal scheduler** that runs them on a cron inside the bot?

2. **Exchange scope**: The screening tools support multiple exchanges (BINANCE, KUCOIN, MEXC, NASDAQ, NYSE, BIST, EGX). Should the scanner default to BINANCE only, or support multiple exchanges per scan?

3. **Priority order**: If you approve multiple features, which order should I implement them?

## Verification Plan

### Automated Tests
- Unit tests for each new MCP tool wrapper method
- Unit tests for report formatters
- Integration tests for new endpoint handlers with mocked MCP responses
- Run: `npm test -- tests/unit/<new-test-file>.test.js`

### Manual Verification
- Test new endpoints with `curl` against local dev server
- Verify Telegram/WhatsApp message formatting
- Test graceful degradation when MCP tools fail or timeout
