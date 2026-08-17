# fix(claim-issue): preserve agent-working label during ambiguous rollback (CB-140)

## Summary
Fixes a residual race condition in `rollback_abandoned_claim` where an empty REST comment read during arbitration failure could cause `claim-issue.sh` to remove the shared `agent-working` label. This stripped the label from concurrent in-flight claimants whose comments had not yet landed, leaving their claims unlabeled and allowing subsequent sessions to double-claim the issue.

## Key Changes
- Updated `rollback_abandoned_claim` in `.agents/skills/issue-automator/scripts/claim-issue.sh` to fail closed and retain `agent-working` in all cases. An empty REST comment read cannot prove that no rival claimant is in flight between label creation and comment POST.
- Added unit test in `tests/unit/claim-issue-comment-noise.test.js` verifying that `rollback_abandoned_claim` deletes unconfirmed claim comments while retaining the `agent-working` label fail-closed.
- Merged `origin/master` into `fix/gh-333-rollback-label-preservation` to resolve merge conflicts cleanly.

## Technical Implementation
- Fail-closed label retention ensures that when arbitration fails or produces an empty comment read, `claim-issue.sh` does not remove `agent-working`.
- Updated unit test suite in `claim-issue-comment-noise.test.js` with comprehensive assertions covering ambiguous rollback label preservation alongside existing renewal/takeover tests.

## Testing
- Unit tests run: `pnpm test -- tests/unit/claim-issue-comment-noise.test.js` (9/9 passed).

## References
- **GitHub Issue**: https://github.com/francovp/cabros-bot/issues/333
- **Linear**: [CB-140](https://linear.app/knil/issue/CB-140/preserve-agent-working-label-during-ambiguous-rollback)
