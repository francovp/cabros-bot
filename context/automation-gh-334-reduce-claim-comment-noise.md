fix: reduce issue-automator claim-comment noise via in-place renewal (CB-135)

## Summary

Reduces the number of claim comments posted to GitHub issues by the `claim-issue.sh` script. Previously, every ownership renewal (Step 2 re-check, periodic re-verification) posted a new `**agent-claim**` comment, causing long-running sessions to accumulate many near-duplicate comments. This degraded issue readability and increased agent context/token overhead.

## Key Changes

- **In-place claim renewal (`claim-issue.sh`)**: When a session renews its own claim, the existing comment is now edited via REST PATCH instead of a new comment being posted. A `(renewed N time(s), last: ISO-8601)` suffix is appended to the body, preserving the audit trail without comment proliferation.
- **Freshness timestamp fix**: `newest_claim()` now returns a 5th field (`freshness_ts`) — the more recent of `created_at` and the body's `last:` renewal timestamp. The TTL staleness check uses `freshness_ts` so PATCH-renewed claims are not wrongly taken over by other sessions.
- **Fallback to POST**: If the in-place PATCH fails transiently (rate limit, network error), the existing arbitrated POST + fallback flow is used. No run is blocked by a transient API error.
- **Takeover paths unchanged**: First-time claims and takeovers still post new comments (required for race arbitration by comment ID order).
- **SKILL.md updated**: Documents the reduced-comment renewal behavior and freshness timestamp logic.
- **5 regression tests added**: `tests/unit/claim-issue-comment-noise.test.js` covers in-place renewal (no new POST), PATCH fallback, renewal count extraction, freshness timestamp extraction, and multi-step body format.

## Technical Implementation

The core change is in three places in `claim-issue.sh`:

1. **`update_claim_comment()`** (new helper): `gh api -X PATCH repos/REPO/issues/comments/CID -f body=...`
2. **`extract_renewal_count()`** (new helper): parses `(renewed N time(s), ...)` from the comment body
3. **`newest_claim()`** (updated): extracts `body_ts` from `last: ISO-8601` in the body and returns `freshness_ts = max(created_at, body_ts)` as a 5th field
4. **Renewal path** (updated): replaces `post_claim_comment` with `update_claim_comment`; fallback to `post_claim_comment` on failure

The original comment ID (lower = older wins) is preserved across all renewals, so the arbitration protocol is fully backward-compatible with existing claim comments.

## Testing

- Unit tests (new): `pnpm test -- tests/unit/claim-issue-comment-noise.test.js` — all 5 tests pass
- Unit tests (existing): no regressions in `tests/unit/`

## References

- **Linear**: [CB-135](https://linear.app/knil/issue/CB-135/reduce-issue-automator-claim-comment-noise-and-context-overhead)
- **GitHub Issue**: [#334](https://github.com/francovp/cabros-bot/issues/334)
- **Related PR**: [#304 — atomic issue claiming](https://github.com/francovp/cabros-bot/pull/304)
- **Related Issue**: [#333 — preserve label during ambiguous rollback](https://github.com/francovp/cabros-bot/issues/333)
