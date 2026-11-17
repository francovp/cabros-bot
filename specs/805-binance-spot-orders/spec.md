# Feature Specification: Binance Spot Protective Orders

**Feature Branch**: `805-binance-spot-orders`  
**Created**: 2026-10-25  
**Status**: Approved for implementation  
**Input**: GitHub issue #805 and its owner-approved Spot-native scope

## User Scenarios & Testing

### User Story 1 - Place Spot contingent orders (Priority: P1)

An operator submits a protected Binance Spot order through the existing authenticated order endpoint. Supported Spot order types are validated against the exchange symbol and Binance filters before the single submission call.

**Why this priority**: Contingent orders let an operator encode the stop level and execution price in the same protected, audited flow as existing orders.

**Independent Test**: Unit and endpoint tests validate valid and invalid Spot contingent requests, ensure testnet/dry-run behavior, and assert the exchange receives the exact normalized request only after all existing risk gates pass.

**Acceptance Scenarios**:

1. **Given** Spot trading is enabled and the operator submits `STOP_LOSS_LIMIT` with quantity, stop price, limit price, and time-in-force, **When** symbol and exchange filters pass, **Then** the service makes one order submission with the stable client order ID.
2. **Given** a contingent order omits a required field or uses an unsupported generic Futures order type, **When** the request is validated, **Then** it returns `400 INVALID_ORDER_REQUEST` without an exchange write.
3. **Given** `trailingDelta` is supplied, **When** the symbol's `TRAILING_DELTA` filter does not allow it for the order side/type, **Then** the request is rejected before submission.

### User Story 2 - Submit a limit-entry OTOCO bracket (Priority: P1)

An operator submits one `BRACKET_LIMIT` request. Binance receives one native Spot OTOCO order list with a LIMIT working order and the paired stop/take-profit orders. BUY entries use a pending-above `LIMIT_MAKER` target and pending-below `STOP_LOSS_LIMIT`; SELL entries use a pending-above `STOP_LOSS_LIMIT` and pending-below `TAKE_PROFIT_LIMIT`. The pending pair is armed only after the working order fills.

**Why this priority**: One exchange-side order-list request avoids a client-managed multi-call saga and its partial-submit ambiguity.

**Independent Test**: Unit and integration tests verify request mapping, stable list/leg client IDs, single submission, Firestore reservation and detail persistence, and status reconciliation.

**Acceptance Scenarios**:

1. **Given** a valid BUY or SELL `BRACKET_LIMIT` request with entry, stop, take-profit, quantity, and time-in-force, **When** it is submitted, **Then** the response includes the Binance order-list ID and all three component order reports with the documented side-specific pending order types.
2. **Given** the same idempotency key and normalized request are retried, **When** Binance or durable state can reconcile the order list, **Then** the existing list is returned and no second order-list submission occurs.
3. **Given** a durable reservation exists for a different request fingerprint, **When** the same idempotency key is reused, **Then** the API returns `409 BINANCE_ORDER_CONFLICT` without an exchange write.
4. **Given** Binance's submission result is ambiguous, **When** a retry arrives, **Then** the service reconciles using the stable list client ID and never submits a second list while status is unknown.

### User Story 3 - Inspect a bracket and its lifecycle (Priority: P2)

An operator retrieves an order list using the existing orders query and can inspect the working and pending legs. Nonterminal order detail remains available; terminal detail expires one hour after the terminal transition while its hashed reservation remains permanent.

**Why this priority**: Operators need to determine whether a bracket is pending, active, filled, canceled, expired, or in an ambiguous state before deciding what to do next.

**Independent Test**: Endpoint tests cover lookup by list ID/client list ID and response errors; service tests cover retention transitions and sanitized Firestore records.

**Acceptance Scenarios**:

1. **Given** an order-list ID or list client ID, **When** an operator calls `GET /api/trading/binance/orders`, **Then** the service returns the order-list status and leg reports.
2. **Given** all component orders become terminal, **When** the lifecycle record is updated, **Then** `expiresAt` is set to one hour after terminal time and the permanent reservation remains.
3. **Given** Firestore cannot reserve a live bracket, **When** the request is processed, **Then** the service fails closed before submitting to Binance.

### User Story 4 - Operate brackets from the admin console (Priority: P2)

An operator can create a bracket from `/admin`, review the order preview and risk values, and use the latest matching alert's stop/target levels as editable defaults.

**Why this priority**: A structured form reduces manual transcription while keeping the operator in control of the actual order parameters.

**Independent Test**: Admin client tests verify the form uses existing authenticated APIs, rejects incomplete input, and treats prefilled alert levels as editable suggestions rather than implicit submission consent.

**Acceptance Scenarios**:

1. **Given** a recent alert for the selected symbol has stop/target metadata, **When** the operator opens the bracket form, **Then** those values are prefilled but not submitted automatically.
2. **Given** no matching alert metadata exists, **When** the form is opened, **Then** the operator can enter levels manually and must confirm the final request.

## Edge Cases

- Binance supports `trailingDelta` on Spot contingent types, not the Futures-named `TRAILING_STOP_MARKET`; delta is in BIPS and must satisfy the side/type-specific symbol filter.
- Spot OTOCO requires a LIMIT or LIMIT_MAKER working order; `BRACKET_MARKET` is excluded.
- A full working-order fill arms the pending OCO pair; a partial fill does not.
- A Firestore timeout during reservation or result persistence must not permit a duplicate submission on retry.
- A crash after reserving but before calling Binance may leave a durable pending reservation. This fails closed for safety; an operator can reconcile and resolve it.
- Firestore may reject undefined fields; persisted order data must be sanitized and SDK Timestamp/FieldValue instances preserved.
- Existing preview, maximum-notional, exchange filter, dynamic order test, environment gate, and trading pause checks apply to every newly supported request shape.
- An idempotency reservation stores only hashes and order identity/status data, never the raw key or credentials.

## Requirements

### Functional Requirements

- **FR-001**: The authenticated order API MUST support the Spot order types `MARKET`, `LIMIT`, `LIMIT_MAKER`, `STOP_LOSS`, `STOP_LOSS_LIMIT`, `TAKE_PROFIT`, and `TAKE_PROFIT_LIMIT`, subject to the symbol's allowed order types.
- **FR-002**: The API MUST enforce per-type required fields and reject unsupported Futures-only order types.
- **FR-003**: The API MUST support `trailingDelta` in BIPS only when the symbol's `TRAILING_DELTA` filter permits the value for the selected type and side; optional `stopPrice` retains Binance's documented trigger behavior.
- **FR-004**: The API MUST support `BRACKET_LIMIT` through one Binance Spot OTOCO order-list submission with a LIMIT working order and one pending OCO pair. `BRACKET_MARKET` is out of scope because Spot OTOCO requires LIMIT or LIMIT_MAKER.
- **FR-005**: Live bracket submissions MUST require a stable idempotency key, use deterministic list and component client IDs, and reserve the idempotency key durably before the exchange call.
- **FR-006**: A repeated key with a matching payload MUST reconcile or return the existing order list; a mismatched payload MUST return a conflict; ambiguous exchange outcomes MUST never trigger a second submit automatically.
- **FR-007**: The service MUST persist bracket detail and the parent/leg relationship. Pending and partially filled records MUST have no expiry; once terminal, details MUST expire one hour after that transition. A permanent hash-only reservation MUST remain to prevent duplicate submission after detail expiry.
- **FR-008**: The existing `GET /api/trading/binance/orders` operation MUST support lookup by `orderListId` or `listClientOrderId` and return the order-list response.
- **FR-009**: `/api/status` and `/api/capabilities` MUST expose the supported Spot order types without exposing credentials.
- **FR-010**: `/admin` MUST provide an operator-only limit-bracket form and may prefill editable prices from the latest matching alert summary.
- **FR-011**: Existing API-key/admin authorization, kill-switch, configured environment, notional cap, order-test, filter, audit, timeout, and no-retry guarantees MUST remain in force.
- **FR-014**: Market-executed contingent BUYs MUST validate notional at `quantity × max(averagePrice, stopPrice)` and reject trailing-only BUYs without a fixed trigger price; limit-executed contingent orders MUST use their limit price.
- **FR-012**: OpenAPI, Postman, README, `.env.example`, project entry-point documentation, and admin hosting output MUST describe the supported request variants and errors.
- **FR-013**: No new environment variable is introduced. The order type list is static product capability, not runtime tuning, so no Remote Config schema key is eligible.

### Key Entities

- **Bracket Reservation**: Permanent document keyed by a SHA-256 idempotency-key digest; records a request fingerprint, stable list identity, status, and timestamps without the raw idempotency key.
- **Bracket Order Detail**: Lifecycle document containing environment, symbol, normalized bracket parameters, Binance list identity, component order IDs/reports, status, and optional terminal `expiresAt`.
- **OTOCO Order List**: Binance Spot list with one working LIMIT order and two pending OCO orders; the order list is the atomic exchange submission unit.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every supported request is rejected before exchange write when its fields, symbol filters, auth, trading gate, or notional limit fail.
- **SC-002**: One accepted `BRACKET_LIMIT` request results in exactly one Binance OTOCO submission; matching retries produce no additional submission.
- **SC-003**: A bracket can be reconciled by list ID or deterministic list client ID, and its leg reports are persisted without raw credentials or idempotency keys.
- **SC-004**: Repository contract guards pass with OpenAPI and Postman examples for valid and invalid new variants.
- **SC-005**: The generated public admin bundle matches `src/admin/` after `pnpm run build:hosting`.
