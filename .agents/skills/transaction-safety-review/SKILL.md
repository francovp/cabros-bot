---
name: transaction-safety-review
description: Use when changing Binance order execution, webhook authentication, idempotency, Firestore persistence, TTL/retention, replay handling, or any path where a retry can duplicate a side effect or lose durable state.
---

# Transaction Safety Review

Review money movement and durable side effects before implementation and before the final PR check.

## Checklist

1. **Fail closed.** Verify every live/operator route has an active API-key or Firebase operator-auth path. Feature flags and credentials alone must never enable unauthenticated execution.
2. **Separate outcomes.** Distinguish validation rejection, provider rejection, transport failure, and ambiguous submission. Never cache or retry them as the same HTTP result.
3. **Make retries safe.** Require a stable client/order identifier for live orders. Keep ambiguous outcomes replayable or reconcilable until the provider confirms the result.
4. **Validate at provider boundaries.** Match exchange filters and applicability flags, preserve decimal strings, and validate the actual execution risk—not only a stale average price or dry-run approximation.
5. **Preserve durable types.** Firestore `Timestamp`, `FieldValue`, and other SDK values must survive read-modify-write paths; do not JSON-clone documents before transactions.
6. **Align retention with execution.** Pending claims outlive the longest allowed request and ignore replay TTL until completion. Backfills, native TTL, runtime expiry, and collection names must use the same policy.
7. **Strip undefined values.** Sanitize objects before every Firestore write, including nested response headers and error metadata.

## Required tests

Cover at least one case for each changed boundary:

- auth absent while the feature is enabled;
- provider timeout after acceptance and retry/reconciliation;
- definitive provider rejection and retry semantics;
- reordered payloads, missing IDs, and replay/conflict paths;
- Firestore SDK-value preservation and undefined-property sanitization;
- active claim, stale claim, backfill, and TTL behavior.

Use `pnpm test -- <focused-files> --runInBand` first, then the repository's required full suite. Do not call a live-order path safe from a dry run alone.

## Evidence from recent reviews

The last 100 repository PRs contained repeated unresolved findings in PRs #378, #393, #389, #272, #250, and #251 covering unauthenticated order routes, ambiguous Binance submissions, provider-filter gaps, Firestore type loss, pending-claim expiry, canonical fingerprints, and missing idempotency examples.
