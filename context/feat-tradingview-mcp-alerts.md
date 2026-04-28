# feat(tradingview): add mcp alert flow

## Summary

Adds TradingView MCP-based technical enrichment to webhook alerts. The system now detects TradingView-like signals in incoming alert text and augments enrichment context using MCP `coin_analysis` data, while preserving graceful fallback behavior.

## Key Changes

### 📈 TradingView signal parsing and MCP integration

- Added TradingView signal parser to extract symbol, timeframe, and side from texts like `BTCUSDT(240) pasó a señal de VENTA`.
- Added `TradingViewMcpService` to call MCP endpoint with configurable timeout/retries and normalize technical output.
- Integrated TradingView MCP context into webhook grounding/enrichment pipeline without breaking existing Gemini/Brave flow.

### 🧩 Alert pipeline updates

- Updated alert webhook flow to optionally include MCP technical enrichment when enabled.
- Kept fail-open behavior: if MCP or grounding fails, delivery still proceeds with available context/original text.
- Added runtime configuration support for TradingView MCP defaults and endpoint settings.

### 🧪 Test and docs updates

- Added unit tests for parser and TradingView MCP service.
- Added integration test coverage for TradingView MCP enrichment path.
- Updated README and `.env.example` with feature behavior and configuration.

## Technical Implementation

### Architecture changes

#### `src/services/tradingview/parseTradingViewSignal.js`

Parses TradingView-style webhook strings into structured signal input for enrichment.

#### `src/services/tradingview/TradingViewMcpService.js`

Encapsulates MCP HTTP calls, retry/timeout handling, and technical payload extraction.

#### `src/controllers/webhooks/handlers/alert/grounding.js`

Extends enrichment orchestration to merge TradingView MCP technical context with grounding output.

#### `src/controllers/webhooks/handlers/alert/alert.js`

Consumes updated enrichment output and keeps multi-channel delivery contract unchanged.

### File Structure Additions

```text
.github/agents/
└── github-pr-agent.personal.agent.md     # Personal PR agent mode definition

.vscode/
└── mcp.json                              # Local MCP tool configuration

src/services/tradingview/
├── TradingViewMcpService.js              # MCP client wrapper for TradingView data
└── parseTradingViewSignal.js             # TradingView signal parser

tests/unit/
├── tradingview-mcp-service.test.js       # Unit tests for MCP service
└── tradingview-signal-parser.test.js     # Unit tests for signal parsing

tests/integration/
└── alert-tradingview-mcp.test.js         # Integration tests for webhook enrichment path
```

## Testing infrastructure

### Test Suite

- **32 total Jest suites executed**
- **380 total tests passed**

### Test Files

- `tests/integration/alert-tradingview-mcp.test.js`: end-to-end MCP enrichment behavior for webhook alerts.
- `tests/unit/tradingview-mcp-service.test.js`: MCP request/retry/timeout and response mapping behavior.
- `tests/unit/tradingview-signal-parser.test.js`: TradingView signal parsing coverage.
- `tests/unit/alert-handler.test.js`: updated webhook handler assertions for enrichment integration.

## Configuration Updates

### Environment Variables

```bash
ENABLE_TRADINGVIEW_MCP_ENRICHMENT=false
TRADINGVIEW_MCP_URL=http://localhost:8000/mcp
TRADINGVIEW_MCP_TIMEOUT_MS=12000
TRADINGVIEW_MCP_MAX_RETRIES=3
TRADINGVIEW_MCP_DEFAULT_EXCHANGE=BINANCE
TRADINGVIEW_MCP_DEFAULT_TIMEFRAME=1h
```

## Documentation Updates

- **README**: Added TradingView MCP enrichment feature overview, flow, and configuration details.
- **.env.example**: Added TradingView MCP configuration block and defaults.

## Examples

When webhook receives:

- `BTCUSDT(240) pasó a señal de VENTA`

And TradingView MCP enrichment is enabled, alert enrichment includes MCP technical analysis context (exchange/timeframe-normalized data) before sending to enabled channels.

## Breaking Changes

- None.

## Testing

### Pre-merge Verification

- [ ] `npm test` passes (verified in this branch)
- [ ] `npm run lint` baseline review completed (repository has existing lint baseline errors outside this change scope)
- [ ] Validate MCP endpoint connectivity in target environment

### Post-merge Verification

- [ ] Trigger `/api/webhook/alert` with a TradingView-like signal and confirm enriched output
- [ ] Confirm Telegram/WhatsApp delivery remains successful with MCP disabled/enabled

## References

- Repository: [francovp/cabros-bot](https://github.com/francovp/cabros-bot)

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
