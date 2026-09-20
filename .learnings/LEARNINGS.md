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

### Suggested Action
1. Add deduplication: before posting, fetch existing comments on the issue and skip if virgin-trainee-dev[bot] already posted a similar engagement comment.
2. Track engaged issues in a persistent state file (e.g., `.trainee-engaged.json`) with issue numbers and comment timestamps.
3. Only engage on issues/PRs created/updated since last successful run.
4. Consider using GitHub GraphQL to check for existing trainee comments more efficiently.

### Metadata
- Source: error
- Related Files: engage_latest.py, post_engagement.py, github_scan.py
- Tags: automation, deduplication, github-bot, cron
- See Also: LRN-20260920-001
- Pattern-Key: harden.engagement_deduplication
- Recurrence-Count: 1
- First-Seen: 2026-09-20
- Last-Seen: 2026-09-20

---
