# Tasks: Binance Spot Protective Orders

## 1. Tests first

- [ ] Add unit cases for new Spot order field matrices and unsupported Futures types.
- [ ] Add unit cases for `TRAILING_DELTA` filter direction/range and stop-price omission.
- [ ] Add storage tests for permanent hashed reservations, same-payload replay, conflicting payload, and ambiguous state.
- [ ] Add storage tests for sanitized lifecycle details and one-hour terminal expiry.
- [ ] Add endpoint tests for one OTOCO submission, no duplicate retry, and lookup by order-list identifiers.
- [ ] Add admin client tests for bracket request construction and editable alert prefill.

## 2. Implementation

- [ ] Add `BinanceBracketOrderStorageService` with fail-closed transaction reservation and lifecycle persistence.
- [ ] Extend order normalization and static/dynamic filter validation for Binance Spot contingent types.
- [ ] Add `BRACKET_LIMIT` mapping to `submitNewOrderListOTOCO`; preserve one-call/no-retry behavior.
- [ ] Extend order reconciliation to use `getOCO` for order-list ID/client ID and persist leg reports.
- [ ] Expose static supported Spot order types in status/capabilities.
- [ ] Add limit-bracket form and safe latest-alert level suggestions to `src/admin/admin.js`.

## 3. Contracts and operations

- [ ] Update OpenAPI schemas, examples, success/error responses, and GET query variants.
- [ ] Update Postman collection with valid/invalid examples per new type.
- [ ] Update README, `.env.example` only if accurate without a new setting, and AGENTS entry points.
- [ ] Configure or document Firestore terminal detail TTL; never apply TTL to permanent reservations.
- [ ] Run `pnpm run build:hosting` and verify generated admin parity.

## 4. Verification and review

- [ ] Run focused unit, integration, OpenAPI/Postman, and admin parity suites.
- [ ] Run the full `pnpm test` suite and confirm the working tree remains test-clean apart from intended changes.
- [ ] Complete independent transaction-safety and general code review passes.
- [ ] Refresh issue/PR/CI/readiness evidence and follow the issue-automator merge and post-merge workflow.
