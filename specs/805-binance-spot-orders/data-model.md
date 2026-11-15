# Data Model: Binance Spot Brackets

## Binance Spot OTOCO

One live bracket maps to a single Binance order list:

- `workingOrder`: one LIMIT entry order with `workingSide`, `workingPrice`, `workingQuantity`, and `workingTimeInForce`.
- `pendingAbove` / `pendingBelow`: the pending OCO legs with the same closing side and quantity. For BUY entries, the take-profit limit is above and the stop-limit is below; for SELL entries the stop-limit is above and the take-profit limit is below.
- `listClientOrderId`: stable bounded client identity used to query the order list after retries or ambiguous responses.
- `workingClientOrderId`, `pendingAboveClientOrderId`, and `pendingBelowClientOrderId`: stable component identities.

The request requires `symbol`, `side`, `quantity`, `price`, `stopPrice`, `stopLimitPrice`, `takeProfitPrice`, and `timeInForce`. The stop trigger and stop-limit execution price remain separate values. For BUY entries, the take-profit uses pending-above `LIMIT_MAKER`; for SELL entries, it uses pending-below `TAKE_PROFIT_LIMIT` with `takeProfitPrice` as both its trigger and limit price.

## `binanceBracketReservations/{sha256(idempotencyKey)}`

Permanent replay barrier. Fields:

- `keyHash`: SHA-256 digest used as document identity (do not store the original key).
- `requestFingerprint`: SHA-256 of normalized order fields.
- `listClientOrderId`, `symbol`, `environment`.
- `state`: `RESERVED`, `SUBMITTED`, `AMBIGUOUS`, `REJECTED`, or `COMPLETED`.
- `orderListId`: nullable Binance list ID.
- `createdAt`, `updatedAt`: Firestore-supported timestamps.
- `terminalAt`, `expiresAt`: set once the bracket becomes terminal so later reconciliation cannot extend the original detail-retention window.
- `errorCode`: sanitized fixed code for definitive rejection only.

No TTL field is set on this collection. Transactional create semantics prevent a second process from claiming the same idempotency key. Reusing a key with another fingerprint is a conflict.

## `binanceBracketOrders/{environment}_{sha256(listClientOrderId).slice(0,32)}`

Inspectable lifecycle detail:

- `environment`, `symbol`, `side`, `type: BRACKET_LIMIT`, `quantity`, entry/stop/target decimal strings.
- `orderListId`, `listClientOrderId`, the three component client/order IDs, normalized `orderReports`, and list status.
- `requestFingerprint`, `createdAt`, `updatedAt`, `terminalAt`.
- `expiresAt` is absent while any component is pending or partially filled; set to `terminalAt + 1h` once every component is terminal.

Sanitize undefined values before every write. Preserve Firestore `Timestamp` and `FieldValue` instances. Never store API credentials, raw request authentication, or raw idempotency keys.
