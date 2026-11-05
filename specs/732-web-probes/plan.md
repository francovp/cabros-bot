# Web probe implementation plan

Goal: implement the recorded issue #732 decision with existing readiness primitives.
Architecture: a small web-probe controller consumes bootstrapReadiness, processLifecycle and collectReadiness. app.js mounts new GET routes before API auth/rate limiting. Existing routes and platform configuration remain unchanged.
Spec: specs/732-web-probes/spec.md
Tech stack: Express, native Node.js, Jest/Supertest; Spec Kit templates available locally.

## Review focus

Dependency failures must not affect liveness; drain must win over cached healthy results and in-flight probes; preview bot disablement must stay optional; skipped dependencies must preserve the existing conservative verdict; no public provider error leakage.

## Implementation

- [x] Write integration tests for the spec and verify missing routes fail.
- [x] Add src/controllers/webProbes.js and mounts in app.js; keep legacy paths intact.
- [x] Synchronize OpenAPI, Postman (200/503 examples and assertions), README, API reference and AGENTS.md.
- [x] Run focused coverage, local startup/HTTP smoke, full pnpm test, diff checks and sequential independent reviews.
- [ ] Publish through create-pr; run exact-head CI/review/quiet-window gates, preview recovery, then merge and verify master when gates permit.
