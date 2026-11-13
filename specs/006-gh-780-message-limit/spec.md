# Feature Specification: Configurable generic message limit

**Feature Branch**: `006-gh-780-message-limit`
**Created**: 2026-10-10
**Status**: Draft
**Input**: User description: "Make the generic message webhook maximum length operator-configurable (GH-780), preserving the current 4000-character default and bounded 1..20000 range."

## User Scenarios & Testing

### User Story 1 - Configure the webhook message limit (Priority: P1)

An operator needs to accommodate longer or shorter messages sent through the generic message webhook without changing application code. The existing truncation notice and delivery behavior remain predictable for callers.

**Why this priority**: An operator-controlled limit resolves the only unshipped part of GH-780; response truncation metadata already shipped through canonical issue #602.

**Independent Test**: Send messages below, at, and above a configured limit with channel delivery mocked. Confirm the effective cap, the existing truncation response fields, and unchanged behavior when no override is supplied.

**Acceptance Scenarios**:

1. **Given** no valid override, **When** a message exceeds 4,000 characters, **Then** the existing 4,000-character cap and truncation response are used.
2. **Given** a valid configured limit, **When** a message exceeds that limit, **Then** the message is clipped at that limit and the existing `truncated`, `originalLength`, and `deliveredLength` fields describe the result.
3. **Given** a message at or below the effective limit, **When** it is submitted, **Then** it is delivered without truncation and the ordinary response shape remains unchanged.
4. **Given** a missing or invalid environment value, **When** a message is submitted, **Then** the 4,000-character default is used and alert delivery continues. An invalid Remote Config value is ignored so the valid environment value, or the default when unset/invalid, remains effective.
5. **Given** a valid fresh Remote Config value, **When** a message is submitted, **Then** the webhook uses that value; when Remote Config is unavailable or stale, the environment/default fallback remains available.

### Edge Cases

- Limits at the inclusive bounds of 1 and 20,000 characters are accepted. Invalid environment values use the default; invalid Remote Config values are ignored so the valid environment value or default stays effective.
- A message exactly at the effective limit is not clipped. A longer message retains the existing `...` suffix behavior.
- Remote Config load failures or stale values must not prevent webhook delivery.
- Truncation logs contain only numeric lengths and the effective limit, never message content.

## Requirements

### Functional Requirements

- **FR-001**: Operators MUST be able to configure the maximum accepted message length for `POST /api/webhook/message` as an integer from 1 through 20,000.
- **FR-002**: The effective limit MUST default to 4,000 characters when no valid override is available.
- **FR-003**: The webhook MUST use a valid fresh remote setting when available, and otherwise use the configured environment value or the 4,000-character default.
- **FR-004**: Invalid environment values MUST use the 4,000-character default. Invalid Remote Config values MUST be ignored so the valid environment value, or the 4,000-character default when unset/invalid, remains effective; invalid settings MUST NOT block or disable message delivery.
- **FR-005**: The webhook MUST preserve the already-shipped truncation response fields and include them only when truncation occurs.
- **FR-006**: The operator-facing setting MUST be documented with its default, accepted range, and fallback behavior.
- **FR-007**: The setting MUST NOT expose secrets or alter webhook authentication, notification routing, or idempotency behavior.

## Assumptions

- The 4,000-character default and 1..20,000 accepted range follow the repository owner's GH-780 follow-up direction.
- The existing `/api/webhook/message` response contract remains authoritative; this feature changes only how its cap is selected.
- The limit applies to the existing message truncation path and does not change provider-specific chunking.

## Success Criteria

### Measurable Outcomes

- **SC-001**: With the default configuration, every message longer than 4,000 characters follows the existing truncation behavior and reports the existing truncation metadata.
- **SC-002**: With a valid override, messages are clipped at the configured threshold; messages at or below it are not clipped.
- **SC-003**: Missing or invalid environment settings resolve to 4,000; invalid Remote Config settings leave the valid environment value or 4,000 default effective without turning a valid request into an error.
- **SC-004**: The current response shape, delivery routing, and truncation metadata remain unchanged apart from the effective threshold.
- **SC-005**: Operators can identify the setting, default, valid range, and fallback behavior from repository operator documentation.
