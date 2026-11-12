# Quickstart: Configurable generic message limit

1. Set `GENERIC_MESSAGE_MAX_LENGTH` to an integer from `1` through `20000`; leave it unset to use `4000`.
2. When Firebase Remote Config is enabled and has a fresh valid template value, it takes precedence. If Remote Config is disabled, unavailable, or has an invalid value, the valid environment value or `4000` default remains effective.
3. Send a generic message shorter than, exactly at, and longer than the effective limit using a mocked channel in the integration test. Verify delivery continues and the existing truncation fields appear only for the long message.

Focused validation:

```bash
pnpm test -- tests/unit/remote-config-service.test.js
pnpm test -- tests/integration/generic-message-webhook.test.js
```

The issue-automator final verification also runs the repository's required full `pnpm test` and a safe local smoke test before PR creation.
