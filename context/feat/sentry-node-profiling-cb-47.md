feat: enable Sentry Node.js profiling with @sentry/profiling-node (CB-47)

## Summary

Adds CPU profiling support to the Sentry monitoring integration. When `SENTRY_TRACES_SAMPLE_RATE` and `SENTRY_PROFILE_SESSION_SAMPLE_RATE` are both set, profiling data is automatically attached to active Sentry traces using `profileLifecycle: "trace"`. No breaking changes — profiling is fully opt-in via env vars, and falls back gracefully if either rate is unset.

## Key Changes

- **`package.json` / `pnpm-lock.yaml`** — installs `@sentry/profiling-node` as a production dependency.
- **`src/services/monitoring/SentryService.js`**:
  - Imports `nodeProfilingIntegration` from `@sentry/profiling-node`.
  - Reads `SENTRY_PROFILE_SESSION_SAMPLE_RATE` env var in `_buildConfiguration()` (only parsed when `SENTRY_TRACES_SAMPLE_RATE` is also set, since profiling requires tracing).
  - Conditionally adds `nodeProfilingIntegration()` to the `integrations` array inside `Sentry.init()`.
  - Sets `profileSessionSampleRate` and `profileLifecycle: "trace"` on `initOptions` when both tracing and profiling are configured.
  - Adds `isProfilingEnabled()` public method for runtime checks.
  - Improves the startup log to report profiling status alongside environment and release.
- **`src/controllers/status.js`** — exposes `sentryProfiling` as a boolean feature flag in `GET /api/status`.
- **`README.md`** — documents `SENTRY_PROFILE_SESSION_SAMPLE_RATE` and how profiling interacts with tracing.
- **`AGENTS.md`** — adds `SENTRY_PROFILE_SESSION_SAMPLE_RATE` to the optional env vars list.

## Technical Implementation

- Profiling piggybacks on the existing `SentryService.init()` flow; no changes to `instrument.js` or the caller surface.
- `nodeProfilingIntegration()` is added only when both `tracesSampleRate !== undefined` and `profileSessionSampleRate !== undefined`, matching the Sentry SDK requirement that tracing must be enabled for profiling to work.
- `profileLifecycle: "trace"` is the recommended mode — profiling is automatically scoped to active traces, avoiding runaway profiling.
- Sampling rates are parsed with the existing `_parseOptionalSampleRate()` helper, which validates range `[0.0, 1.0]` and returns `undefined` for empty/missing values.

## Testing

- Added 9 new unit tests under `Profiling Configuration (CB-47)` in `tests/unit/sentry-service.test.js`, covering:
  - `profileSessionSampleRate` parsing from env vars (enabled, tracing-disabled, missing).
  - `isProfilingEnabled()` returning correct values for all combinations.
  - `Sentry.init()` receiving `profileSessionSampleRate` and `profileLifecycle` only when configured.
  - `Sentry.init()` not receiving profiling options when `SENTRY_PROFILE_SESSION_SAMPLE_RATE` is absent.
- Added `jest.mock('@sentry/profiling-node', ...)` in `tests/setup.js` to prevent the native binary from loading in test environments.
- All 65 tests pass: `pnpm test -- tests/unit/sentry-service.test.js --testTimeout=5000`.

## References

- Closes #139
- **Linear**: [CB-47](https://linear.app/knil/issue/CB-47/habilitar-profiling-de-sentry-en-nodejs)
- Sentry Profiling Docs: https://docs.sentry.io/platforms/javascript/guides/node/profiling/node-profiling/
