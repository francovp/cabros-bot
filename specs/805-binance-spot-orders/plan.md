# Implementation Plan: Binance Spot Protective Orders

**Branch**: `805-binance-spot-orders` | **Date**: 2026-10-25 | **Spec**: [`spec.md`](spec.md)  
**Input**: GitHub issue #805

## Summary

Extend the existing operator-only Binance Spot order flow with supported contingent order types, BIPS-based trailing deltas, and a limit-entry bracket submitted as one native OTOCO order list. Preserve the existing trading gate, API authorization, idempotency middleware, risk controls, and audit path. A Firestore reservation keyed by the hash of the idempotency key prevents duplicate list submissions across replicas; a separate lifecycle record expires one hour after terminal state. Reconciliation uses Binance's order-list query and stable list client ID. Expose the capability in status, OpenAPI, Postman, operator documentation, and the existing admin console.

## Technical Context

**Language/Version**: Node.js 24 (project engine `>=24.18.0 <27`)  
**Primary Dependencies**: Express 4, `binance` from the frozen lockfile, Firebase Admin SDK 12  
**Storage**: Firestore (`binanceBracketOrders` and permanent `binanceBracketReservations`)  
**Testing**: Jest unit, integration, OpenAPI/Postman contract checks, admin hosting parity  
**Target Platform**: Render service and Firebase Hosting admin console  
**Project Type**: Single Node.js service with generated admin assets  
**Performance Goals**: Retain existing 10s request / 30s hard-timeout caps; no new retry loop  
**Constraints**: Live bracket reservation must fail closed; ambiguous exchange outcomes remain reserved and require reconciliation; values remain decimal strings; no new secrets or environment variables  
**Scale/Scope**: Existing Binance order endpoint, status projection, Firestore lifecycle record, and admin order form

## Constitution Check

- **Authorization**: Keep existing `admin.operator` and `validateApiKey` gates on order writes; no new public routes.
- **Transaction safety**: Reserve before exchange submission; never auto-retry an ambiguous OTOCO write; reconcile by stable list client ID.
- **Failure behavior**: Firestore reservation failure prevents live submission. Audit and status projections remain fail-open where they are today.
- **Durability**: Do not expire pending or partially filled bracket records. Keep a permanent hashed replay reservation; set detail TTL only after terminal transition.
- **Contracts**: Update OpenAPI, Postman request/response examples, README, and project entry-point docs for each new request variant.
- **Configuration**: No new environment variable; no Remote Config key is appropriate for a static order-type capability or trading/security policy.
- **Admin assets**: Modify `src/admin/`, then run `pnpm run build:hosting` and verify parity with `public/admin/`.
- **Testing**: Add failing unit/endpoint/admin-contract tests before implementation and run focused tests plus the required full project suite before completion.

## Design Decisions

1. Use Binance Spot `STOP_LOSS`, `STOP_LOSS_LIMIT`, `TAKE_PROFIT`, and `TAKE_PROFIT_LIMIT` for contingent/trailing requests. `trailingDelta` is in BIPS, is optional alongside `stopPrice`, and must satisfy the symbol-specific `TRAILING_DELTA` filter for order type and side. Do not expose Futures-only `TRAILING_STOP_MARKET`, `STOP_LOSS_MARKET`, or `TAKE_PROFIT_MARKET`.
2. Implement `BRACKET_LIMIT` with one native Spot OTOCO request: a LIMIT working order plus a pending LIMIT_MAKER (BUY entry) or TAKE_PROFIT_LIMIT (SELL entry) take-profit leg and a STOP_LOSS_LIMIT protective leg. Do not implement `BRACKET_MARKET`, because Spot OTOCO requires a LIMIT or LIMIT_MAKER working order.
3. Derive bounded Binance `listClientOrderId` and component client order IDs from the idempotency key and normalized request. Persist only a SHA-256 key hash and request fingerprint.
4. Keep permanent idempotency reservations separate from bracket detail records so one-hour detail expiry cannot re-enable a replay. A reservation created before an exchange call stays nonterminal until reconciliation proves an exchange outcome.
5. Reuse the existing `GET /api/trading/binance/orders` route with exactly one of `orderId`, `origClientOrderId`, `orderListId`, or `listClientOrderId`; no new route mount is required.
6. Apply existing request validation, pause state, symbol allow-list, exchange-info filters, notional cap, and single-order test endpoint to all OTOCO legs where applicable. Since Binance exposes no OTOCO test endpoint, validate every component through `testNewOrder` when required and keep Binance's single final OTOCO submission authoritative.
7. Preserve legacy MARKET/LIMIT client-order ID fingerprints. Reconcile durable bracket reservations before current symbol, notional, or exchange-filter gates. For market-executed contingent BUYs, include a fixed trigger price in the notional estimate and reject trailing-only requests whose exposure cannot be bounded.

## Project Structure

```text
src/services/trading/BinanceOrderService.js          # normalize, validate, submit and reconcile Spot requests
src/services/trading/BinanceBracketOrderStorageService.js # durable reservation and lifecycle details
src/controllers/trading/binanceOrders.js             # existing order endpoint contract
src/controllers/status.js                             # supported order type projection
src/admin/admin.js                                    # source admin bracket form and alert level prefill
src/openapi/openapi.json                              # canonical HTTP contract
CabrosBot.postman_collection.json                     # operator examples
tests/unit/binance-order-service.test.js
tests/unit/binance-bracket-order-storage.test.js
tests/integration/binance-orders-endpoint.test.js
tests/unit/admin-client.test.js
tests/unit/postman-collection.test.js
```

**Structure Decision**: Keep execution in the existing order service and isolate the new Firestore transaction/lifecycle rules in a focused storage service. Reuse current controller routes and admin module; no new package or environment variable is required.

## Implementation Sequence

1. Add failing service tests for the contingent order field matrix, BIPS/filter validation, unsupported types, and stable identity.
2. Add failing storage tests for durable reservation conflicts, existing-reservation replay, sanitized order-list detail, nonterminal retention, and terminal expiry.
3. Add failing endpoint tests for OTOCO validation, operator protection, single submission, status reconciliation, and ambiguous outcomes.
4. Implement the storage service and integrate live bracket reservation, order-list submit, and order-list query in `BinanceOrderService`.
5. Extend status/capability and admin form/client behavior; keep alert-level prefill editable and require explicit operator submission.
6. Update OpenAPI, Postman, README, `.env.example`, and AGENTS entry points. Add Firestore TTL field configuration only if the repository's deployable Firestore configuration supports it; otherwise document the required managed TTL policy and do not claim it is deployed.
7. Build hosting output, run focused tests and contract guards, then full `pnpm test`; run two independent review passes and the issue-automator PR readiness workflow.

## Complexity Tracking

No constitution exception. The two Firestore records are required because the user-approved policy needs expiring lifecycle detail and a permanent replay barrier at the same time.
