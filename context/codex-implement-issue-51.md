# feat(alerts): add stored alerts read api

## Summary

Add a protected read API for Firestore-backed webhook alerts so operators can inspect stored deliveries without using the Firestore console directly.

## Key Changes

### :mag: Add stored alert endpoints

- Add `GET /api/alerts` with `limit`, `before`, `source`, and `enriched` query support
- Add `GET /api/alerts/:alertId` for single-document lookup by Firestore document ID
- Reuse the existing `validateApiKey` middleware so the read API matches the webhook protection model

### :floppy_disk: Extend Firestore alert storage service

- Add `isEnabled()` to centralize the feature gate check
- Add `listAlerts()` for descending `receivedAt` pagination
- Add `getAlertById()` for detail reads
- Format Firestore snapshots into API-safe JSON objects with stable fields for clients
- Apply `source` and `enriched` filtering after `receivedAt`-ordered reads to avoid introducing new composite index requirements

### :white_check_mark: Add endpoint and storage coverage

- Add integration coverage for auth, validation, disabled-state handling, list pagination, and detail lookups
- Extend the firebase-admin mock to support query chaining and document reads
- Add unit coverage for formatted list responses, filtered multi-batch scans, and single-document fetches

## Technical Implementation

### Architecture changes

#### `src/controllers/alerts/alerts.js`

Introduces a thin controller layer that validates request parameters, checks the storage feature flag, delegates reads to `AlertStorageService`, and reports unexpected failures through Sentry.

#### `src/services/storage/AlertStorageService.js`

Keeps Firestore as the single boundary for alert persistence and reads. The new read helpers share the same lazy Admin SDK initialization as the write path.

### File Structure Additions

```text
src/controllers/alerts/
└── alerts.js                    # Stored alert list/detail handlers
tests/integration/
└── alerts-endpoint.test.js      # Read API contract coverage
.github/
└── copilot-instructions.md      # Agent guidance for stored alert reads
```

## Testing infrastructure

### Test Suite

- **19 unit tests** in `tests/unit/alert-storage-service.test.js`
- **6 integration tests** in `tests/integration/alerts-endpoint.test.js`

### Test Coverage

- Cover API-key protection, invalid query handling, disabled-state handling, pagination metadata, detail fetches, and Firestore batch scanning behavior

### Test Files

- `tests/unit/alert-storage-service.test.js`: Firestore initialization, persistence, list pagination, filtered reads, and single-document lookup
- `tests/integration/alerts-endpoint.test.js`: HTTP contract for the stored alerts API

## Configuration Updates

### Environment Variables

```bash
ENABLE_FIRESTORE_ALERT_STORAGE=true
FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
FIREBASE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

## Documentation Updates

- **README stored alerts API** Add public route documentation and environment notes for the new read endpoints
- **Agent guidance** Document where the stored alerts controller and Firestore read helpers live
- **Copilot instructions** Add repo-local guidance for extending the alerts read surface safely

## Examples

```http
GET /api/alerts?limit=50&before=2026-06-06T12:00:00.000Z&source=webhook&enriched=true
X-API-Key: <webhook-api-key>
```

```http
GET /api/alerts/alert-123
X-API-Key: <webhook-api-key>
```

## Security

- The new endpoints stay behind the existing API-key middleware
- The response omits secrets and only exposes stored alert payload metadata

## Deployment Considerations

- The read API returns `403 FEATURE_DISABLED` unless `ENABLE_FIRESTORE_ALERT_STORAGE=true`
- Firestore credentials must already be valid for the existing write path; no new service dependency is introduced

## Testing

### Pre-merge Verification

- [x] `pnpm test -- tests/unit/alert-storage-service.test.js tests/integration/alerts-endpoint.test.js tests/security/auth_check.test.js tests/integration/jobs-endpoint.test.js --runInBand`
- [x] `pnpm test --runInBand`

### Post-merge Verification

- [ ] Call `GET /api/alerts` in a deployed environment with a valid API key
- [ ] Confirm stored alerts paginate correctly against the live Firestore collection

## References

- GitHub issue: `#51 Expose stored alerts through a read API`
- Linear issue: `CB-9 Expose stored alerts through a read API`
