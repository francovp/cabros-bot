# Implementation Plan: Configurable generic message limit

**Branch**: `006-gh-780-message-limit` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

## Summary

Add one bounded runtime setting for the generic message webhook's existing truncation threshold. Resolve it through the shared runtime configuration service so fresh Remote Config values take precedence and environment/default fallbacks continue to work. Keep the 4,000-character default, 1..20,000 bounds, existing suffix and response behavior, and delivery fail-open guarantees.

## Technical Context

**Language/Version**: Node.js 24.18.0
**Primary Dependencies**: Existing Express application and Firebase Admin Remote Config service; no new dependencies
**Storage**: No persistent data or schema changes
**Testing**: Jest unit and integration tests
**Target Platform**: Existing Cabros Bot API deployment
**Project Type**: Single Node.js service
**Performance Goals**: Resolve the current in-memory runtime configuration once per request; no network call in the request path
**Constraints**: Default 4,000; integer range 1..20,000; invalid environment values use the default, invalid Remote Config values leave the valid environment value or default effective; response metadata remains conditional on actual truncation
**Scale/Scope**: One runtime setting, one existing webhook flow, configuration and operator documentation

## Constitution Check

- Simplicity: one schema key and existing runtime-config access; no duplicate parser or new dependency. **Pass**
- Quality: bounded parsing reuses `RemoteConfigService` validation and tests both fallback and configured behavior. **Pass**
- Review and delivery: focused PR with current-head CI, nested reviews, and preview verification. **Pass**
- Incremental scope: response fields already shipped under #602; this change adds only the remaining threshold control. **Pass**

## Project Structure

```text
specs/006-gh-780-message-limit/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── contracts/configuration.md
└── checklists/requirements.md

src/controllers/webhooks/handlers/message/message.js
src/services/remoteConfig/RemoteConfigService.js
firebase-remote-config-template.json
.env.example
docs/environment-configuration.md
docs/webhooks.md
src/openapi/openapi.json
CabrosBot.postman_collection.json
AGENTS.md
tests/unit/remote-config-service.test.js
tests/integration/generic-message-webhook.test.js
```

**Structure Decision**: Extend the existing webhook handler and shared Remote Config schema. Add no service/module, persistence, endpoint, request field, or dependency. Document the setting beside existing environment and webhook contracts.

## Complexity Tracking

No constitution deviations.
