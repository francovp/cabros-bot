# Research: Fire-and-Forget Firestore Write Health

## Existing paths

- `FirestoreWriteMetricsService` already tracks aggregate write attempts and read-health snapshots. `dependencies.firestoreWriteMetrics` is an existing contract and must keep its shape.
- `AlertStorageService.saveAlert()` already records `alerts` write success/failure and is scheduled through `trackBackgroundTask`.
- `SignalOutcomeService.recordSignal()` is tracked as background work; its internal Firestore create/add catches and converts failures to `null`.
- `NotificationRedriveService.recordDeliveryResults()` stores dead letters in memory first, then attempts a durable write with a 500 ms bound; failed persistence must not block delivery.
- `NewsDedupStorageService.setEntry()` and `updateEntry()` catch and swallow persistence errors. The same `newsDedup` domain also owns `claimEntry()`, `renewEntry()`, explicit deletion, and best-effort expired-entry cleanup; lease failures can affect cross-replica alert dedup and must be visible too. Conditional transactions that do not call `transaction.set()` are no-ops, not successful writes.
- `SentryService.captureEvent()` already supports `external_failure` fingerprints and sanitized tags/extra fields. The new event can use a generic message, the `persistent-write-health` feature tag, domain as channel, Firestore as provider, and the closed category as error code.
- `/api/capabilities` is served from the same status handler. No route, authentication, environment, Remote Config, or destination changes are needed.

## Design decisions

- Extend `FirestoreWriteMetricsService` with a separate persistent-write-health snapshot; do not alter `getSnapshot()` or `getReadSnapshot()`.
- Add a small `src/lib/fireAndForget.js` helper returning a non-throwing result envelope. Existing tracked callers keep their current scheduling and shutdown behavior.
- Keep a fixed domain registry and a bounded 100-attempt rolling buffer per domain. Cumulative process-local success/failure counters remain separate from the rolling rate window.
- Redact and cap error messages before storing them in memory. Do not expose these messages in `/api/status` or Sentry.
- Emit Sentry events only after 50 samples cross the 20% threshold; suppress repeats for the same domain/category until the rolling rate recovers.
- Keep the new status field always present so operators can distinguish `unconfigured` from a domain with observed writes.

## Error category mapping

- Firestore permission/authentication errors map to `firestore_permission_denied`.
- Unavailable, deadline, and resource-exhaustion errors map to `firestore_unavailable`.
- Invalid-argument and failed-precondition errors map to `firestore_malformed`.
- Other categories map to `unknown`.
