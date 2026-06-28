# feat(sentry): add profiling env var and status endpoint exposure (CB-47)

## Summary

Adds `SENTRY_PROFILE_SESSION_SAMPLE_RATE` to `.env.example` and exposes Sentry profiling status in the `/api/status` endpoint. The actual Sentry Node.js profiling integration (`nodeProfilingIntegration()` with `profileLifecycle: "trace"`) was already implemented in `SentryService.js` — these changes complete the observability and documentation gaps.

## Key Changes

- **`.env.example`**: Added `SENTRY_PROFILE_SESSION_SAMPLE_RATE` env var documentation right after `SENTRY_TRACES_SAMPLE_RATE`, with description clarifying it requires tracing to be enabled.
- **`src/controllers/status.js`**: Extended the `sentry` dependency object with a `profiling` sub-status that reports whether profiling is enabled (requires `ENABLE_SENTRY=true` + `SENTRY_DSN` + `SENTRY_TRACES_SAMPLE_RATE`) and configured (`SENTRY_PROFILE_SESSION_SAMPLE_RATE` is set).

## Technical Implementation

- The Sentry profiling code was already in place (`@sentry/profiling-node` in `package.json`, `nodeProfilingIntegration()` in `SentryService.init()`, `profileLifecycle: "trace"` when `profileSessionSampleRate` is set).
- `status.js` now returns `dependencies.sentry.profiling` as a nested dependency status object so operators can verify profiling readiness at a glance.
- `.env.example` now documents the profiling env var in the Sentry configuration section.

## Testing

- All 25 existing status endpoint integration tests pass with no regressions.
- Manual verification: `GET /api/status` returns `dependencies.sentry.profiling` with `enabled`, `configured`, `ready`, and `status` fields.

## References

- **Linear**: [CB-47](https://linear.app/knil/issue/CB-47/habilitar-profiling-de-sentry-en-nodejs)
- Fixes #139
