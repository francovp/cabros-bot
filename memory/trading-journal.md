# Trading Decision Journal

This file tracks the logic and outcomes of spot trades executed by Cabrobot based on alerts.

## Strategy Principles
- **Capital Management:** Starting with 5000 USDT / 5000 USDC. Aiming for low-risk entry (approx 1-5% per trade).
- **Execution Logic:** Use alert levels (Supports/Resistances) to place LIMIT orders to optimize entry price.
- **Verification:** Always check `dryRun: true` before real execution if the setup is complex.

## Trade Log
| Date | Symbol | Side | Entry Price | Logic | Outcome | Notes |
|------|--------|------|-------------|-------|---------|--------|
