# Quickstart: Binance Spot Protective Orders

## Single contingent order

The authenticated write still requires operator authorization and the existing `Idempotency-Key` header for a live order. Spot trailing delta is in BIPS and is bounded by Binance's `TRAILING_DELTA` filter for the symbol/type/side.

```http
POST /api/trading/binance/orders
Idempotency-Key: <stable-client-key>
Content-Type: application/json

{
  "symbol": "BTCUSDT",
  "side": "SELL",
  "type": "STOP_LOSS_LIMIT",
  "quantity": "0.001",
  "price": "64000",
  "stopPrice": "64100",
  "timeInForce": "GTC",
  "trailingDelta": 100,
  "dryRun": true
}
```

`dryRun` does not submit or create a durable live reservation. Remove it only in an explicitly approved live environment.

## Limit bracket

```http
POST /api/trading/binance/orders
Idempotency-Key: <stable-client-key>
Content-Type: application/json

{
  "symbol": "BTCUSDT",
  "side": "BUY",
  "type": "BRACKET_LIMIT",
  "quantity": "0.001",
  "price": "65000",
  "stopPrice": "62000",
  "stopLimitPrice": "61900",
  "takeProfitPrice": "70000",
  "timeInForce": "GTC",
  "dryRun": true
}
```

The native OTOCO working order must fill fully before Binance places the pending OCO pair. `BRACKET_MARKET` and Futures-only order type names are unsupported.

## Reconcile a bracket

```http
GET /api/trading/binance/orders?listClientOrderId=<returned-list-client-order-id>
```

or

```http
GET /api/trading/binance/orders?orderListId=<returned-order-list-id>
```
