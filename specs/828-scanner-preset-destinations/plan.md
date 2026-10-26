# Scanner Preset Destinations Implementation Plan

**Branch**: `codex/issue-828-preset-destinations-automation-20261026`  
**Date**: 2026-10-26  
**Spec**: [spec.md](spec.md)

## Goal

Add compatible per-preset routing for manual, scheduled, and existing async market-scanner jobs. Preserve broadcast defaults and legacy routing records.

## Architecture

- Add a small scanner-preset routing module to validate destination arrays and resolve preset plus per-request routing.
- Reuse `requestRouting.js` for existing destination format checks and `sendWithNotificationRouting()` for all sends.
- Extend `ScannerPresetService` normalization, cloning, and Firestore deserialization for `mode` and `destinations`; preserve mode-less legacy routing.
- Route both `postRunPreset` and the scheduler through the same resolver. Keep direct webhook handling unaware of preset destination fields.
- For `runAsyncJob: true`, submit the merged preset scan and routing data through `JobService.createJob('market-scanner', ...)`; persist destinations in job metadata and restore them in worker routing.
- Add a non-sensitive capability/dependency status projection and synchronize OpenAPI, Postman, and operator docs.

## Technical Context

**Language/Version**: Node.js 24.18.0, CommonJS  
**Primary dependencies**: Express, Jest, Supertest, existing notification services  
**Persistence**: Existing `scannerPresets` and job repositories  
**Execution**: Web process, scheduler, existing local/Render-worker/Firestore-poller job modes  
**Constraints**: No new dependency or environment variable; destination data must not reach direct market-scanner webhook callers or status payloads; retain legacy preset routing.

## Spec Kit Structure

```text
specs/828-scanner-preset-destinations/
├── spec.md
├── plan.md
└── tasks.md

src/services/scannerPresets/scannerPresetRouting.js
src/services/scannerPresets/ScannerPresetService.js
src/services/notification/requestRouting.js
src/services/scannerPresets/ScannerPresetSchedulerService.js
src/controllers/webhooks/handlers/scannerPresets/scannerPresets.js
src/services/jobs/JobService.js
src/controllers/status.js
src/openapi/openapi.json
CabrosBot.postman_collection.json
README.md
docs/environment-configuration.md

tests/unit/scanner-preset-routing.test.js
tests/unit/scanner-preset-validation.test.js
tests/unit/scanner-preset-scheduler.test.js
tests/unit/job-service.test.js
tests/integration/scanner-presets-endpoint.test.js
tests/integration/status-endpoint.test.js
tests/unit/postman-collection.test.js
```

## Verification

- Observe each focused regression test fail before its corresponding implementation.
- Run affected scanner-preset, routing, job, status, OpenAPI, and Postman suites.
- Run `git diff --check`, parse both contract JSON files, then run `pnpm test` once.
- Verify exact PR-head CI/reviews and the available preview. After merge, run focused E2E against exact `origin/master`; report unavailable live services without inferring success.

## Review Focus

- Inherit and legacy records cannot accidentally narrow or widen recipients.
- Explicit `preset` mode cannot fall through to broadcast when destinations are empty.
- Per-request overrides have deterministic priority and no destination fields reach the direct webhook path.
- Async metadata carries only the resolved routing needed for delivery and is not exposed in ordinary job responses.
- Telegram thread routing, channel availability validation, Discord URL validation, and delivery checkpoints remain intact.
