# Copilot Instructions

## API Orientation

- Routes are mounted under `/api` in `src/routes/index.js`.
- Webhook-style write endpoints stay behind `validateApiKey` in `src/lib/auth.js`.
- Stored alert reads now live at:
  - `GET /api/alerts`
  - `GET /api/alerts/:alertId`

## Stored Alerts

- `src/services/storage/AlertStorageService.js` owns the Firestore boundary for alert persistence and reads.
- `saveAlert()` stays fail-open and fire-and-forget after the webhook response.
- Read endpoints should map Firestore initialization/read failures to `503 STORAGE_UNAVAILABLE` instead of a generic `500`.
- `listAlerts()` and `getAlertById()` format Firestore documents into API-safe JSON with:
  - `id`
  - `receivedAt`
  - `text`
  - `enriched`
  - `enrichmentData`
  - `tokenUsage`
  - `deliveryResults`
  - `source`
  - `useTradingViewData`
- Read filtering for `source` and `enriched` is applied in memory after `receivedAt`-ordered batches so the feature does not depend on new composite Firestore indexes.

## Testing Pattern

- Endpoint contract tests: `tests/integration/alerts-endpoint.test.js`
- Firestore read/write unit coverage: `tests/unit/alert-storage-service.test.js`
- When extending the alerts read API, preserve `receivedAt` as the primary sort key but encode `nextBefore` with a deterministic tie-breaker (document ID) so paginated reads do not skip same-timestamp alerts, and preserve API-key protection on both list and detail routes.
