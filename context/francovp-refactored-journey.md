feat(observability): expose deployment identity

## Summary

Operators can identify preview, staging and production from HTTP responses, the admin console and enriched alert footers. A public deployment snapshot shares the existing status environment resolver.

## Key Changes

- Add optional runtime-controlled X-Cabros-Environment, short X-Cabros-Commit and X-Cabros-Service headers before CORS, parsers and terminal routes.
- Expose unauthenticated GET /api/banner with environment, full commit, service name and nullable host commit timestamp.
- Show a readable sticky warning for non-production admin consoles, with a button copying the selected backend origin.
- Append escaped non-production environment metadata to Gemini/MCP alert footers under the existing footer flag.

## Technical Implementation

- Reuse one deployment environment resolver with status; do not initialize provider readiness for the public snapshot.
- ENABLE_ENVIRONMENT_BANNER defaults to true and is a non-secret Remote Config display flag; evaluate it on every request and fall back to environment/default values if Remote Config fails. The checked-in template uses useInAppDefault.
- Header opt-out leaves the public snapshot and console available. The existing ENABLE_MESSAGE_FOOTER_METADATA controls notification footers independently. Authentication, security controls, credentials, destinations and startup gates stay environment-only.
- Invalid optional header characters cannot interrupt core delivery. Deployment IDs are never returned as timestamps.
- Preserve current Firebase authorization/navigation; regenerate both admin asset trees. Synchronize OpenAPI, Postman examples, README and operator guidance. No new dependencies.

## Testing

- Red/green regressions: runtime Remote Config toggles, metadata opt-out, custom environments, timestamp shape, invalid header values, Gemini-only footer, final Telegram/WhatsApp formatting, and fail-open config exceptions.
- Focused validation: 770 tests passed before final footer/config fixes; final footer tests 21/21, final config/generic-message 96/96 and final OpenAPI/Postman 154/154 passed.
- pnpm run build:hosting passed. Scoped ESLint passed; 17 findings in unchanged admin/MCP lines reproduce on master. Feature diff whitespace check passed.
- Local start-dev smoke: health/OpenAPI/banner 200; missing status auth 401; dedicated admin auth 200; request-ID echo and status/banner environment+SHA parity confirmed.
- Playwright desktop/mobile screenshots captured; copy action confirmed and a 390px viewport has no horizontal overflow.
- Full pnpm test on published 260d2568 passed 335/335 suites and 8,080/8,080 tests; its Node CI also passed. After shared-escaper/test-fixture revisions, the fresh full local run ended 334/335 suites and 8,079/8,080 tests (jobs idempotency 201-vs-404). An earlier run crashed in V8 garbage collection (SIGSEGV139) after an auto-trade socket failure; isolated auto-trade/banner/fixture tests passed38/38. Final isolated jobs/banner/fixture/grounding validation passed57/57. No green final local full-suite claim.
- Both sequential independent reviews and each final re-review have no actionable findings. New-head Node CI, CodeQL and Codex review remain required. Preview availability is separately unverified.
- Reuse the shared raw-field MarkdownV2 escaper for the environment line. The existing setup helper test runs in a temporary primary repository instead of creating ignored developer configuration links in the active worktree.
- Exact model variant unavailable; preserve codex and codex-automation attribution without guessing.

## References

Closes #856.
https://github.com/francovp/cabros-bot/issues/856
