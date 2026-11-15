# Feature Specification: Managed shutdown draining for webhook alert timers

**Feature Branch**: `766-background-timer-drain`  
**Created**: 2026-10-19  
**Status**: In Progress  
**Input**: GitHub issue #766, including its acceptance criteria and the explicit webhook-alert scope.

## User Scenarios & Testing

### User Story 1 - Shutdown without recurring alert work (Priority: P1)

An operator deploys or stops the bot while notification and alert-related background timers are active. Shutdown must stop new timer ticks, then wait for already-running asynchronous callbacks within a bounded budget before final process exit.

**Why this priority**: A recurring callback after teardown can touch closed Firestore clients or keep duplicating work while the process drains.

**Independent Test**: Start a managed interval whose callback is blocked on a controllable promise, request shutdown, and verify no new tick starts and shutdown waits for that callback or records a bounded timeout.

**Acceptance Scenarios**:

1. Given active service timers, when SIGTERM begins, then recurring timers are stopped before final exit and active callbacks are drained within the configured finalization bound.
2. Given a callback is still pending at its timer budget, when draining completes, then the timer is counted as failed and the process can continue its bounded shutdown.
3. Given a timer has no active callback, when stopped, then it is removed from the active registry and counted as drained.

### User Story 2 - Operators can verify timer cleanup (Priority: P2)

An operator reads the status endpoint after startup or a shutdown-time diagnostic event and can distinguish active, drained, and failed timer counts without receiving callback names, payloads, or credentials.

**Why this priority**: Aggregate evidence makes recurring work visible without exposing internal timer details.

**Independent Test**: Read GET /api/status and verify the timer counts are present, non-sensitive, and match registry state; verify the shutdown summary is reported before Sentry flush.

**Acceptance Scenarios**:

1. Given registered timers, when GET /api/status is read, then dependencies.backgroundTimers contains only registered, drained, and failed counts.
2. Given one or more timer drains fail, when shutdown reports completion, then a bounded summary is sent to Sentry and timer names or callback data are not included in the status response.

### User Story 3 - Existing service timer behavior stays stable (Priority: P3)

A service starts, stops, or unrefs its recurring timer using the shared managed interval while preserving the existing cadence and work behavior.

**Why this priority**: The shutdown fix must cover current service-owned intervals without changing normal alert delivery or worker scheduling.

**Independent Test**: Run the service-specific worker and scheduler tests, then audit src/services for raw setInterval calls outside the registry helper.

**Acceptance Scenarios**:

1. Given a service timer is stopped locally, when it is stopped again during process shutdown, then cleanup remains safe and idempotent.
2. Given an interval is unrefed today, when it uses the managed helper, then it remains unrefed and does not keep the event loop alive.

## Edge Cases

- A callback throws synchronously or rejects asynchronously.
- Multiple callbacks are in flight when shutdown starts.
- A timer is stopped twice or locally cleared before global shutdown.
- A stop operation or callback exceeds its bounded drain budget.
- Shutdown begins while background job and persistence drains are still running.

## Requirements

### Functional Requirements

- **FR-001**: Every recurring timer created in src/services MUST register with the shared managed timer registry.
- **FR-002**: Stopping a managed interval MUST prevent future ticks before awaiting active callbacks.
- **FR-003**: Active asynchronous callbacks MUST be awaited within a bounded per-timer budget; timed-out callbacks MUST be recorded as failed without blocking other timer drains.
- **FR-004**: Process shutdown MUST stop service workers, await background jobs and persistence tasks, drain registered timers, report the aggregate result, and flush Sentry before exit.
- **FR-005**: Timer cleanup MUST be fail-open: an individual stop or callback failure MUST not prevent other cleanup or process exit.
- **FR-006**: GET /api/status MUST expose only aggregate registered, drained, and failed timer counts.
- **FR-007**: Existing timer cadence, ref/unref behavior, alert routing, and environment defaults MUST remain unchanged.
- **FR-008**: The status contract documentation and Postman examples MUST describe the additive timer statistics field.

## Success Criteria

- **SC-001**: No raw setInterval remains in src/services outside the shared managed interval implementation.
- **SC-002**: An in-flight callback is either drained or recorded as failed within the timer drain budget.
- **SC-003**: Timer drain failures do not prevent the remaining shutdown stages from running.
- **SC-004**: Status responses contain aggregate counts only, and contract tests confirm the additive field.
- **SC-005**: Existing alert delivery and worker-specific test suites pass.
