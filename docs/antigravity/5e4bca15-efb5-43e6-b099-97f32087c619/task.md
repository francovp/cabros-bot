# Task: Firestore Alert Storage

## Copying Firebase implementation from 006-csv-gemini-signals

- [x] Copy `firebase.json` from branch
- [x] Copy/adapt `firestore.rules` (deny all client access, server-side only)
- [x] Create `src/services/storage/AlertStorageService.js` — adapted from `firestoreRepository.js`
- [x] Modify `src/controllers/webhooks/handlers/alert/alert.js` — fire-and-forget save after `sendToAll()`
- [x] Update `.env.example` — add `ENABLE_FIRESTORE_ALERT_STORAGE` section
- [x] Update `.gitignore` — add `functions/node_modules/` (from branch)
- [x] Write unit tests `tests/unit/alert-storage-service.test.js`
- [x] Update `agents.md` — add section 006
- [x] Run unit tests to verify
- [x] Run full test suite for regressions
- [x] Copy artifacts to `docs/antigravity/<conversation-id>/`
- [x] Commit with `--no-verify`
