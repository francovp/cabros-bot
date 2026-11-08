# Binance Orders API Contract Changes

## `POST /api/trading/binance/orders`

Retains existing operator auth, trading gate, pause state, idempotency middleware, dry-run, timeout, and error envelope.

### Supported type values

`MARKET`, `LIMIT`, `LIMIT_MAKER`, `STOP_LOSS`, `STOP_LOSS_LIMIT`, `TAKE_PROFIT`, `TAKE_PROFIT_LIMIT`, `BRACKET_LIMIT`.

For a contingent single order, Binance Spot fields are used: `STOP_LOSS`/`TAKE_PROFIT` require quantity and either `stopPrice` or `trailingDelta`; `STOP_LOSS_LIMIT`/`TAKE_PROFIT_LIMIT` also require `price` and `timeInForce`. `trailingDelta` is an integer BIPS value and must meet the symbol's filter. Futures names such as `TRAILING_STOP_MARKET` are rejected.

For market-executed contingent BUYs, validate configured notional against `quantity × max(averagePrice, stopPrice)`. Reject trailing-only BUYs without a fixed `stopPrice`; limit-executed contingent orders use their limit `price`. Market execution may slip beyond the trigger after validation.

For `BRACKET_LIMIT`, require `quantity`, entry `price`, `stopPrice`, `stopLimitPrice`, `takeProfitPrice`, and `timeInForce`. Submit one OTOCO order list. BUY entries use a pending-above `LIMIT_MAKER` take-profit and pending-below `STOP_LOSS_LIMIT`; SELL entries use a pending-above `STOP_LOSS_LIMIT` and pending-below `TAKE_PROFIT_LIMIT` with the target as both trigger and limit price.

### `GET /api/trading/binance/orders`

Exactly one identifier is required: `orderId`, `origClientOrderId`, `orderListId`, or `listClientOrderId`. The order-list selectors return the sanitized Binance order-list record with all component orders/reports.

## Error behavior

- `400 INVALID_ORDER_REQUEST`: malformed fields, unsupported type, unsupported field combination, invalid trailing filter value, contingent market BUY without a fixed `stopPrice`, or a notional estimate over the configured cap.
- `403 FEATURE_DISABLED` / authorization errors: existing behavior.
- `409 BINANCE_ORDER_CONFLICT`: key reused with different normalized payload or a reconciled exchange identity mismatch.
- `503 STORAGE_UNAVAILABLE`: live bracket reservation storage unavailable; no exchange write is made.
- `503 BINANCE_ORDER_STATUS_UNKNOWN`: ambiguous submission cannot be reconciled; keep the stable key and query status before deciding.
- `502 BINANCE_ORDER_FAILED`: definitive exchange rejection or unexpected provider failure, per existing envelope.

## Examples

Postman and OpenAPI must include one valid and one invalid example for each newly supported type. Responses must use string decimals and sanitized order/list identity only.
