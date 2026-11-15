# Implementation Plan: Per-Endpoint Rate Limiting

**Branch**: `codex/issue-601-rate-limit-20261022` | **Date**: 2026-10-22 | **Spec**: [spec.md](spec.md)
**Input**: GitHub issue #601

## Summary

Extend the existing Express rate limiter with independent 60-second endpoint buckets for expensive provider-backed operations. Keep the existing API-key-hash plus trusted-IP identity, global and webhook-ingest behavior, and return the runtime's complete 429 headers and retryable error envelope in OpenAPI and Postman.

## Technical Context

**Language/Version**: JavaScript, Node.js 24.18.0
**Primary Dependencies**: Existing Express middleware and Node.js `crypto`; no new dependencies
**Storage**: Existing in-memory `Map` buckets
**Testing**: Jest unit, integration, OpenAPI, Postman, and environment-documentation tests
**Target Platform**: Node.js service
**Project Type**: Single Express service
**Performance Goals**: Constant-time map lookup per request, bounded by the existing 10,000-key cap
**Constraints**: Keep route mounts and existing burst behavior stable; invalid tier values fall back to defaults; rate-limit settings remain environment-only security controls.
**Scale/Scope**: App-level middleware and its configuration/API documentation for mapped API routes.

## Constitution Check

- **Code Quality & Readability**: Pass. Reuse the existing limiter, identity helper, and error-envelope implementation.
- **Simplicity & Minimalism**: Pass. Add a route-to-tier map; do not add dependencies, persistence, or another middleware layer.
- **Testing Policy**: Pass. Add focused coverage for bucket limits, identity, normalization, headers, and documentation parity.
- **Review & Quality Gates**: Pending exact-head CI, review discussion resolution, and OpenClaw preview/E2E evidence.
- **Incremental Delivery & Versioning**: Pass. This adds 429 response documentation and tuning variables without changing success responses.

## Project Structure

```text
src/
├── lib/rateLimiter.js
└── routes/index.js

src/openapi/openapi.json
CabrosBot.postman_collection.json
.env.example
README.md
docs/environment-configuration.md
tests/
├── unit/rateLimiter.test.js
├── unit/openapi-contract.test.js
├── unit/postman-collection.test.js
└── integration/rate-limiter-webhook.test.js
```

**Structure Decision**: Keep changes in the existing service middleware, contract files, operator docs, and Jest suites.

## Design Notes

- Heavy routes: expanded-analysis-alert, market-scanner-alert, symbol-analysis, and news-monitor at 5 requests per minute by default.
- Trading routes: Binance order GET/POST/DELETE and order preview at 10 requests per minute by default.
- Standard route: volume-confirmation at 30 requests per minute by default.
- Light routes: `/api/status` and `/api/capabilities` at 100 requests per minute by default.
- All webhook/news ingest paths share the finite 1,000-request aggregate bucket. Mapped webhook routes also enforce their per-endpoint tier; alert/message retain only the aggregate cap because PR owner feedback called out the existing burst contract.
- Each dedicated bucket is keyed by normalized path plus the existing API-key hash/trusted-IP identity. No raw API key is retained in the map key.
- The 429 contract documents all runtime headers and the complete retryable error envelope; Postman examples are checked dynamically against every OpenAPI operation using the shared response.
- The four tier variables are request-rate security controls. They are listed in `.env.example` and operator documentation, and are intentionally excluded from Firebase Remote Config.
- Health/readiness, docs, admin static routes, and OpenAPI routes remain exempt because they are mounted before the app-wide limiter.
- The limiter remains process-local. A deployment with multiple web replicas has one independent budget per replica; shared coordination would require a separate design.

## Verification

- Focused Jest suites: rate limiter unit/integration, OpenAPI/Postman contracts, and environment documentation alignment.
- Full Jest suite: capture exact results and classify failures against `origin/master`; do not treat a failed suite as passed.
- Before merge: exact PR head CI, current OpenClaw served-SHA check, API E2E, applicable discussion replies/resolution, and WhatsApp delivery evidence.
