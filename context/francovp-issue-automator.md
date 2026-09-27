# feat(contracts): align TradingView price fields across alert contracts (CB-205)

## Summary

Declare the `current_price` and `price_data` fields returned by MCP-enriched alert responses in the checked-in TypeScript contracts, the OpenAPI schema, the Postman collection examples, and README, so generated clients and operators can rely on them.

## Key Changes

- Added `current_price: number | null` and optional `price_data` (`PriceData`) to `EnrichedAlert` in `src/controllers/webhooks/handlers/alert/types.ts` and `src/services/grounding/types.ts`.
- Documented `current_price` and `price_data` in the OpenAPI `DeliveryResult.payload.enrichedData` schema (`src/openapi/openapi.json`).
- Extended the Postman "Dry run - full/partial TradingView enrichment" response examples with realistic `current_price` and `price_data` values.
- README now documents both fields as part of the MCP enrichment payload.

## Technical Implementation

No runtime behavior changed: `mergeEnrichmentData()` already returns `current_price` and conditional `price_data`, and dry-run responses pass `alert.enriched` through verbatim. The change is contract/documentation alignment only, per GH-462 acceptance criteria.

## Testing

- New integration test asserts a TradingView dry-run response exposes both fields when MCP enrichment supplies them (`tests/integration/alert-tradingview-mcp.test.js`).
- New OpenAPI contract test asserts the schema documents both fields (`tests/unit/openapi-contract.test.js`).
- New Postman contract test asserts the executable example includes both fields (`tests/unit/postman-collection.test.js`).
- Focused suites: `openapi-contract`, `postman-collection`, `alert-handler`, `alert-tradingview-mcp`, `alert-storage-service`, `openapi-docs` — all passing.

## References

- GitHub issue: https://github.com/francovp/cabros-bot/issues/462
- PR #436 review discussion: https://github.com/francovp/cabros-bot/pull/436#discussion_r3834606660
- **Linear**: [CB-205](https://linear.app/knil/issue/CB-205/align-tradingview-price-fields-across-alert-contracts-gh-462)
