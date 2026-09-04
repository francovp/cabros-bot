# feat: stamp environment banner on every /api response and admin console

## Summary

Stamps non-secret `X-Cabros-*` deployment headers on every HTTP response, exposes a public unauthenticated `GET /api/banner` snapshot, surfaces a fixed-position environment banner in the `/admin` console for non-production deployments, and appends a one-line `(env: ... @ ...)` footer to webhook alerts — all so operators and external integrators can immediately tell whether a response came from preview/staging or production.

Closes #856.

## Key Changes

- **Middleware headers** — new `src/lib/environmentBanner.js` exports `buildEnvironmentBannerMiddleware` which sets `X-Cabros-Environment`, `X-Cabros-Commit`, and `X-Cabros-Service` on every response when `ENABLE_ENVIRONMENT_BANNER=true` (default). Mounted in `app.js` between helmet and the healthcheck.
- **Public banner endpoint** — `GET /api/banner` (no auth) returns `{ environment, commit, name, deployedAt }` for external status pages and badge generators. Exposed in OpenAPI as `EnvironmentBanner` and added to the Postman collection.
- **Status metadata** — `/api/status` now reports `featureFlags.environmentBanner` (boolean gate) and `dependencies.environmentBanner` (the same payload as `/api/banner`) so operators can verify readiness from the existing capabilities endpoint.
- **Admin console banner** — `public/admin/index.html` adds an `#environment-banner` slot; `src/admin/admin.js` fetches `/api/banner` (4s AbortController timeout) and renders a yellow/red fixed banner with the build SHA and a "Copy preview URL" clipboard button only when `environment ∈ {preview, development, staging}`. Production deployments render no banner.
- **Footer metadata for preview alerts** — Telegram/WhatsApp alert footers now append `(env: <env> @ <short-sha>)` when `ENABLE_MESSAGE_FOOTER_METADATA=true` AND the deployment is preview-like. Production alerts are unchanged (no footer noise in real trading groups). Applied in both the Gemini/grounding footer builder and the TradingView MCP-only footer.
- **Opt-in gate** — new `ENABLE_ENVIRONMENT_BANNER` env var (default `true`). Documented in `.env.example`. Disabling skips the middleware so responses carry no banner headers at all.

## Technical Implementation

- The middleware delegates environment/commit resolution to `src/lib/deploymentEnvironment.js` (existing single source of truth — also used by `/api/status`).
- `resolveEnvironmentBannerEnvironment` mirrors `getEnvironment()` from `src/controllers/status.js` but is exported from the new module to avoid the circular import chain that would otherwise pull every service into the middleware at boot.
- All functions accept an optional `env` parameter for testability; tests assert without polluting global `process.env`.
- The admin banner fetch is bounded by `AbortController` (4 s) and gracefully no-ops on failure (the existing `/admin/auth-config` timeout pattern).
- Footer extension uses the existing `ENABLE_MESSAGE_FOOTER_METADATA` gate so no new contract or env var is introduced for delivery channels.
- `/api/banner` is auth-free and exposes only `environment/commit/name/deployedAt`. Credentials, webhook secrets, service-account JSON, and provider responses are never returned — verified by the integration test.

## Testing

- `tests/unit/environment-banner.test.js` — 11 cases covering defaults, opt-out, sanitization, Railway/Vercel/Render detection, Sentry override, NODE_ENV fallback, header stamping, no-op when disabled, and missing-commit header omission.
- `tests/integration/environment-banner-endpoint.test.js` — 7 supertest cases covering `/healthcheck` header injection, `/api/banner` payload shape, Railway PR preview classification, Sentry override, opt-out, sanitization, and deployedAt propagation.
- Existing coverage verified:
  - `tests/integration/status-endpoint.test.js` — 78/78 passing (status contract unchanged, new fields additive).
  - `tests/integration/alert-grounding.test.js` — 11/11 passing (footer extension is additive).
  - `tests/unit/alert-handler.test.js` — 34/34 passing (footer logic untouched for production deployments).
  - `tests/unit/admin-client.test.js` — 87/87 passing (admin console banner is additive).
  - `tests/unit/tradingview-mcp-service.test.js` — 49/49 passing (MCP-only footer is additive).
  - `tests/integration/openapi-docs.test.js` — 5/5 passing (OpenAPI + admin asset contract still synchronized).

## Acceptance Criteria

- [x] Every HTTP response from any mounted `/api` route and `/healthcheck` includes `X-Cabros-Environment` and `X-Cabros-Commit` headers when `ENABLE_ENVIRONMENT_BANNER=true`.
- [x] `/admin` shows a yellow/red banner when `service.environment` is `preview`, `development`, or `staging`, with the commit SHA and a "Copy preview URL" button.
- [x] Telegram/WhatsApp alert footers include `(env: ... @ ...)` only when `ENABLE_MESSAGE_FOOTER_METADATA=true` and `service.environment` is preview-like.
- [x] `GET /api/banner` returns JSON `{ environment, commit, name, deployedAt }` without any auth.
- [x] Banner text never includes secrets, webhook keys, or service-account JSON (asserted in tests).
- [x] Banner source reuses the existing `getDeploymentCommit` / `isPreviewEnvironment` / `isProductionLikeEnvironment` helpers so the value never drifts from `/api/status`.

## References

- Closes #856
- Related: #753 (Expose deployment build SHA, runtime version, and uptime in /api/capabilities) — overlaps with the JSON portion but this PR adds cross-cutting headers, admin banner, and footer.
- Related: #685 (Refresh /admin console UX) — adjacent admin redesign; this PR is a small targeted addition.