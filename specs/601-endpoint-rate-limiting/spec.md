# Feature Specification: Per-Endpoint Rate Limiting

**Feature Branch**: `codex/issue-601-rate-limit-20261022`
**Created**: 2026-10-22
**Status**: In Progress
**Input**: GitHub issue #601 — add separate request limits for expensive API operations.

## User Scenarios & Testing

### User Story 1 — Protect provider-intensive operations (Priority: P1)

An operator needs expensive webhook and API operations to have independent request budgets, so a client cannot consume all available TradingView, Gemini, or Binance capacity while staying under the ordinary global limit.

**Why this priority**: Provider quotas and external-service availability are the primary risks in issue #601.

**Independent Test**: Send requests to each mapped operation through the app-level middleware and verify its tier limit produces a 429 without consuming another endpoint's bucket.

**Acceptance Scenarios**:

1. **Given** a client has used all five requests for a heavy endpoint in a 60-second window, **When** it sends one more request to that endpoint, **Then** the response is 429 with `RATE_LIMITED` and a positive `retryAfterSeconds`.
2. **Given** one heavy endpoint is exhausted, **When** the same client calls a different mapped endpoint, **Then** the other endpoint's independent bucket remains available.
3. **Given** an operator sets a valid tier maximum, **When** requests arrive, **Then** the configured value is used for that tier.

### User Story 2 — Retry safely from a throttling response (Priority: P2)

A client needs a consistent error envelope and rate-limit headers to understand its quota and retry timing.

**Why this priority**: Clear retry metadata prevents blind retries and gives operators useful API documentation.

**Independent Test**: Exhaust one mapped endpoint and compare its headers and JSON body with the OpenAPI and Postman examples.

**Acceptance Scenarios**:

1. **Given** a request is throttled, **When** the API returns 429, **Then** it includes `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`, and `X-Request-Id`.
2. **Given** a request is throttled, **When** the client reads the response body, **Then** it contains `success: false`, `code: RATE_LIMITED`, `retryable: true`, and a positive integer `retryAfterSeconds`.

### User Story 3 — Preserve established webhook and authentication behavior (Priority: P3)

Existing alert producers need their established burst allowance and identity boundary to remain stable while the costly operations receive tighter limits.

**Why this priority**: Cutting the alert/message ingest limit would break existing provider bursts, and changing identity could make API keys or proxy addresses bypass the limiter.

**Independent Test**: Verify every webhook/news ingest path shares the existing 1,000-request aggregate bucket, tiered webhook routes also enforce their per-endpoint caps, and buckets retain the existing API-key hash plus trusted client IP identity.

**Acceptance Scenarios**:

1. **Given** webhook/news ingest requests collectively remain below the existing aggregate cap and a mapped endpoint remains below its own tier, **When** those requests arrive, **Then** they are accepted without a new 30-request cap on alert/message ingest.
2. **Given** requests share an API key but have different trusted client IPs, **When** either caller reaches its limit, **Then** the other caller's bucket remains independent.
3. **Given** a caller varies query strings, trailing slash, or path casing, **When** it addresses the same mapped endpoint, **Then** it remains in the same endpoint bucket.

## Edge Cases

- Invalid, zero, negative, unsafe, or non-integer tier values fall back to the tier default and do not disable rate limiting.
- A throttled response reports zero remaining requests and a retry delay of at least one second.
- Health, readiness, OpenAPI, documentation, admin static assets, and public routes mounted before the limiter remain outside its scope.
- Buckets are process-local, matching the existing limiter. Multiple service replicas can each admit their own tier budget.

## Requirements

### Functional Requirements

- **FR-001**: The middleware MUST apply an independent fixed 60-second bucket to each configured tier endpoint.
- **FR-002**: Heavy tier MUST default to 5 requests for expanded-analysis, market-scanner, symbol-analysis, and news-monitor operations.
- **FR-003**: Trading tier MUST default to 10 requests for Binance order reads, writes, and previews.
- **FR-004**: Standard tier MUST default to 30 requests for volume-confirmation.
- **FR-005**: Light tier MUST default to 100 requests for `/api/status` and `/api/capabilities`.
- **FR-006**: `RATE_LIMIT_TIER_HEAVY_MAX`, `RATE_LIMIT_TIER_TRADING_MAX`, `RATE_LIMIT_TIER_STANDARD_MAX`, and `RATE_LIMIT_TIER_LIGHT_MAX` MUST accept positive integer overrides and otherwise use their safe defaults.
- **FR-007**: All webhook/news ingest paths MUST share the existing finite 1,000-request bucket per `RATE_LIMIT_WINDOW_MS`; mapped webhook endpoints MUST also enforce their per-endpoint tier, while plain alert and generic-message ingest have no additional tier.
- **FR-008**: The endpoint bucket identity MUST retain the existing API-key hash and trusted client IP behavior without storing the raw API key.
- **FR-009**: A 429 response MUST contain the standard retryable error envelope and all emitted rate-limit and request-correlation headers.
- **FR-010**: OpenAPI, Postman examples, operator documentation, and tests MUST describe the same endpoint tiers and 429 response shape.
- **FR-011**: Tier limits MUST remain environment-only security controls and MUST NOT be exposed through Firebase Remote Config.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Focused unit and integration tests demonstrate each tier's limit, independent bucket identity, and normalized endpoint matching.
- **SC-002**: Every OpenAPI operation referencing the shared 429 response has a Postman saved 429 example with the runtime error text and required headers.
- **SC-003**: Invalid tier configuration retains the safe default rather than disabling throttling.
- **SC-004**: Existing alert/message ingest behavior and pre-limiter health/documentation routes retain their previous behavior.

## Scope Notes

- All webhook/news ingest paths share the existing 1,000-request per-global-window aggregate cap to preserve provider burst isolation; mapped webhook routes layer their endpoint tiers on top. Alert and message have only the aggregate cap.
- `/healthcheck`, `/ready`, `/openapi.json`, `/docs`, `/admin`, and static assets are mounted before the limiter and are not assigned the light tier. Only the mounted `/api/status` and `/api/capabilities` operations use light limits.
- The in-memory limiter is per process. A shared cross-replica limiter is outside this issue's current implementation scope.
