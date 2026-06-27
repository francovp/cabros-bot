# fix(deploy): update render.yaml repo reference to francovp/cabros-bot (CB-36)

## Summary

Updates `render.yaml` so the Render IaC blueprint points to the current repository (`francovp/cabros-bot`) instead of the old, renamed repository (`francovp/cabros-crypto-bot-telegram`). Without this fix the blueprint would attempt to deploy from a stale source URL, potentially causing Render to fail to locate the repository or deploy an outdated fork.

## Key Changes

- **`render.yaml`**: Changed `repo` field from `https://github.com/francovp/cabros-crypto-bot-telegram` to `https://github.com/francovp/cabros-bot`.

## Technical Implementation

The `render.yaml` Blueprint definition uses a `repo` field to tell Render which GitHub repository to clone and deploy. After the repository was renamed/migrated to `francovp/cabros-bot`, the `repo` value was never updated. This single-line change corrects the reference so that:

- The Render service blueprint matches the actual GitHub repository.
- Pull-request preview deployments (`pullRequestPreviewsEnabled: true`) continue to work against the right repo.
- The `IS_PULL_REQUEST` gating behavior (which disables the Telegram bot in PR previews via `previewValue: false` on `ENABLE_TELEGRAM_BOT`) is unaffected — no logic changes were made, only the repo URL.

No other configuration in `render.yaml` required changes; the service name (`cabros-crypto-bot-telegram-iac`), branch, build/start commands, healthcheck path, and environment variable definitions all remain intentionally unchanged.

## Testing

- Unit tests (`pnpm test -- tests/unit/ --testTimeout=5000`) pass with no regressions — this change is purely a config string update.
- No application logic was modified; runtime behavior is unaffected.

## References

- **Linear**: [CB-36](https://linear.app/knil/issue/CB-36/fix-renderyaml-repository-reference)
- Fixes #119
