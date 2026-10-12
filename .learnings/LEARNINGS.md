## [LRN-20261010-001] correction

**Logged**: 2026-10-10T21:50:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Reject invalid `dryRun` values with HTTP 400 instead of coercing to defaults.

### Details
In Issue #1153, @francovp clarified that coercing invalid or unrecognized `dryRun` values to a default (like `true` or `false`) is incorrect because it hides client bugs and breaks the strict OpenAPI boolean contract. Specifically, coercing to `false` was a prior bug that led to unintended live deliveries. The correct approach is explicit fail-closed validation at the request boundary using `isRecognisedDryRunValue` from `src/lib/dryRunRequest.js`, returning a `400 Bad Request` with code `INVALID_REQUEST`.

### Suggested Action
Always implement strict validation for boolean flags that control safety-critical behavior (like dry-runs) and reject invalid inputs rather than assuming a default.

### Metadata
- Source: user_feedback
- Related Files: src/lib/dryRunRequest.js
- Tags: validation, safety, api-contract
- See Also: none
- Pattern-Key: harden.input_validation

---

## [LRN-20261010-002] best_practice

**Logged**: 2026-10-10T21:52:00Z
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Define failure modes first, then layer resilience patterns (retries, timeouts, circuit-breakers).

### Details
In Issue #1109, @gigachad-senior-dev provided senior-level guidance on operational thinking: prioritize defining how a system can fail before implementing recovery mechanisms. Additionally, emphasize the use of structured logs and correlation IDs over simple printf debugging for better observability.

### Suggested Action
When designing new integrations or features, start the design doc/discussion with a "Failure Modes" section before detailing the "Happy Path" or "Resilience" strategies.

### Metadata
- Source: user_feedback
- Related Files: none
- Tags: sre, observability, resilience
- See Also: none
- Pattern-Key: simplify.operational-thinking

---

## [LRN-20261012-001] correction

**Logged**: 2026-10-12T00:18:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
"Environment-only" gate classifications must be verified empirically — they are testable claims, not documentation axioms.

### Details
In Issue #721, @francovp discovered that four Firestore storage feature flags (classified as "environment-only" because "they are process-startup gates that decide where a collection lives") were actually re-evaluated on every call via `getFirestore()` / `isFirestoreEnabled()`. A gate re-read per call is not a startup gate, so they are remotely toggleable. The classification was documenting an assumption nobody had verified.

Two consequences emerged when making them remote:
1. A published `false` must beat a `true` in `render.yaml` — `env || remote` gets this wrong; it needs `remote ?? env`.
2. `getRuntimeConfig()` cannot distinguish "Remote Config said false" from "environment says false" — it returns a value for every schema key. Using it made `ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE` (deprecated alias) unreachable.

Also, a template `defaultValue` is not a default — the Admin SDK reports unmatched parameters with source `'remote'`, so shipping `false` would silently disable storage modes in production. `useInAppDefault: true` is the correct encoding for "no published value".

### Suggested Action
On any "this is environment-only" annotation in this repo: verify the claim with a grep of the gate functions. The claim is testable, and it was wrong here.

### Metadata
- Source: user_feedback
- Related Files: firebase-remote-config-template.json, src/services/storage/
- Tags: remote-config, feature-flags, verification
- See Also: Issue #721, PR #1367
- Pattern-Key: harden.config-verification
---
