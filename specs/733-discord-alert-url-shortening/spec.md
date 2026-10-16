# Feature Specification: Discord Alert URL Shortening

**Feature Branch**: `733-discord-alert-url-shortening`  
**Created**: 2026-10-16  
**Status**: In Progress  
**Input**: GitHub issue #733 — add URL-shortening parity to Discord webhook alerts.

## User Scenarios & Testing

### User Story 1 — Shorten source links in Discord alerts (Priority: P1)

When an enriched alert is sent to Discord, the operator expects its source links to be shortened through the URL-shortening service already used for WhatsApp, so both channels carry the same useful links.

**Why this priority**: This is the requested feature and removes inconsistent link formatting across alert channels.

**Independent Test**: Format and send an enriched alert through the Discord notification path with a configured shortener; verify the Discord message contains the same shortened source links as WhatsApp.

**Acceptance Scenarios**:

1. **Given** an enriched alert with source URLs and the shared URL shortener is configured, **When** Discord formats the alert, **Then** the output contains the shortened URLs and matches the WhatsApp source block.
2. **Given** the URL shortener rejects, **When** Discord formats the alert, **Then** the alert still contains the original source URLs.
3. **Given** an alert has no source URLs or no shortener is configured, **When** Discord formats the alert, **Then** formatting succeeds without a shortener call.

## Requirements

### Functional Requirements

- **FR-001**: Discord enriched alerts MUST reuse the existing URL shortener used by WhatsApp.
- **FR-002**: Discord and WhatsApp MUST render equivalent source blocks for the same enriched alert and shortener result.
- **FR-003**: A shortener failure MUST preserve original URLs and MUST NOT block alert delivery.
- **FR-004**: URL shortening MUST remain optional and MUST NOT add an environment variable, endpoint, response field, or external contract.
- **FR-005**: Tests that identify mocked notification requests MUST compare parsed URL hostnames exactly, so host or path lookalikes are not accepted as provider calls.

## Edge Cases

- Shortener rejects or returns no shortened URL: retain the original source URL.
- Enriched alert has an empty or missing sources list: format without invoking the shortener.
- A mocked request URL is malformed or contains a provider name only in its path or a hostile hostname suffix: it must not be selected as a provider request.

## Success Criteria

### Measurable Outcomes

- **SC-001**: For the same enriched alert and successful shortener response, the Discord and WhatsApp source blocks are identical.
- **SC-002**: When shortening fails, both channels still return alert text containing the original source URLs.
- **SC-003**: The cross-channel integration test passes with provider-lookalike requests present in its fetch-call list.

## Scope Notes

- The feature uses the existing `URLShortener` and formatter behavior. It adds no service configuration or API contract.
- GitHub issue #733 records the acceptance scope; no click analytics, per-channel shortening settings, or destination changes are included.
