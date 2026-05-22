# TradingView Alert Endpoint Design

**Goal:** Add a POST endpoint that generates an expanded technical-analysis alert from TradingView MCP data, sends it through the existing notification channels, and returns delivery results.

**Endpoint:** `POST /api/tradingview-alert`

**Request Body:**

```json
{
  "symbols": ["BINANCE:BTCUSDT", "NASDAQ:NVDA"],
  "timeframe": "1D"
}
```

**Configuration:**

- `TRADINGVIEW_ALERT_SYMBOLS`: comma-separated fallback symbol list, using `EXCHANGE:SYMBOL` entries.
- `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME`: fallback timeframe when the request omits `timeframe`; default `1D`.
- `TRADINGVIEW_MCP_URL`: remote MCP endpoint; default `https://tradingview-mcp.onrender.com/mcp`.
- `TRADINGVIEW_MCP_TIMEOUT_MS` and `TRADINGVIEW_MCP_MAX_RETRIES`: reuse existing MCP timeout/retry controls.

**Validation:**

- `symbols` must be an array of strings in `EXCHANGE:SYMBOL` form.
- If body symbols are missing or empty, use `TRADINGVIEW_ALERT_SYMBOLS`.
- If neither source provides symbols, return `400 NO_SYMBOLS`.
- Symbols are passed to MCP as provided after splitting exchange and symbol. The endpoint does not add crypto quote suffixes.

**Data Flow:**

1. Validate API key with the existing `validateApiKey` middleware.
2. Parse symbols and timeframe.
3. Call TradingView MCP `coin_analysis` once per symbol.
4. Convert successful MCP responses into report rows.
5. Group rows by RSI:
   - RSI `< 25`: sobresvendidos extremos.
   - RSI `>= 25 && < 35`: sobresvendidos.
   - RSI `>= 35 && <= 70`: neutros.
   - RSI `> 70`: sobrecomprados.
6. Build Spanish Markdown report text.
7. Send `{ text: report }` through the existing `NotificationManager`.
8. Return JSON with `success`, `alertText`, per-symbol `results`, delivery `deliveryResults`, `summary`, `requestId`, and `totalDurationMs`.

**Failure Behavior:**

- Per-symbol MCP failures are included in `results` with status `error` and omitted from the sent report.
- If all symbols fail, return `502 ALL_SYMBOLS_FAILED` and do not send notifications.
- If notification services are not initialized, initialize them with the route bot/getter like existing alert endpoints.

**Formatting Rules:**

- The report title is `📊 *ANÁLISIS AMPLIADO — <weekday> <DD/MM/YYYY>*`.
- Each group renders `No hay.` when empty.
- Rows include price, percent change, RSI, SMA20 trend, MACD direction, volume label, optional ATR, stop-loss suggestion, and action suggestion.
- ATR is included only if MCP returns an ATR-like field; it is not invented.
