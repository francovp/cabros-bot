---
name: contract-alignment-review
description: Use when changing or reviewing an HTTP endpoint, request variant, response shape, environment variable, feature flag, Firebase/Render configuration, OpenAPI schema, Postman collection, README, spec, or agent skill.
---

# Contract Alignment Review

Treat runtime behavior as a contract with multiple checked-in consumers. Update only the surfaces the change actually affects, then verify they agree.

## Checklist

1. **Trace the runtime first.** Identify route/auth/feature gates, defaults, error codes, response fields, and external configuration reads before editing documentation.
2. **Synchronize API surfaces.** For every endpoint change, update `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, README/spec guidance, and focused contract tests. Include valid variants, negative input variants (e.g. 400 validation with `INVALID_REQUEST` for invalid limits, windows, malformed timestamps, or reversed ranges), auth failures (401/403), conflict states (409), and standardized error envelopes (`{ success: false, error: ..., code: ... }` via `src/lib/errorEnvelope.js`).
3. **Synchronize configuration and documentation.** Add application-owned env reads to `.env.example` with defaults and valid-value guidance. Maintain 100% parity across `firebase-remote-config-template.json`, `RemoteConfigService.PARAMETER_SCHEMA`, and `README.md` parameter tables (exact keys, descriptions, types, and fallback defaults). Keep secrets, auth controls, destinations, endpoints, and startup-only gates out of public Remote Config unless explicitly designed otherwise.
4. **Synchronize deployment wiring.** A template or documented command is not operational until its checked-in Firebase/Render/Vercel/Railway configuration can actually select and publish it. Verify target names, worker-specific env, and post-merge readiness separately.
5. **Keep names exact.** Match runtime casing, collection names, field names, headers, paths, URL anchors, and provider defaults. Do not rely on a permissive schema or substring check to stand in for runtime validation.
6. **Make tests detect drift.** Assertions must cover the real spelling/pattern and read the current file names. Avoid tests that pass because a stale phrase, alternate casing, or incomplete regex misses the drift.
7. **Preserve replay payloads.** Ensure replay endpoints (e.g. single and batch alert replay) and queue re-drive handlers start from the complete stored raw input payload and overlay routing metadata, preserving all top-level attributes without field cherry-picking, truncation, or destructive filtering of unrecognized downstream fields.

## Required verification

- Parse changed JSON/YAML and run focused contract/documentation tests.
- Run `git diff --check`.
- Check `README.md` parameter tables match `firebase-remote-config-template.json` and `RemoteConfigService.PARAMETER_SCHEMA`.
- Verify `CabrosBot.postman_collection.json` includes runnable valid and negative/error response examples (e.g. 400 `INVALID_REQUEST`) with executable test assertions (`pm.test`) and standardized error envelopes.
- Exercise every new request variant in Postman examples or an equivalent test.
- If deployment config changed, validate the actual target/command and mark external rollout checks as unverified when unavailable; never claim pre-merge config equals production state.

## Evidence from recent reviews

Recent reviews (PRs #1188, #1189, #1190, #1193, #1194, as well as earlier PRs #392, #390, #347, #315, #306, #285, #273, #272, #260, #251, and #231) repeatedly identified gaps in Postman negative variant coverage (invalid limits, windows, reversed ranges), Remote Config README parity, standardized error envelopes, unwired Firebase templates, worker env parity, and replay payload preservation.
