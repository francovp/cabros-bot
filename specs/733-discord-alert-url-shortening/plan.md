# Implementation Plan: Discord Alert URL Shortening

**Branch**: `733-discord-alert-url-shortening` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)
**Input**: GitHub issue #733

## Summary

Pass the existing shared URL shortener into Discord alert formatting so enriched source links receive the same shortened URLs as WhatsApp. Coalesce in-flight shortening by exact URL so concurrent channel sends share one provider result. Keep original links on shortening failure. Harden the cross-channel integration test's fetch-call selection to use parsed exact hostnames and valid Green API fixture configuration.

## Technical Context

**Language/Version**: JavaScript, Node.js 24.18.0  
**Primary Dependencies**: Existing Discord/WhatsApp notification services and URLShortener; no new dependencies  
**Storage**: N/A  
**Testing**: Jest unit and integration tests  
**Target Platform**: Node.js service  
**Project Type**: Single Express service  
**Performance Goals**: Reuse the existing batch shortener call and coalesce concurrent requests for the same URL; do not add provider requests per channel.
**Constraints**: Keep channel gating and fail-open behavior; do not add environment variables or public API changes.  
**Scale/Scope**: Discord enriched-alert formatting and its focused tests.

## Constitution Check

- **Code Quality & Readability**: Pass. Reuse the existing formatter and URL shortener rather than adding a parallel path.
- **Simplicity & Minimalism**: Pass. No new runtime abstraction, dependency, configuration, or persistence.
- **Testing Policy**: Pass. Cover shortening, failure fallback, cross-channel parity, and hostile URL lookalikes in the existing focused integration suite.
- **Review & Quality Gates**: Pass when CI and PR review complete; pending at planning time.
- **Incremental Delivery & Versioning**: Pass. This changes internal notification formatting without changing a public contract.

## Project Structure

```text
src/
├── controllers/admin/testAlert.js
└── services/notification/
    ├── DiscordService.js
    └── NotificationManagerBootstrap.js

tests/
├── integration/cross-channel-url-shortening.test.js
├── unit/discord-service.test.js
└── unit/notification-manager-bootstrap.test.js
```

**Structure Decision**: Keep the existing single-project Node service layout. Runtime wiring belongs in notification services; behavior and bootstrap coverage belong in their existing Jest suites.

## Design Notes

- `DiscordService` accepts the existing URL shortener and passes it to the existing `WhatsAppMarkdownFormatter` implementation used to render enriched alerts.
- `NotificationManagerBootstrap` supplies the shared shortener to Discord. Admin dry-run formatting uses the live Discord service's shortener when available.
- The shared `URLShortener` reuses an in-flight request for an identical URL across concurrent channel formatting and removes the entry when the request settles, including failures.
- The formatter's existing failure handling retains original URLs, so no new retry or delivery behavior is introduced.
- Integration-test request selection uses `new URL(url).hostname` equality. The test uses a valid Green API fixture URL and key, and includes malicious host/path lookalikes to prevent substring matching regressions.
- No data model, OpenAPI, Postman collection, Remote Config key, or environment template change is needed.

## Verification

- Focused integration: `tests/integration/cross-channel-url-shortening.test.js`.
- Focused unit: `tests/unit/discord-service.test.js` and `tests/unit/notification-manager-bootstrap.test.js`.
- CI review includes static analysis, secret scan, and existing build checks. Firebase Hosting channel-quota errors are non-blocking for this backend-only change.
