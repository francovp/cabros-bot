# Research: Binance Spot Protective Orders

## Decisions and Evidence

### Spot contingent order types

The current Binance Spot REST API documents `STOP_LOSS` and `TAKE_PROFIT` as market-executed contingent orders, and `STOP_LOSS_LIMIT` and `TAKE_PROFIT_LIMIT` as limit-executed contingent orders. These names are distinct from Futures `*_MARKET` types. The Node `binance` dependency exposes `NewSpotOrderParams` with `stopPrice` and `trailingDelta` and has `submitNewOrderListOTOCO` and `getOCO` methods.

### Trailing delta

Binance Spot defines `trailingDelta` in BIPS. It supports the four Spot contingent order types, allows `stopPrice` to be omitted, and requires the value to satisfy a symbol-specific `TRAILING_DELTA` filter whose bounds vary by order direction/type. A global 0.1%-5% check would be incorrect, so the service must validate against the exchange filter.

### Bracket submission

Spot OTOCO is one order-list submission consisting of a LIMIT/LIMIT_MAKER working order and a pending OCO pair, which is placed only after the working order is fully filled. The documented limit-entry path maps to one `BRACKET_LIMIT` request and one Binance order-list request. Market-entry brackets are excluded.

### Idempotency and outcome ambiguity

Binance documents timeout and 5XX responses as potentially ambiguous. Existing service policy already forbids automatic resubmission after unknown outcomes and relies on stable client order IDs. Extend the same rule to the order-list identity. A Firestore transaction must reserve the hash of the idempotency key before submission; persistence outages fail closed for a live bracket.

### Verification surfaces

`src/openapi/openapi.json` is canonical; `CabrosBot.postman_collection.json` has a CI guard. Admin source must be changed in `src/admin/` and copied by `pnpm run build:hosting` to `public/admin/`.

## Official References

- Binance Spot [New order](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade#new-order-trade) documents Spot contingent types and fields.
- Binance [Spot Trailing Stop FAQ](https://developers.binance.com/en/docs/products/spot/faqs/trailing-stop-faq) defines BIPS, supported order types, optional stop price, and the per-symbol filter mapping.
- Binance Spot [New Order List - OTOCO](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/trade#new-order-list---otoco-trade) documents the working order, pending pair, and three-order filter accounting.
- Binance [Spot API Glossary](https://developers.binance.com/en/docs/products/spot/faqs/spot_glossary) defines OTOCO as a working order with an OCO pair that is placed after the working order fully fills.
- Binance [REST API general information](https://developers.binance.com/en/docs/products/spot/rest-api) documents unknown execution status on timeout/5XX and recommends querying status.

## Open Implementation Questions

- The installed lockfile currently resolves `binance@2.15.22` (not the older version mentioned in the issue). Confirm the exact method and response typing from the frozen install before coding.
- Check whether Firestore TTL is represented in this repository's deployable Firebase configuration. Runtime terminal transitions will set `expiresAt`; do not claim managed TTL is active unless a deployable policy exists and is applied.
- The SDK has no dedicated OTOCO test method in the inspected client surface. Use the existing `testNewOrder` path per component where required; the final native order-list submission remains the exchange validation and must not be retried when ambiguous.
