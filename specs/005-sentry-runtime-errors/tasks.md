---

description: "Task list for feature 005-sentry-runtime-errors (Sentry runtime error monitoring)"

---

# Tasks: Sentry Runtime Errors Integration

**Input**: Design documents from `/specs/005-sentry-runtime-errors/`

- `plan.md` – implementation plan and project structure
- `spec.md` – user stories, priorities, and functional requirements
- `data-model.md` – internal entities for monitoring events and configuration
- `contracts/api.md` – internal monitoring contracts and tagging rules
- `research.md` – decisions about `@sentry/node` usage and configuration
- `quickstart.md` – manual verification and rollout steps

**Prerequisites**: Existing Node.js service with Express HTTP endpoints, Telegram/WhatsApp notification services, and Jest test setup.

**Tests**: The specification explicitly expects tests ("User Scenarios & Testing" and plan Testing Policy). Each user story below includes test tasks.

**Organization**: Tasks are grouped by phase and by user story so each story can be implemented and tested independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare Sentry dependencies and basic monitoring structure without changing runtime behavior.

- [ ] T001 Update Sentry dependency in `package.json` to add `@sentry/node` (v8) to the `dependencies` section for the Node.js service
- [ ] T002 [P] Create monitoring service directory `src/services/monitoring/` to host `SentryService.js` and related helpers
- [ ] T003 [P] Configure Jest global setup in `jest.config.js` and `tests/setup.js` so `@sentry/node` and the monitoring layer can be safely mocked without sending real events

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core Sentry monitoring infrastructure that MUST be complete before any user story can be fully implemented.

**⚠️ CRITICAL**: No user story work should be considered complete until this phase is done.

- [ ] T004 Implement `MonitoringConfiguration` and `MonitoringServiceState` structures and helpers in `src/services/monitoring/SentryService.js` following `specs/005-sentry-runtime-errors/data-model.md`
- [ ] T005 Implement environment and release derivation logic in `src/services/monitoring/SentryService.js` using `ENABLE_SENTRY`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `RENDER`, `IS_PULL_REQUEST`, `NODE_ENV`, and `RENDER_GIT_COMMIT`
- [ ] T006 Implement `SentryService.init()` in `src/services/monitoring/SentryService.js` to configure `@sentry/node` once at startup, update internal state, and avoid throwing when configuration is missing or invalid
- [ ] T007 Implement a generic `SentryService.captureEvent({ event })` helper in `src/services/monitoring/SentryService.js` that accepts an `ErrorEvent`, applies tags/contexts, calls the underlying Sentry SDK when enabled, and returns a `MonitoringCaptureResult`
- [ ] T008 Implement convenience wrappers in `src/services/monitoring/SentryService.js` (for example `captureRuntimeError` and `captureExternalFailure`) that build `ErrorEvent` skeletons for runtime and external failures before delegating to `captureEvent`
- [ ] T009 Wire `SentryService.init()` into the application startup in `index.js` so monitoring is initialized once when the process starts, without altering existing Express or Telegram/WhatsApp boot logic

**Checkpoint**: Monitoring layer initialized and callable as a no-op when disabled; user stories can now add specific capture points.

---

## Phase 3: User Story 1 - Ver errores críticos en Sentry (Priority: P1) 🎯 MVP

**Goal**: Capturar automáticamente en Sentry los errores en tiempo de ejecución en los flujos principales (webhook de alertas, endpoint de news monitor, comandos de Telegram y envío de WhatsApp) con suficiente contexto (entorno, canal, ruta, identificador de request) para poder diagnosticarlos sin depender solo de los logs de consola.

**Independent Test**: Forzar un error controlado en cada tipo de flujo (por ejemplo, simulando un fallo en una dependencia) y verificar que, en un entorno donde Sentry está habilitado, aparece un evento por cada error en el proyecto Sentry esperado, con tags que indiquen el canal y el entorno, sin cambiar la respuesta observable para el usuario final.

### Tests for User Story 1

- [ ] T010 [US1] Add unit tests in `tests/unit/sentry-service.test.js` to verify that `SentryService` builds `ErrorEvent` objects with correct `channel`, `type`, `environment`, and `http`/`alert`/`news` contexts for `http-alert`, `news-monitor`, `telegram`, and `whatsapp` channels (Sentry SDK mocked)
- [ ] T011 [US1] Add integration tests in `tests/integration/sentry-runtime-errors.test.js` that, with Sentry enabled, force controlled runtime errors in `/api/webhook/alert`, `/api/news-monitor`, a Telegram command, and a WhatsApp send, and assert that exactly one monitoring call is made per incident with expected tags and contexts

### Implementation for User Story 1

- [ ] T012 [US1] Instrument the alert webhook handler in `src/controllers/webhooks/handlers/alert/alert.js` so that unexpected exceptions in `postAlert` (catch block) call `SentryService.captureRuntimeError` with `channel='http-alert'`, `type='runtime_error'`, and an `HttpErrorContext`/`AlertContext` built from the request, status code, and alert payload
- [ ] T013 [US1] Instrument the news monitor handler in `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js` so that unexpected exceptions in `NewsMonitorHandler.handleRequest` (catch block) call `SentryService.captureRuntimeError` with `channel='news-monitor'`, `type='runtime_error'`, and an `HttpErrorContext`/`NewsContext` including `requestId`, endpoint, status code, and summary fields
- [ ] T014 [US1] Extend `sendToAll` in `src/services/notification/NotificationManager.js` to detect final delivery failures per channel (after retries or single attempt) and call `SentryService.captureExternalFailure` with `channel`, `type='external_failure'`, and `ExternalFailureContext` derived from each channel `SendResult` and `sendWithRetry` metadata
- [ ] T015 [US1] Instrument Telegram command handlers in `src/controllers/commands.js` so that errors in `getPrice` and `cryptoBotCmd` are reported via `SentryService.captureRuntimeError` with `channel='telegram'` (while still logging to console as today)
- [ ] T016 [US1] Ensure `SentryService` consistently sets `channel` and `feature` tags for alerts (`http-alert`, `telegram`, `whatsapp`) and news monitor (`news-monitor`) in `src/services/monitoring/SentryService.js`, aligning with `specs/005-sentry-runtime-errors/contracts/api.md`

**Checkpoint**: All main flows (alert webhook, news monitor endpoint, Telegram commands, WhatsApp sends) produce one well-tagged Sentry event per unexpected runtime error when monitoring is enabled.

---

## Phase 4: User Story 2 - Mantener comportamiento actual de usuario y fallback (Priority: P2)

**Goal**: Garantizar que la integración con Sentry no cambia las respuestas HTTP ni el comportamiento visible de Telegram/WhatsApp (incluidos los fallbacks ya implementados), de modo que el sistema siga siendo resiliente aunque Sentry esté mal configurado o caído.

**Independent Test**: Ejecutar los mismos escenarios de error con y sin Sentry habilitado y comprobar que, desde el punto de vista del cliente HTTP o del usuario de Telegram/WhatsApp, las respuestas y mensajes son idénticos, incluso cuando Sentry no puede enviar eventos (por ejemplo, DSN inválido o red caída).

### Tests for User Story 2

- [ ] T017 [US2] Add integration tests in `tests/integration/sentry-runtime-errors.test.js` that compare responses for `/api/webhook/alert`, `/api/news-monitor`, Telegram, y WhatsApp con `ENABLE_SENTRY=false`, con `ENABLE_SENTRY=true` y DSN válido, y con `ENABLE_SENTRY=true` y DSN inválido, verificando que los códigos de estado y cuerpos de respuesta se mantienen idénticos
- [ ] T018 [US2] Add unit tests in `tests/unit/sentry-service.test.js` to verify that `SentryService.captureEvent` and its wrappers never throw (even if the underlying Sentry SDK rejects or times out), returning `captured=false` with a `skippedReason` when appropriate

### Implementation for User Story 2

- [ ] T019 [US2] Harden `SentryService.captureEvent` in `src/services/monitoring/SentryService.js` by wrapping Sentry SDK calls in `try/catch`, logging failures at debug/info level, and ensuring errors are swallowed so callers never see monitoring-related exceptions
- [ ] T020 [US2] Ensure `SentryService.init()` in `src/services/monitoring/SentryService.js` marks monitoring as disabled when `ENABLE_SENTRY!=='true'` or `SENTRY_DSN` is missing/empty, recording an appropriate `lastInitError` or `skippedReason` without affecting process startup or Express/Telegraf initialization
- [ ] T021 [US2] Review and, if needed, adjust monitoring call sites in `src/controllers/webhooks/handlers/alert/alert.js`, `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`, `src/services/notification/NotificationManager.js`, and `src/controllers/commands.js` so they do not change control flow or response payloads based on monitoring success/failure
- [ ] T022 [US2] Add defensive guards in monitoring integration code (for example, around async `capture` calls or logging) in `src/services/monitoring/SentryService.js` and call sites so that transient Sentry outages (network, DNS, timeouts) never block Telegram/WhatsApp sends or HTTP responses

**Checkpoint**: With Sentry misconfigured or failing, the system behaves identically for clients and users; monitoring failures are invisible externally.

---

## Phase 5: User Story 3 - Control de entornos y privacidad de datos (Priority: P3)

**Goal**: Permitir decidir en qué entornos se activan los envíos a Sentry (desarrollo, preview, producción) y qué parte del contenido de las alertas/noticias se envía, para equilibrar visibilidad operacional, costos y privacidad.

**Independent Test**: Configurar el sistema con distintas combinaciones de variables de entorno (por ejemplo, sólo producción, producción+preview, desactivado en local) y verificar que los errores se reportan solo en los entornos configurados, y que el contenido incluido en los eventos sigue la política de privacidad definida.

### Tests for User Story 3

- [ ] T023 [US3] Add unit tests in `tests/unit/sentry-service.test.js` that cover `MonitoringConfiguration` resolution for combinations of `ENABLE_SENTRY`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, `RENDER`, `IS_PULL_REQUEST`, `NODE_ENV`, and `RENDER_GIT_COMMIT`, including `sendAlertContent` behavior and `enabled` flag
- [ ] T024 [US3] Add integration tests in `tests/integration/sentry-runtime-errors.test.js` that simulate errors in local, preview, and production-like environments and verify that events are only reported when configuration allows it, and that event payloads obey the chosen content/anonimization policy

### Implementation for User Story 3

- [ ] T025 [US3] Extend `MonitoringConfiguration` in `src/services/monitoring/SentryService.js` to include `sendAlertContent` and `sampleRateErrors` fields, defaulting to `sendAlertContent=true` and `sampleRateErrors=1.0` per `specs/005-sentry-runtime-errors/data-model.md`
- [ ] T026 [US3] Finalize environment and enablement gating in `src/services/monitoring/SentryService.js` so that `enabled` is true only when `ENABLE_SENTRY==='true'` and `SENTRY_DSN` is non-empty, deriving `environment` and `release` according to `specs/005-sentry-runtime-errors/research.md`
- [ ] T027 [US3] Implement payload shaping in `SentryService.captureEvent` in `src/services/monitoring/SentryService.js` to include full alert/news text only when `sendAlertContent` allows it, otherwise sending only summarized fields (`textLength`, `symbolCount`, etc.) via `AlertContext` and `NewsContext`
- [ ] T028 [US3] Ensure all Sentry events set required tags (`environment`, `channel`, `feature`) and attach the appropriate context blocks (`http`, `external`, `alert`, `news`) as defined in `specs/005-sentry-runtime-errors/contracts/api.md` and `data-model.md`
- [ ] T029 [US3] Update monitoring integration logic in `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`, `src/services/notification/WhatsAppService.js`, and related call sites so that expected behaviors for disabled features (e.g., `ENABLE_NEWS_MONITOR!=='true'`, `ENABLE_WHATSAPP_ALERTS!=='true'`) or validation 4xx responses do NOT generate Sentry events, satisfying FR-006

**Checkpoint**: Monitoring is correctly scoped by environment and privacy policy; operators can see only the intended events, with appropriate content level, for the right deployments.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cross-story improvements, documentation, and final verification.

- [ ] T030 [P] Update `README.md` to document the Sentry runtime error monitoring feature, environment variables (`ENABLE_SENTRY`, `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, etc.), and link to `specs/005-sentry-runtime-errors/quickstart.md`
- [ ] T031 [P] Align `specs/005-sentry-runtime-errors/quickstart.md` and `specs/005-sentry-runtime-errors/plan.md` with the final implementation details (helper names, tag values, environment derivation examples)
- [ ] T032 Run the full Jest test suite (unit + integration) under `tests/` and fix any Sentry-related regressions, flaky tests, or configuration issues discovered
- [ ] T033 Perform code cleanup and logging normalization in `src/services/monitoring/SentryService.js`, `src/controllers/webhooks/handlers/alert/alert.js`, `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`, `src/services/notification/NotificationManager.js`, `src/services/notification/TelegramService.js`, and `src/services/notification/WhatsAppService.js` to keep error handling and logs consistent
- [ ] T034 [P] Manually validate the scenarios described in `specs/005-sentry-runtime-errors/quickstart.md` (with Sentry enabled, disabled, and misconfigured) against a local environment and adjust documentation or implementation as needed

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies – can start immediately to add `@sentry/node` and testing scaffolding.
- **Foundational (Phase 2)**: Depends on Setup completion; MUST be finished before user stories are considered complete because it provides `SentryService` and configuration helpers.
- **User Story 1 (Phase 3, P1)**: Depends on Foundational. Implements the core runtime error capture points and is the **MVP**.
- **User Story 2 (Phase 4, P2)**: Depends on Foundational and the basic capture points from User Story 1; it hardens non-intrusive behavior.
- **User Story 3 (Phase 5, P3)**: Depends on Foundational and basic capture from User Story 1; it refines environment gating and privacy/content policy.
- **Polish (Phase 6)**: Depends on all desired user stories being complete.

### User Story Dependencies

- **User Story 1 (US1, P1)**: Can start after Phase 2; no dependency on other stories and defines the MVP behavior for runtime error visibility.
- **User Story 2 (US2, P2)**: Conceptually independent in requirements but practically depends on US1 instrumentation to validate that Sentry does not affect existing behavior for the same flows.
- **User Story 3 (US3, P3)**: Depends on US1 to have real events to scope and shape; may be implemented in parallel with US2 once the foundational monitoring layer and basic capture points exist.

### Within Each User Story

- Prefer to implement or extend tests (T010–T011, T017–T018, T023–T024) before or in lockstep with implementation tasks to keep behavior well-specified.
- For each story:
  - Define or refine service helpers in `src/services/monitoring/SentryService.js`.
  - Wire or adjust call sites (`alert.js`, `newsMonitor.js`, `NotificationManager.js`, `TelegramService.js`, `WhatsAppService.js`, `commands.js`).
  - Validate via unit + integration tests under `tests/` and, finally, via quickstart steps.

### Parallel Opportunities

- **Setup (Phase 1)**
  - T002 and T003 can run in parallel with T001 once the overall plan is agreed, as they touch distinct files (`src/services/monitoring/`, `jest.config.js`, `tests/setup.js`).

- **After Foundational (Phase 2)**
  - Implementation tasks for different entrypoints in US1 (T012–T015) modify different files and can be split across contributors, coordinated via the shared `SentryService` helpers.
  - US2 (hardening and non-intrusive behavior) and US3 (env/privacy controls) can proceed largely in parallel once US1’s core capture wiring is in place, provided teams coordinate changes in `SentryService`.

- **Polish (Phase 6)**
  - Documentation-related tasks (T030, T031) and manual quickstart validation (T034) can run in parallel with code cleanup (T033).

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 (T001–T003) and Phase 2 (T004–T009) to establish the monitoring layer.
2. Implement User Story 1 (T010–T016) to ensure all main flows produce Sentry events on unexpected errors.
3. Run the focused tests for US1 and manually verify at least one event per flow in Sentry.
4. At this point, the system gains immediate observability with no behavior changes – this is the **MVP**.

### Incremental Delivery

1. **Iteration 1**: Phases 1–2 + Phase 3 (US1) → deploy to a non-production environment and validate events.
2. **Iteration 2**: Phase 4 (US2) → harden behavior so Sentry failures never affect HTTP or messaging semantics.
3. **Iteration 3**: Phase 5 (US3) → tune environment gating and content/privacy, then roll out to production.
4. **Iteration 4**: Phase 6 (Polish) → finalize docs, cleanup, and long-running tests.

### Parallel Team Strategy

- After Phase 2:
  - Developer A focuses on US1 wiring and integration tests (T010–T016).
  - Developer B works on US2 hardening and non-intrusive behavior (T017–T022).
  - Developer C works on US3 configuration, environment gating, and privacy controls (T023–T029).
- All developers collaborate on final polish tasks (T030–T034) before release.
