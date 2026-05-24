## Summary

Implement server-side persistence of webhook alerts to Cloud Firestore inside the `/api/webhook/alert` flow. The implementation is secure, non-blocking (fire-and-forget), and fail-open.

## Key Changes

### :database: Firestore Alert Storage Integration

- Staged and configured `firebase-admin` setup supporting file-based and inline JSON configuration.
- Added automatic server timestamping, character truncation, and serialization of enrichment, token usage, and channel delivery results.

### :shield: Client-side Security Isolation

- Added `firestore.rules` denying all client-side reads/writes since access is entirely server-side.

### :test_tube: Worktree Testing Infrastructure

- Added a mock file for `firebase-admin` and customized Jest's config with `moduleNameMapper` and `modulePaths` to support correct package resolution in pnpm worktree.

## Technical Implementation

### Architecture changes

#### `AlertStorageService`

A lazy singleton service initialized upon first save attempt:
```javascript
const AlertStorageService = require('./src/services/storage/AlertStorageService');
await AlertStorageService.saveAlert({ ... });
```

### Dependencies Added

- `firebase-admin`: Client library for backend Firestore interactions.

### File Structure Additions

```
.
├── __mocks__/
│   └── firebase-admin.js                  # Manual mock for testing without node_modules
├── docs/antigravity/5e4bca15-efb5-43e6-b099-97f32087c619/
│   ├── implementation_plan.md             # Implementation details
│   ├── task.md                            # Checklist tracker
│   └── walkthrough.md                     # Verification summaries
├── firebase.json                          # Firebase setup
├── firestore.indexes.json                 # Firestore indexes definition
├── firestore.rules                        # Firestore security rules
├── src/services/storage/
│   └── AlertStorageService.js             # Lazy client and persistence method
└── tests/unit/
    └── alert-storage-service.test.js      # Jest unit tests
```

## Testing infrastructure

### Test Suite

- **14 Unit Tests** in `tests/unit/alert-storage-service.test.js`

### Test Files

- `alert-storage-service.test.js`: Verifies authentication methods, database initialization, schema validation, and fail-safe/fail-open execution pathways.

## Configuration Updates

### Environment Variables

```bash
ENABLE_FIRESTORE_ALERT_STORAGE=true
FIREBASE_PROJECT_ID=your_firebase_project_id
# GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
# FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

## Security

- All client-side access to the `alerts` collection is explicitly denied via `firestore.rules`.
- Firebase Admin SDK is used with service account credentials only.

## Testing

### Pre-merge Verification

- [x] Run `node /Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/node_modules/jest/bin/jest.js tests/unit/alert-storage-service.test.js` and verify all 14 tests pass.
- [x] Run the complete test suite and ensure no regressions.

---

**Review Checklist:**

- [x] Code quality meets project standards
- [x] All tests pass and coverage is maintained
- [x] Documentation is complete and accurate
- [x] Breaking change assessment completed
