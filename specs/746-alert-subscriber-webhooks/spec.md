# Feature Specification: Alert-Subscriber Webhooks with HMAC, SSRF Guards, and Firestore-Backed Subscriptions

**Feature Branch**: `feat/gh-746-alert-subscriber-webhooks`  
**Created**: 2026-10-16  
**Status**: Ready for Implementation  
**Input**: GitHub issue [#746](https://github.com/francovp/cabros-bot/issues/746)

## Overview

Currently, downstream consumers (trading bridges, dashboards, secondary bots) have no clean, direct way to subscribe to the bot's alert stream via webhooks. Operators are forced to scrape Telegram messages, which introduces Telegram-specific formatting fragility and breaks whenever channel routing changes.

This feature adds first-class, secure outbound webhook subscriptions for alerts:
1. Operator CRUD APIs (`/api/alert-subscribers`) to manage subscriptions with SSRF validation, private-IP blocks, optional HMAC secrets, and granular filters.
2. An asynchronous, fail-open fan-out delivery engine (`AlertSubscriberDeliveryService`) that dispatches matching alerts with HMAC-SHA256 signatures, DNS-pinned dispatchers, and bounded retries.
3. Dual-mode storage (`AlertSubscriberService`): opt-in durable Cloud Firestore persistence gated by `ENABLE_FIRESTORE_ALERT_SUBSCRIBERS`, falling back gracefully to in-memory ephemeral storage.
4. Non-secret dependency readiness reporting on `/api/status`.
5. An interactive "Alert Subscribers" management panel in the `/admin` operator console with full hosting parity.
6. Complete OpenAPI 3.1, Postman, and documentation contracts.

---

## User Scenarios & Testing

### User Story 1 - Manage Alert Subscriptions via Protected API (Priority: P1)

An operator registers, inspects, updates, and deletes webhook subscriptions via HTTP endpoints. Submissions must reject invalid or dangerous URLs (SSRF / private networks) with HTTP 400 `INVALID_REQUEST`.

**Independent Test**:
Call `POST /api/alert-subscribers` with valid and invalid URLs (e.g. `http://169.254.169.254`, `http://localhost`, valid public HTTPS). Verify acceptance of public HTTPS URLs and rejection of private IPs. Verify secret is never returned in plaintext on `GET /api/alert-subscribers`.

**Acceptance Scenarios**:
1. **Given** valid subscription parameters (`url`, optional `secret`, optional `filter`, `description`, `enabled`), **When** `POST /api/alert-subscribers` is called with operator credentials, **Then** a 201 response returns the created subscriber with a unique ID, createdAt/updatedAt timestamps, redacted secret (`hasSecret: true`), and active status.
2. **Given** a private IP, loopback, or metadata service URL (e.g. `169.254.169.254`), **When** `POST /api/alert-subscribers` is called, **Then** a 400 error (`INVALID_REQUEST` / `SSRF_BLOCKED`) is returned.
3. **Given** existing subscriptions, **When** `GET /api/alert-subscribers` or `GET /api/alert-subscribers/:id` is called, **Then** the secret is omitted or masked, exposing `hasSecret: boolean`.
4. **Given** an existing subscription, **When** `PATCH /api/alert-subscribers/:id` or `DELETE /api/alert-subscribers/:id` is called, **Then** the subscription is updated or deleted accordingly.

### User Story 2 - Asynchronous, Fail-Open Alert Fan-Out (Priority: P1)

When an alert is received and processed (via `POST /api/webhook/alert`), all active subscribers matching the alert's filters receive an outbound HTTP POST webhook without delaying or blocking Telegram/WhatsApp/Discord delivery or the 202 response.

**Independent Test**:
Configure an alert subscriber. Send an alert through `POST /api/webhook/alert`. Verify that the subscriber receives an HTTP POST with headers `x-alert-subscriber-timestamp`, `x-alert-subscriber-event`, `x-alert-subscriber-delivery-id`, and valid HMAC `x-alert-subscriber-signature`. Verify that if the subscriber endpoint times out or returns 500, the primary alert delivery succeeds and the caller receives 202 without delay.

**Acceptance Scenarios**:
1. **Given** active subscribers with matching filters, **When** an alert is ingested, **Then** fan-out is enqueued via `setImmediate` / `trackBackgroundTask`.
2. **Given** a subscriber with a configured `secret`, **When** the payload is dispatched, **Then** `x-alert-subscriber-signature` contains the hex-encoded HMAC-SHA256 signature calculated over `[timestamp, event, deliveryId, payloadStr].join('\n')`.
3. **Given** a subscriber endpoint returns HTTP 5xx or fails DNS, **When** delivery runs, **Then** it retries up to 3 times with exponential backoff using DNS-pinned IP lookups.
4. **Given** a subscriber endpoint returns HTTP 4xx (non-retryable), **When** delivery runs, **Then** no retries occur.

### User Story 3 - Storage & Readiness Status (Priority: P1)

The system persists subscriptions in Firestore when enabled and configured, and in-memory otherwise, reporting non-secret readiness under `/api/status`.

**Independent Test**:
Query `/api/status` with `ENABLE_FIRESTORE_ALERT_SUBSCRIBERS=false` and verify `dependencies.alertSubscribers` reports `mode: 'ephemeral'`, `backend: 'memory'`. Query with the flag enabled and verified Firestore credentials and verify `mode: 'durable'`, `backend: 'firestore'`.

**Acceptance Scenarios**:
1. **Given** `ENABLE_FIRESTORE_ALERT_SUBSCRIBERS` is unset or `false`, **When** `/api/status` is fetched, **Then** `dependencies.alertSubscribers` reports `mode: "ephemeral"`, `backend: "memory"`, and subscriber counts.
2. **Given** `ENABLE_FIRESTORE_ALERT_SUBSCRIBERS` is `true`, **When** `/api/status` is fetched, **Then** `dependencies.alertSubscribers` reports `mode: "durable"`, `backend: "firestore"`.

### User Story 4 - Admin Console Management (Priority: P2)

An operator visits `/admin` and can view, create, edit, test, and delete alert subscribers through a dedicated UI panel.

**Independent Test**:
Open `/admin`, navigate to "Alert Subscribers", add a subscription, inspect the list, test webhook dispatch, and verify `pnpm run build:hosting` maintains parity with zero diff.

---

## Edge Cases

- **SSRF & DNS Rebinding**: Target URLs must be resolved at registration and before every delivery attempt; the resolved IP is verified against private IP ranges and pinned for the HTTP connection.
- **Fail-Open Delivery**: Slow, hanging, or crashing subscriber endpoints must never impact alert ingestion latency or cause alert drops.
- **Secret Redaction**: Subscriber secrets must never be printed in structured logs, status responses, Sentry events, or returned in `GET` responses.
- **Filter Semantics**: Empty filters match all alerts. Non-empty arrays require at least one match (symbol match is case-insensitive).
- **Process Shutdown**: In-flight webhook deliveries are tracked via `trackBackgroundTask` to allow bounded drain on `SIGTERM`.

---

## Requirements

### Functional Requirements
- **FR-001**: `POST /api/alert-subscribers` creates a subscriber; validates URL against SSRF; requires operator role or API key.
- **FR-002**: `GET /api/alert-subscribers` lists subscribers without exposing plain secrets.
- **FR-003**: `GET /api/alert-subscribers/:id` retrieves single subscriber details.
- **FR-004**: `PATCH /api/alert-subscribers/:id` updates subscription settings; `DELETE /api/alert-subscribers/:id` deletes it.
- **FR-005**: `POST /api/alert-subscribers/:id/test` sends an immediate test alert to verify connectivity and signature.
- **FR-006**: Outbound deliveries carry headers: `x-alert-subscriber-timestamp`, `x-alert-subscriber-event: alert.dispatched`, `x-alert-subscriber-delivery-id: <uuid>`, and `x-alert-subscriber-signature` if secret is configured.
- **FR-007**: Outbound HTTP requests use DNS-pinned lookup and a 5-second AbortController timeout.
- **FR-008**: Dual-mode storage (`AlertSubscriberService`): Firestore (`alertSubscribers` collection) when `ENABLE_FIRESTORE_ALERT_SUBSCRIBERS=true`, memory otherwise.
- **FR-009**: `/api/status` includes `dependencies.alertSubscribers` reporting readiness, mode, backend, and counts.
- **FR-010**: OpenAPI 3.1 specification, Postman collection, README, and `.env.example` are kept in sync.
- **FR-011**: `/admin` console provides an Alert Subscribers tab/panel, with hosting assets built via `pnpm run build:hosting` and parity verified.

---

## Success Criteria

- **SC-001**: All new unit and integration tests pass cleanly with `pnpm test`.
- **SC-002**: `tests/unit/admin-hosting-parity.test.js` passes with zero divergence.
- **SC-003**: `git status --porcelain` is clean after running tests.
- **SC-004**: Outbound deliveries never block core alert ingestion or notification channels.
