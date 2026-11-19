# Implementation Plan: Statistically-Guarded Outcomes Leaderboard

**Branch**: `feat/outcomes-leaderboard-gh-826` | **Date**: 2026-11-18 | **Spec**: [spec.md](file:///tmp/cabros-826-leaderboard/specs/826-outcomes-leaderboard/spec.md)

## Summary

Deliver a shared, statistically-guarded outcomes leaderboard (`GET /api/outcomes/leaderboard`, Telegram `/top`, and `featureFlags.outcomesLeaderboard` in `/api/status`) over the existing bounded `tradingSignalOutcomes` read path (`fetchOutcomeDocs`, max 31 days / 1000 docs). Put leaderboard aggregation, Wilson 95% hit-rate CI, normal-approximation 95% expectancy-R CI, reliability gating, coverage reporting, and 60s filter-scoped memoization in a dedicated modular service helper (`src/services/storage/outcomesLeaderboard.js`) wired cleanly through `SignalOutcomeService.js`.

## Technical Context

**Language/Version**: Node.js >=24.18.0 (`24.18.0`), CommonJS JavaScript (`'use strict'`)  
**Primary Dependencies**: Express 4, Telegraf 4, Firebase Admin Firestore (existing — zero new dependencies)  
**Storage**: Read-only queries over existing `tradingSignalOutcomes` Firestore collection (`max 1000 docs`, `max 31 days`)  
**Testing**: Jest 30 + Supertest + `node-mocks-http` (`pnpm test`)  
**Constraints**: No new Firestore collections, no new workers, no new required env vars, backwards-compatible `/api/outcomes` and `/api/outcomes/summary` contracts, MarkdownV2 escaping on `/top`, OpenAPI & Postman contract parity (`X-Request-Id` tests).

## Project Structure

```text
src/
├── services/
│   ├── storage/
│   │   ├── SignalOutcomeService.js      # Exports getOutcomesLeaderboard/isLeaderboardEnabled; invalidates cache on writes; persists promptProvenance
│   │   └── outcomesLeaderboard.js       # Pure statistical math (Wilson CI, normal R CI), grouping, ranking, coverage/warnings, 60s TTL cache
│   └── remoteConfig/
│       └── RemoteConfigService.js       # Optional non-secret runtime toggle ENABLE_OUTCOMES_LEADERBOARD (default: true)
├── controllers/
│   ├── outcomes/outcomes.js             # Query parsers + getOutcomesLeaderboard HTTP handler
│   ├── status.js                        # featureFlags.outcomesLeaderboard
│   └── commands.js                      # topCommand, formatTopLeaderboardMessage, help text & rate limit
├── lib/
│   └── telegramCommandMenu.js           # Register /top in canonical Telegram command menu
├── routes/
│   └── index.js                         # Mount GET /api/outcomes/leaderboard before /api/outcomes/:outcomeId
└── openapi/
    └── openapi.json                     # Contract for GET /api/outcomes/leaderboard + StatusFeatureFlags.outcomesLeaderboard
```

## Verification Strategy

1. **Unit tests**: Worked-dataset statistical tests pinning Wilson 95% CI, normal-approximation 95% R CI, consistency ranking, `unreliableCohorts`, `promptSource: null` fallback, 60s cache hit/isolation/invalidation, coverage warnings, controller param bounds/errors, and `/top` MarkdownV2 formatting + timeout + disabled state.
2. **Integration & Contract tests**: Supertest tests on `/api/outcomes/leaderboard` (`403`, `400`, `200`, `503`), `/api/status` & `/api/capabilities` (`featureFlags.outcomesLeaderboard`), OpenAPI schema & `SwaggerParser.validate`, Postman collection `X-Request-Id` checks, docs alignment, Remote Config parity, and `pnpm run check:admin-drift` + `pnpm run audit:gate`.
