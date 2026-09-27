## [LRN-20260914-001] correction

**Logged**: 2026-09-14T10:55:00Z
**Priority**: low
**Status**: pending
**Area**: backend

### Summary
Avoid adding granular telemetry to worker status schemas if a centralized analytics system already exists.

### Details
In PR #992, suggested adding per-channel delivery rates to the `lastSweepResult` of the `NotificationRedriveService`. @francovp corrected this, stating that such data is already centralized in the alert delivery SLA and analytics subsystem (`/api/alerts/summary`). Adding it to the worker status would cause redundant schema bloat.

### Suggested Action
When proposing observability enhancements for background workers, first check if the required metrics are already captured by a broader analytics or SLA subsystem. Prioritize keeping worker status objects lean.

### Metadata
- Source: user_feedback
- Related Files: src/services/NotificationRedriveService.ts
- Tags: observability, schema-design, redrive-worker
- See Also: none
- Pattern-Key: harden.lean_status_schemas
- Recurrence-Count: 1
- First-Seen: 2026-09-14
- Last-Seen: 2026-09-14

---

## [LRN-20260917-001] correction

**Logged**: 2026-09-17T04:51:00Z
**Priority**: low
**Status**: pending
**Area**: backend

### Summary
SSE architecture uses in-process EventEmitter bridge (not Redis/NATS) with fallback polling for multi-worker sync.

### Details
In PR #1149 (feat(admin): add SSE real-time updates), @virgin-trainee-dev asked about worker-to-web event relay and bounded multi-connection pool. @francovp corrected the architectural understanding:
1. **Multi-process relay**: The web deployment is the single ingest/API coordinator where operators connect. Uses in-process EventEmitter bridge to avoid heavy infrastructure (Redis, NATS, Firestore listeners). Background workers update Firestore on completion; frontend fallback polling synchronizes across workers.
2. **Keepalive heartbeat**: The 30s `:keepalive` comment prevents edge proxy (Render, Cloudflare, Nginx) idle timeout termination (55-100s) and allows server to detect ghost sockets.

### Suggested Action
When reviewing SSE/real-time architectures, understand the coordinator pattern: single web ingress + in-process bridge + durable store + fallback polling. Don't assume message buses are required. Keepalive intervals should account for common proxy timeouts.

### Metadata
- Source: user_feedback
- Related Files: src/services/sse/AdminSseService.js, src/controllers/admin/sseEvents.js
- Tags: sse, realtime, architecture, eventemitter, fallback-polling
- See Also: LRN-20260914-001
- Pattern-Key: harden.sse_coordinator_pattern
- Recurrence-Count: 1
- First-Seen: 2026-09-17
- Last-Seen: 2026-09-17

---

## [LRN-20260920-001] correction

**Logged**: 2026-09-20T04:53:00Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
Trainee must proactively engage on assigned PRs/issues; silence is treated as non-contribution.

### Details
In PR #1098 (feat(webhooks): add standardized structured error envelope), @francovp's self-review summary explicitly noted: "@virgin-trainee-dev did not contribute on this issue." This was listed alongside @gigachad-senior-dev's scope concern as a factor in the automation evaluation (Score 25/100, automation/skip). The trainee later engaged with questions, but only after the evaluation was published.

### Suggested Action
When assigned or expected to engage on a PR/issue, post initial questions or observations early — before formal reviews land. Proactive engagement signals ownership and avoids "non-contribution" flags in automation scoring.

### Metadata
- Source: user_feedback
- Related Files: src/lib/errorEnvelope.js
- Tags: engagement, automation-scoring, contribution
- See Also: LRN-20260917-001
- Pattern-Key: harden.proactive_engagement
- Recurrence-Count: 1
- First-Seen: 2026-09-20
- Last-Seen: 2026-09-20

---

## [LRN-20260920-002] correction

**Logged**: 2026-09-20T18:20:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Engagement automation posts duplicate comments on every cron run.

### Details
The Virgin Trainee engagement script (engage_latest.py / post_engagement.py) runs on a cron schedule and posts the same comments repeatedly. On 2026-09-20, duplicate comments were posted on issues #1161, #1163, #1165, #1173-1184 (two identical comments per issue, ~13 hours apart). The @gigachad-senior-dev[bot] responded to both duplicates with identical "good instinct to ask" messages.

Root cause: The engagement script has no deduplication logic — it posts comments unconditionally on every run without checking if the trainee already commented on that issue.

**Recurrence 2026-09-22**: Manual engagement in cron run also posted duplicate comments on PRs #1191, #1192, #1193, #1194 despite existing virgin-trainee-dev[bot] comments from previous runs. The learning existed but was not applied during manual engagement.

### Suggested Action
1. Add deduplication: before posting, fetch existing comments on the issue and skip if virgin-trainee-dev[bot] already posted a similar engagement comment.
2. Track engaged issues in a persistent state file (e.g., `.trainee-engaged.json`) with issue numbers and comment timestamps.
3. Only engage on issues/PRs created/updated since last successful run.
4. Consider using GitHub GraphQL to check for existing trainee comments more efficiently.
5. **Manual engagement must also check for existing comments** — the deduplication logic applies to both automated and manual engagement.

### Metadata
- Source: error
- Related Files: engage_latest.py, post_engagement.py, github_scan.py
- Tags: automation, deduplication, github-bot, cron
- See Also: LRN-20260920-001
- Pattern-Key: harden.engagement_deduplication
- Recurrence-Count: 2
- First-Seen: 2026-09-20
- Last-Seen: 2026-09-22

---

## [LRN-20260921-001] correction

**Logged**: 2026-09-21T18:15:00Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
Trainee engaged on PR #1167 which was already a duplicate of PR #1176.

### Details
@francovp closed PR #1167 (fix(admin): preserve cached operation state after Playground filtering) as a duplicate of PR #1176, stating: "Closed as duplicate of PR #1176 which has the superior implementation (priority/critical, updates both src/admin/admin.js and public/admin/admin.js for Firebase Hosting parity, has Codex review, and preview deployment verified)." The trainee had posted 4 engagement comments on PR #1167 before it was closed.

### Suggested Action
Before engaging on a PR, check if it's already marked as duplicate or superseded by another PR. Use GitHub's "duplicate of" references or check for existing PRs addressing the same issue. Prioritize engaging on the canonical/primary PR.

### Metadata
- Source: user_feedback
- Related Files: engage_latest.py, post_engagement.py
- Tags: engagement, duplicate-detection, pr-review
- See Also: LRN-20260920-001, LRN-20260920-002
- Pattern-Key: harden.engagement_duplicate_check
- Recurrence-Count: 1
- First-Seen: 2026-09-21
- Last-Seen: 2026-09-21

---

## [LRN-20260927-001] correction

**Logged**: 2026-09-27T04:15:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Test suite execution silently reverts source-built divergence in `public/admin/admin.js` — test imports build script and mutates working tree.

### Details
@francovp corrected on issue #1201: The test `tests/unit/firebase-hosting-config.test.js` imports `scripts/build-hosting.js` and calls `buildHosting()`, which blindly copies `src/admin/*` → `public/admin/*`. Any `pnpm test` run executes this copy, silently overwriting fixes in `public/admin/admin.js` that don't exist in source. The revert manifests as `MM` status (staged ≠ unstaged). Two divergent copies exist: `public` has `handshakeTimeoutMs`/`handshakeTimer` SSE guard (7 occurrences), `src` lacks it entirely. Regenerating from source deletes the fix.

### Suggested Action
1. Make test **not** mutate working tree — assert against temp output dir or restore files after asserting.
2. Add post-copy verification in `build:hosting` to fail loudly when `src` and `public` diverge on content it didn't write.
3. Consider making `public/admin/*` generated-and-gitignored; serve artifact built in CI.
4. Same risk applies to `CabrosBot.postman_collection.json` and its test — stale branch produced result differing from both sides.
5. Codify the Clean Worktree Test Invariant in `AGENTS.md` and review rubrics so all tests are mandated to leave `git status --porcelain` completely clean.

### Metadata
- Source: user_feedback
- Related Files: tests/unit/firebase-hosting-config.test.js, scripts/build-hosting.js, public/admin/admin.js, src/admin/admin.js
- Tags: test-hygiene, build-reproducibility, silent-revert, firebase-hosting
- See Also: LRN-20260920-002
- Pattern-Key: harden.test_no_worktree_mutation
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-002] correction

**Logged**: 2026-09-27T01:00:00Z
**Priority**: high
**Status**: pending
**Area**: api

### Summary
Strict integer query parameter validation must enforce regex matching (`/^\d+$/`) before parsing to prevent `Number.parseInt` prefix truncation.

### Details
In PR #1188 (feat(outcomes): add confidence calibration feedback loop (GH-704)), query validation for `GET /api/outcomes/calibration` originally used `Number.parseInt(req.query.limit, 10)` directly. @chatgpt-codex-connector[bot] identified that `Number.parseInt` accepts leading digits from malformed strings like `'10junk'` or fractional representations like `'1.9'`, silently coercing them into valid integers (`10` and `1`). In financial and telemetry APIs, accepting malformed numeric inputs masks caller bugs and circumvents range validation.

Root cause: Relying on JavaScript's permissive `Number.parseInt` coercion instead of validating that the parameter string is composed strictly of digits before parsing into an integer.

### Suggested Action
1. Validate integer query and route parameters against `/^\d+$/` before calling `Number.parseInt` or `Math.trunc`.
2. Return a structured 400 `INVALID_REQUEST` error envelope if the parameter contains any non-digit characters (including decimal points, exponents, or alphanumeric tails).
3. Apply boundary checks (`min` and `max`) only after verifying the strict numeric format.

### Metadata
- Source: pr_review
- Related Files: src/controllers/outcomes/outcomes.js, src/lib/validation.js
- Tags: api-contract, input-validation, regex, parseInt, query-parameters
- See Also: none
- Pattern-Key: harden.strict_integer_validation
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-003] correction

**Logged**: 2026-09-27T01:05:00Z
**Priority**: high
**Status**: pending
**Area**: contracts

### Summary
Closed enum parameters in API payloads must reject explicit `null` with a 400 `INVALID_REQUEST`; only `undefined` may trigger fallback defaulting.

### Details
In PR #1193 (feat(webhooks): classify alerts with signalClass enum (GH-858)), incoming alert webhook payloads containing `"signalClass": null` were silently coalesced to the default fallback (`"unknown"`). @chatgpt-codex-connector[bot] corrected this behavior, noting that for closed enum specifications, explicitly passing `null` represents an invalid type assignment under OpenAPI/JSON Schema contracts, not an omission.

Root cause: Conflating `null` (explicit invalid type) with `undefined` (omitted property) during defensive parameter extraction and defaulting logic (`payload.signalClass || 'unknown'`).

### Suggested Action
1. Distinguish between omitted properties (`undefined`) and explicit null values (`null`) in request validation schemas.
2. For closed string enums, reject `null` values with HTTP 400 `INVALID_REQUEST` indicating that the value must be one of the permitted enum literals.
3. Allow default assignment only when the property key is entirely omitted from the input object.

### Metadata
- Source: pr_review
- Related Files: src/lib/validation.js, src/openapi/openapi.json
- Tags: api-contract, enums, schema-validation, null-safety, defensive-deserialization
- See Also: LRN-20260927-002
- Pattern-Key: harden.closed_enum_null_rejection
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-004] correction

**Logged**: 2026-09-27T01:10:00Z
**Priority**: medium
**Status**: pending
**Area**: docs

### Summary
Introducing or altering Remote-Config-eligible, non-secret configuration toggles requires atomic 4-way documentation parity across environment templates, schema definitions, operator guides, and agent guidelines.

### Details
Across PR #1189 (feat(cost): aggregate token spend tracking and budget alerting), PR #1190 (feat(ops): maintenance mode toggle for incident response), and PR #1193 (feat(webhooks): classify alerts with signalClass enum), newly introduced configuration toggles (`ENABLE_TOKEN_COST_BUDGET`, `ENABLE_SIGNAL_CLASS_MARKER`, maintenance toggles) were added to code and Firebase Remote Config templates, but omitted from `README.md` allow-lists or `AGENTS.md`. Additionally, in PR #1190, editing the configuration documentation inadvertently deleted existing documented settings (`ZERO_CHANNEL_ALERT_COOLDOWN_MS`).

Root cause: Fragmented configuration management workflows where code, schemas, and markdown documentation are maintained across disparate files without an atomic synchronization checklist.

### Suggested Action
1. Whenever a new Remote-Config-eligible, non-secret dynamic toggle or configuration key is added, update all 4 target files atomically in the same commit: `.env.example`, `RemoteConfigService.js` / Firebase template, `README.md`, and `AGENTS.md`. Secrets, authentication controls, delivery destinations, and startup-only gates must remain environment-only and never be added to Remote Config.
2. Verify that existing documentation tables and adjacent configuration keys are preserved without accidental line omissions during diff updates.
3. Include the new flags in status and capability response schemas (`/api/status`, `/api/capabilities`) and verify corresponding Postman test assertions.

### Metadata
- Source: senior_review
- Related Files: README.md, AGENTS.md, .env.example, src/services/remoteConfig/RemoteConfigService.js
- Tags: remote-config, documentation-parity, configuration-management, operational-safety
- See Also: none
- Pattern-Key: harden.remote_config_documentation_parity
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-005] correction

**Logged**: 2026-09-27T01:15:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Alert and signal replay handlers must start from the complete stored raw input payload and overlay replay/routing metadata, rather than cherry-picking fields from an explicit known-field list.

### Details
In PR #1193 (feat(webhooks): classify alerts with signalClass enum (GH-858)), the single alert replay endpoint (`/api/alerts/:id/replay`) and batch redrive routines re-dispatched stored alerts to notification channels (Telegram, WhatsApp, Discord) without copying `storedAlert.signalClass` into the delivery payload. This caused replayed messages to lose their visual signal class markers, resulting in visual degradation and inconsistency between live and replayed notifications.

Root cause: Replay handlers reconstructed delivery payloads by cherry-picking partial field subsets or explicitly whitelisting a subset of known fields instead of cloning the full raw input payload and overlaying routing metadata. Any newly introduced or unrecognized top-level attributes are silently dropped when reconstructing payloads from an explicit known-field list.

### Suggested Action
1. When implementing replay, redrive, or retry routines, start from the complete stored raw input payload (`{ ...storedAlert.payload }`) and overlay replay/routing metadata, rather than reconstructing payloads from a known-field list.
2. Ensure all top-level domain classification and metadata attributes (such as `signalClass`, `source`, `receivedAt`, `symbols`) and any unrecognized top-level properties are preserved verbatim.
3. Write integration tests for replay endpoints verifying that replayed payloads preserve all incoming fields and that outbound notifications are semantically identical to original dispatches.
4. Avoid field cherry-picking, whitelisting, or relying on optional nested fields for channel-critical formatting.

### Metadata
- Source: pr_review
- Related Files: src/services/notification/TelegramService.js, src/controllers/admin/alerts.js, src/services/NotificationManager.js
- Tags: replay, redrive, alert-ingestion, telegram, signal-classification, payload-preservation
- See Also: LRN-20260914-001
- Pattern-Key: harden.replay_payload_preservation
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-006] correction

**Logged**: 2026-09-27T01:20:00Z
**Priority**: medium
**Status**: pending
**Area**: contracts

### Summary
Postman collections must provide distinct executable request variants asserting structured 400 error envelopes for all documented failure boundaries.

### Details
In PR #1188 and PR #1194 (feat(postman): add invalid outcomes summary request variants (GH-716)), the Postman collection claimed validation coverage for `/api/outcomes/summary` but contained only a single negative request (`limit=200`). Review by @chatgpt-codex-connector[bot] and subsequent PR #1194 required creating 6 discrete, runnable test variants covering invalid status, invalid window, non-numeric timestamps, and reversed time ranges (`from > to`), each asserting a structured 400 `INVALID_REQUEST` response.

Root cause: Treating API collection documentation as illustrative rather than an executable, comprehensive negative contract test suite.

### Suggested Action
1. Include separate, runnable requests in `CabrosBot.postman_collection.json` for each invalid input variant (out-of-bounds numbers, invalid enum members, malformed timestamps, inverted ranges).
2. Attach Postman test scripts asserting HTTP 400 status codes and structured payload schemas containing machine-readable `code: 'INVALID_REQUEST'` alongside specific human-readable `error` messages.
3. Back collection contracts with automated regression suites in `tests/unit/postman-collection.test.js`.

### Metadata
- Source: pr_review
- Related Files: CabrosBot.postman_collection.json, tests/unit/postman-collection.test.js
- Tags: postman, negative-testing, contract-testing, error-envelopes, api-validation
- See Also: LRN-20260927-002, LRN-20260927-003
- Pattern-Key: harden.postman_negative_variant_coverage
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-007] correction

**Logged**: 2026-09-27T01:25:00Z
**Priority**: critical
**Status**: pending
**Area**: backend

### Summary
Authentication middleware must precede maintenance mode and dynamic feature gates to prevent unauthenticated information disclosure and probing.

### Details
In PR #1190 (feat(ops): maintenance mode toggle for incident response), the maintenance mode middleware was initially placed before `validateApiKey` in Express route handlers. Unauthenticated external clients sending requests to maintenance-gated endpoints received a 503 `MAINTENANCE_MODE` status instead of 401 `UNAUTHORIZED`. @chatgpt-codex-connector[bot] flagged this as a P1 security vulnerability: unauthenticated attackers could probe whether the service was in maintenance without valid credentials.

Root cause: Applying operational availability gates globally before verifying client authenticity in the Express middleware chain.

### Suggested Action
1. Keep rate limiting as an outer defense ahead of authentication to protect against unauthenticated volumetric floods or credential brute-forcing, while ensuring `validateApiKey` (and any required bearer authentication) executes before maintenance mode or dynamic feature flag gates.
2. For bot command integrations (e.g. Telegram), filter updates so maintenance mode applies only to user commands (`isTelegramCommand`) and evaluate per-chat maintenance reply cooldowns without consuming expensive user rate quotas.
3. Ensure all gated operations return structured 503 envelopes (`{ error: 'MAINTENANCE_MODE', message: '...' }`) only to authenticated callers.

### Metadata
- Source: pr_review
- Related Files: src/routes/index.js, src/lib/maintenanceMode.js, index.js
- Tags: security, middleware-order, authentication, maintenance-mode, api-gateway
- See Also: none
- Pattern-Key: harden.auth_precedes_maintenance_gate
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-008] correction

**Logged**: 2026-09-27T01:30:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Multi-agent engagement bots must inspect recent discussion history and verify conversation context before commenting to prevent duplicate questions and boilerplate timeline noise.

### Details
In PRs #1187 and #1188, multi-agent bots displayed significant conversational degradation: @virgin-trainee-dev[bot] posted questions at 18:27Z that repository maintainer @francovp had already fully answered and addressed at 07:07Z. Simultaneously, @gigachad-senior-dev[bot] posted boilerplate keyword-categorized non-answers ("good instinct to ask..."). In multi-agent teams, bots must actively inspect PR conversation history, verify whether a question has already been answered by maintainers, and default to silence (`HEARTBEAT_OK`) rather than polluting review threads with formulaic templates.

Root cause: Engagement scripts triggered on schedule without fetching and semantically checking conversation threads or verifying whether discussion questions were already resolved.

### Suggested Action
1. Before posting PR comments or questions, fetch full thread history and verify that the intended question or topic has not already been answered or addressed by repository maintainers.
2. Suppress generic keyword-triggered responses; require actual technical context or remain silent (`HEARTBEAT_OK`).
3. Adhere to the established deduplication lifecycle (updating existing learnings in place via recurrence annotations rather than generating duplicate entries).
4. Perform automated pre-flight checks: inspect `issues/{id}/comments` and `reviewThreads` for prior bot engagement, and check for duplicate/superseded PR links to avoid commenting on redundant work.

### Metadata
- Source: pr_review
- Related Files: engage_latest.py, post_engagement.py, .learnings/LEARNINGS.md
- Tags: multi-agent, bot-engagement, conversation-context, thread-inspection, anti-noise
- See Also: LRN-20260920-001, LRN-20260920-002, LRN-20260921-001
- Pattern-Key: harden.bot_engagement_quality
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27


---
