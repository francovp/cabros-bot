# Walkthrough - Firestore Alert Storage (006)

We have successfully implemented the storage of all incoming webhook alerts in Google Cloud Firestore using a secure, fail-open, and non-blocking architecture.

## Changes Made

1. **`src/services/storage/AlertStorageService.js` [NEW]**:
   - Implemented a lazy `firebase-admin` singleton.
   - Configured features so they are gated under the `ENABLE_FIRESTORE_ALERT_STORAGE` environment variable.
   - Designed credentials parser supporting two options:
     - **Option A**: `GOOGLE_APPLICATION_CREDENTIALS` file path.
     - **Option B**: `FIREBASE_SERVICE_ACCOUNT_JSON` inline JSON string (highly recommended for Render secrets).
   - Designed a non-blocking `saveAlert()` function that performs fail-open error handling (logs a warning but never throws, ensuring the primary alert delivery is unaffected).
   - Formatted the saved document schema to include `receivedAt` (server timestamp), `text` (truncated to 20,000 chars), `enriched` (flag), `enrichmentData`, `tokenUsage`, `deliveryResults`, `source` ("webhook"), and `useTradingViewData`.

2. **`src/controllers/webhooks/handlers/alert/alert.js` [MODIFY]**:
   - Imported `AlertStorageService`.
   - Wired up the `saveAlert` function to run in a fire-and-forget manner after responding to the webhook caller, avoiding any delay to the HTTP response.

3. **`firebase.json` [NEW]**, **`firestore.rules` [NEW]**, and **`firestore.indexes.json` [NEW]**:
   - Added configurations and rules that deny all client-side reads and writes since all DB activity is server-side via the Admin SDK (which bypasses security rules).

4. **`.env.example` [MODIFY]**:
   - Documented the environment variables for configuring credentials and enabling the storage feature.

5. **`.gitignore` [MODIFY]**:
   - Appended `functions/node_modules/` and `functions/.eslintcache` rules as seen in the source branch.

6. **`jest.config.js` [MODIFY]**:
   - Mapped `firebase-admin` imports to `__mocks__/firebase-admin.js` since the worktree directory doesn't house standard node_modules.
   - Set up `modulePaths` pointing to the parent repository's `node_modules` so that external dependencies can resolve.

## Tests and Verification

1. **`__mocks__/firebase-admin.js` [NEW]**:
   - Created a manual mock of `firebase-admin` for isolated, lightweight unit testing.

2. **`tests/unit/alert-storage-service.test.js` [NEW]**:
   - Added 14 unit tests covering initialization scenarios, credential mappings, schema checking, character truncation, empty delivery inputs, and failure recovery.

### Test Results

We ran the new unit tests and the entire 25 unit test suite (322 tests) and they all passed with 0 failures:

```bash
node /Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/node_modules/jest/bin/jest.js tests/unit/alert-storage-service.test.js --testTimeout=5000 --no-coverage
```
Output:
```
PASS tests/unit/alert-storage-service.test.js
  AlertStorageService
    getFirestore()
      ✓ returns null when ENABLE_FIRESTORE_ALERT_STORAGE is not set (2 ms)
      ✓ returns null when ENABLE_FIRESTORE_ALERT_STORAGE is "false"
      ✓ initializes firebase-admin and returns Firestore instance when enabled (1 ms)
      ✓ uses FIREBASE_SERVICE_ACCOUNT_JSON when set
      ✓ passes FIREBASE_PROJECT_ID to initializeApp when set
      ✓ does not call initializeApp when admin.apps is already populated
      ✓ returns null and logs a warning when initializeApp throws
    saveAlert()
      ✓ returns null without calling Firestore when storage is disabled
      ✓ calls collection("alerts").add() with correctly shaped document (1 ms)
      ✓ truncates text longer than 20000 characters
      ✓ stores empty array when deliveryResults is not an array
      ✓ always sets source to "webhook"
      ✓ returns null and logs a warning (does not throw) when add() rejects (1 ms)
      ✓ coerces non-boolean enriched to boolean (1 ms)

Test Suites: 1 passed, 1 total
Tests:       14 passed, 14 total
```

All 25 test suites passed successfully:
```
Test Suites: 25 passed, 25 total
Tests:       322 passed, 322 total
Snapshots:   0 total
Time:        13.981 s, estimated 14 s
```
