# Implementation Plan: Managed shutdown draining for webhook alert timers

**Branch**: `766-background-timer-drain` | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `specs/766-background-timer-drain/spec.md`

## Summary

Track service-owned recurring timers through a shared registry, stop future ticks during shutdown, and wait for active asynchronous callbacks within a bounded budget. Report aggregate drain counts in the status contract and through the existing Sentry shutdown path. Preserve the current timer cadence, ref/unref behavior, and alert delivery flow.

## Technical Context

**Language/Version**: Node.js 24.x  
**Primary Dependencies**: Existing Node.js runtime, Express, Jest; no dependency additions  
**Storage**: None; registry state is process-local  
**Testing**: Jest unit and integration suites  
**Target Platform**: Render Node.js service and worker processes  
**Project Type**: Single Node.js service  
**Performance Goals**: Timer drain must respect the existing shutdown finalization budget; independent timers drain concurrently  
**Constraints**: No new environment variables, endpoints, credentials, or persistent state; status data must contain counts only  
**Scale/Scope**: Existing recurring intervals under src/services, process lifecycle, and the additive status response field

## Constitution Check

- Code quality and simplicity: reuse the existing process lifecycle and existing service stop methods.
- Testing: exercise timer registration, callback drain, timeout, and shutdown ordering with focused Jest coverage.
- Compatibility: retain timer intervals and ref/unref semantics; keep the status field additive.
- Security: expose only aggregate counts and no timer names, callback payloads, or credentials.
- Dependencies and configuration: no new package or environment setting.

## Project Structure

Documentation for this feature lives under specs/766-background-timer-drain/.

Source files involved:

- src/lib/backgroundTimerRegistry.js
- src/lib/processLifecycle.js
- index.js
- src/controllers/status.js
- recurring timer owners under src/services/
- src/openapi/openapi.json
- CabrosBot.postman_collection.json
- tests/unit/background-timer-registry.test.js
- tests/unit/process-lifecycle.test.js
- tests/integration/status-endpoint.test.js
- tests/unit/postman-collection.test.js
- worker.js
- tests/unit/worker-sentry-shutdown.test.js

**Structure Decision**: Keep the helper in src/lib, service ownership in existing src/services modules, and orchestration in the API lifecycle and dedicated worker shutdown.

## Design Decisions

1. Keep active registry state in memory because timer handles and callbacks are process-local.
2. Clear each interval before waiting for its active callback so no new sweep starts during shutdown.
3. Drain timers concurrently under the existing finalization budget and continue when one timer fails.
4. Report only counts in GET /api/status; use the existing Sentry flush path for a bounded shutdown summary.
5. Do not change scheduling cadence, environment defaults, or alert request routing.

## Complexity Tracking

No constitution violations or new dependencies.
