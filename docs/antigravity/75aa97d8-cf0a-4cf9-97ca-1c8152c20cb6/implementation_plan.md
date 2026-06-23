# Defer notification service initialization in dry-run mode

Address Codex review comment on pull request #79. When `/api/webhook/alert` is exercised in dry-run mode, the handler should not initialize or validate notification services (avoiding calls to `getMe()` and other setup/network calls).

## User Review Required

> [!IMPORTANT]
> The fix has already been implemented in a local commit `c4301e9a` on the branch `feat/dry-run-webhook-alerts-cb-15`. Since agents are not allowed to push to remote repositories, the user will need to manually push the changes to GitHub via `git push origin feat/dry-run-webhook-alerts-cb-15` to trigger the CI checks and the Render preview environment build.

## Open Questions

No open questions.

## Proposed Changes

### Alert Webhook Handler

#### [MODIFY] [alert.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/sync-github-linear-automation/src/controllers/webhooks/handlers/alert/alert.js)

- Deferred the `resolveBot` and `initializeNotificationServices` calls until after the `dryRun` branch return in `postAlert`.

## Verification Plan

### Automated Tests
- Running the targeted dry-run tests:
  ```bash
  pnpm test -- tests/integration/dry-run-webhook-alerts.test.js
  ```
- Running the full test suite:
  ```bash
  pnpm test
  ```

### Manual Verification
- Verify the build and checks pass on GitHub once the branch is pushed.
- Perform an E2E check against the deployed Render preview environment.
