## feat(sentry): capture console logs

## Summary

Enable Sentry Logs for configurable console output so selected console levels are forwarded to Sentry when monitoring is enabled.

## Key Changes

### :satellite: Sentry Logs integration

- Enables `enableLogs: true` in `SentryService`.
- Adds `Sentry.consoleLoggingIntegration({ levels })` while preserving default Sentry integrations.
- Adds `SENTRY_CONSOLE_LOG_LEVELS` to configure captured console levels, defaulting to `warn,error`.
- Upgrades `@sentry/node` to v10 so the runtime exposes the Sentry Logs API used by current JavaScript SDK docs.

### :scroll: Structured JSON logging

- Updates the centralized `console.*` wrapper to emit one JSON object per log line.
- Adds standard fields: `timestamp`, `level`, `message`, `service`, `environment`, and `pid`.
- Preserves structured object arguments under `attributes`, primitive extra arguments under `parameters`, and `Error` details under `error`.
- Redacts sensitive keys such as tokens, secrets, passwords, API keys, authorization headers, cookies, and DSNs.

### :test_tube: Test coverage

- Adds a focused unit assertion that executes the Sentry `integrations` callback.
- Verifies that Sentry Logs use `consoleLoggingIntegration`, not the breadcrumb-only `consoleIntegration`.
- Extends the global Sentry Jest mock with the logging integration methods.

### :memo: Documentation

- Updates README troubleshooting to clarify that configured console levels appear in Sentry Logs, not Issues.
- Updates agent guidance to reflect `@sentry/node` v10 and configurable console log capture.

## Technical Implementation

### Architecture changes

#### `SentryService`

The monitoring service remains the single Sentry entry point. SDK initialization now enables Sentry Logs and appends the console logging integration:

```js
enableLogs: true,
integrations: (integrations) => [
  ...integrations,
  Sentry.consoleLoggingIntegration({ levels: this.config.consoleLogLevels }),
],
```

#### `logging`

The existing global console wrapper remains the only application logging surface. Existing `console.*` call sites continue to work, but emitted lines are now structured JSON:

```json
{
  "timestamp": "2026-05-21T00:00:00.000Z",
  "level": "info",
  "message": "Processing alert",
  "service": "cabros-bot",
  "environment": "production",
  "pid": 12345,
  "attributes": {
    "requestId": "req-123"
  }
}
```

### Dependencies Added

- `@sentry/node@^10.53.1`: Provides the current Sentry Logs API, including `consoleLoggingIntegration`.

## Testing infraestructure

### Test Suite

- **42 Sentry unit tests**
- **5 structured logging unit tests**
- **9 Sentry integration tests**
- **400 full Jest tests**

### Test Coverage

- Sentry SDK initialization includes `enableLogs: true`.
- Console level capture is configured through `SENTRY_CONSOLE_LOG_LEVELS`.
- Invalid or duplicate console level values are ignored, and unusable config falls back to `warn,error`.
- Breadcrumb-only `consoleIntegration` is not used for Sentry Logs.
- Console output is emitted as parseable JSON.
- Error objects are serialized with name, message, and stack.
- Sensitive structured fields are redacted before logging.

### Test Files

- `tests/unit/sentry-service.test.js`: Verifies Sentry Logs initialization behavior.
- `tests/unit/logging.test.js`: Verifies structured JSON logging, redaction, and filtering behavior.
- `tests/setup.js`: Extends the mocked Sentry SDK surface used by tests.

## Documentation Updates

- **README Sentry Logs** Documents configurable console forwarding and troubleshooting.
- **README structured logging** Documents JSON logs and `SERVICE_NAME`.
- **Agent context** Updates Sentry runtime notes from v8 error-only monitoring to v10 error and log capture, plus structured JSON logging expectations.

## Testing

### Pre-merge Verification

- [x] `pnpm test -- tests/unit/sentry-service.test.js --testTimeout=5000`
- [x] `pnpm test -- tests/integration/sentry-runtime-errors.test.js --testTimeout=10000`
- [x] `pnpm test`

### Post-merge Verification

- [ ] Deploy with `ENABLE_SENTRY=true` and a valid `SENTRY_DSN`.
- [ ] Confirm application stdout/stderr lines are valid JSON.
- [ ] Trigger controlled logs for the configured `SENTRY_CONSOLE_LOG_LEVELS` values and confirm they appear in Sentry Logs.
- [ ] Confirm runtime error events still appear in Sentry Issues.

## References

- [Sentry JavaScript Logs documentation](https://docs.sentry.io/platforms/javascript/guides/express/logs/)

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
