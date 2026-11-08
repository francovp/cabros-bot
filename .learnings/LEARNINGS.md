## [LRN-20261106-155000-001] correction

**Logged**: 2026-11-06T15:50:00Z
**Priority**: medium
**Status**: pending
**Area**: security

### Summary
Security-scanner alerts on authentication/secret surfaces (e.g., CodeQL "Sensitive data read from GET request") require explicit human sign-off and record of dismissal, regardless of whether the agent can infer a valid justification (like an existing sunset mechanism).

### Details
On PR #1088, @francovp explicitly stated that he would not resolve a CodeQL alert via agent inference. Even though the "GET request" path was a pre-existing, intentional, and instrumented compatibility affordance on a deprecation path, the decision to dismiss the alert is a "human call" that must be made and recorded by a maintainer.

### Suggested Action
When encountering security scanner alerts on sensitive paths, do not attempt to "solve" them via inference or documentation references alone. Present the evidence to a human maintainer and request an explicit dismissal decision.

### Metadata
- Source: user_feedback
- Related Files: src/lib/auth.js, src/routes/index.js
- Tags: security, CodeQL, auth, process, human-in-the-loop
- See Also: LRN-20261101-122434-0001
- Pattern-Key: harden.security_dismissal

---

## [LRN-20261106-155000-002] correction

**Logged**: 2026-11-06T15:50:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
News narrative clustering must occur *before* the dispatch phase of the alert pipeline. Clustering after the analyzer has already sent symbol-specific alerts only adds metadata and fails to consolidate the actual delivery to the user.

### Details
On PR #1076, @francovp pointed out that the current implementation clusters alerts *after* NewsAnalyzer has already dispatched them. This means a user still receives multiple individual alerts, even if they are logically part of the same "story". The clustering logic must be moved upstream to consolidate the delivery into a single message.

### Suggested Action
Re-architect the news-monitor pipeline to:
1. Perform analysis for all symbols.
2. Apply clustering logic to group related alerts.
3. Dispatch a single consolidated "story" alert (or multiple if the cluster is too large).

### Metadata
- Source: user_feedback
- Related Files: src/services/trading/NewsAnalyzer.js, PR #1076
- Tags: backend, news-monitor, clustering, delivery-consolidation
- See Also: Issue #847
- Pattern-Key: simplify.alert_pipeline

---

## [LRN-20261106-155000-003] correction

**Logged**: 2026-11-06T15:50:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Since May 2026, Google AI Studio API keys have changed their default behavior: new keys default to "authorization keys," and standard keys must be explicitly restricted. Using an older, unrestricted standard key in production may result in `API_KEY_INVALID`.

### Details
On issue #1457, @francovp provided a critical update regarding Gemini API keys. The transition to restricted keys means that production environments using legacy unrestricted keys might face failures. This is a credential-type mismatch rather than a simple invalid key.

### Suggested Action
1. Audit production Gemini API keys in AI Studio/Cloud Console.
2. Ensure keys are correctly restricted or updated to the new authorization key standard.
3. Update `.env.example` and setup documentation to reflect the requirement for restricted keys to prevent future rotation failures.

### Metadata
- Source: user_feedback
- Related Files: .env.example, docs/setup.md
- Tags: infra, gemini, api-keys, google-ai-studio, config
- See Also: https://ai.google.dev/gemini-api/docs/generate-content/api-key
- Pattern-Key: harden.credential_rotation

---

## [LRN-20261107-034500-001] correction

**Logged**: 2026-11-07T03:45:00Z
**Priority**: medium
**Status**: pending
**Area**: testing

### Summary
Numerical threshold boundaries (e.g., exactly 1.0 vs 0.9999) must be explicitly tested to ensure correct branch execution.

### Details
On PR #1479, it was noted that while the threshold `>= 1` was implemented, the boundary case of `0.9999` (which should pass through raw) was not covered by tests. This represents a legitimate gap in the regression matrix.

### Suggested Action
When implementing numerical thresholds, always include tests for both the inclusive boundary and the value immediately below it.

### Metadata
- Source: user_feedback
- Related Files: src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js, PR #1479
- Tags: testing, boundaries, regression, precision
- Pattern-Key: verify.boundary_cases

---

## [LRN-20261107-034500-002] correction

**Logged**: 2026-11-07T03:45:00Z
**Priority**: medium
**Status**: pending
**Area**: config

### Summary
Use fixed code constants instead of environment variables for UX/display settings.

### Details
On PR #1479, @gigachad-senior-dev corrected the preference for using environment variables for display-related constants (e.g., `SUB_DOLLAR_MAX_DECIMALS`). Such settings are UX concerns, not operational knobs, and should be hard-coded as module-level constants to avoid configuration drift across replicas and reduce deployment complexity.

### Suggested Action
Distinguish between operational knobs (which belong in `.env`/Remote Config) and UX/display constants (which belong as module-level constants).

### Metadata
- Source: user_feedback
- Related Files: src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js, PR #1479
- Tags: config, UX, constants, env-vars, drift
- Pattern-Key: simplify.config_scope
## [LRN-20261108-055447-886] correction

**Logged**: 2026-11-06T13:34:52Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1488

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> ## 🤖 Senior Dev / TL Evaluation (Automated)

**PR:** #1488 - feat(alerts): coalesce exact webhook duplicates

### Assessment
- **Priority:** priority/medium
- **Type:** type/feature
- **Areas:** area/api, area/webhooks
- **Size:** size/m
- **Status:** status/triage
- **Automation Readiness:** automation/skip (Score: 35/100)

### Labels Applied
- `type/feature`
- `priority/medium`
- `size/m`
- `status/triage`
- `automation/skip`
- `area/api`
- `area/webhooks`

### Automation Readiness Details
- N...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1488
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

## [LRN-20261108-055447-887] correction

**Logged**: 2026-11-06T04:08:41Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1486

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> ## 🤖 Senior Dev / TL Evaluation (Automated)

**Issue:** #1486 - Unaddressed suggestion: Hello! I'm the Virgin Trainee bot. I've noticed this updated PR and I'm here to help. P...

### Assessment
- **Priority:** priority/medium
- **Type:** type/feature
- **Areas:** area/api
- **Size:** size/l
- **Status:** status/triage
- **Automation Readiness:** automation/skip (Score: 25/100)

### Labels Applied
- `type/feature`
- `priority/medium`
- `size/l`
- `status/triage`
- `automation/skip`
- `area/api`
...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1486
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

## [LRN-20261108-055447-887] correction

**Logged**: 2026-11-06T04:08:23Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1485

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> ## 🤖 Senior Dev / TL Evaluation (Automated)

**Issue:** #1485 - Unaddressed suggestion: Hi @francovp and @gigachad-senior-dev! 🤖 This PR looks super cool — an Alerts view comp...

### Assessment
- **Priority:** priority/medium
- **Type:** type/feature
- **Areas:** area/observability, area/trading, area/api
- **Size:** size/l
- **Status:** status/triage
- **Automation Readiness:** automation/skip (Score: 15/100)

### Labels Applied
- `type/feature`
- `priority/medium`
- `size/l`
- `status/triage`...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1485
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

## [LRN-20261108-055447-887] correction

**Logged**: 2026-11-06T04:08:05Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1484

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> ## 🤖 Senior Dev / TL Evaluation (Automated)

**Issue:** #1484 - Unaddressed suggestion: SHIPPED: PR #1480 was squash-merged as 1c3cccc43d10fbb4e1a9c742c2bd64822fa87087; issue...

### Assessment
- **Priority:** priority/medium
- **Type:** type/feature
- **Areas:** area/api, area/trading
- **Size:** size/l
- **Status:** status/triage
- **Automation Readiness:** automation/skip (Score: 15/100)

### Labels Applied
- `type/feature`
- `priority/medium`
- `size/l`
- `status/triage`
- `automation/skip`
...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1484
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

## [LRN-20261108-055447-888] correction

**Logged**: 2026-11-06T23:48:58Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1479

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> ## 🤖 Senior Dev / TL Evaluation (Automated)

**PR:** #1479 - fix(precio): preserve 2-decimal precision for crypto prices >= 1 (#1200)

### Assessment
- **Priority:** priority/medium
- **Type:** type/bug
- **Areas:** area/telegram
- **Size:** size/xs
- **Status:** status/ready
- **Automation Readiness:** automation/ready (Score: 75/100)

### Labels Applied
- `type/bug`
- `priority/medium`
- `size/xs`
- `status/ready`
- `automation/ready`
- `area/telegram`

### Automation Readiness Details
- No sp...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1479
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

## [LRN-20261108-055447-889] correction

**Logged**: 2026-11-07T22:33:08Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1458

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> ## 🤖 Senior Dev / TL Evaluation (Automated)

**Issue:** #1458 - Bug: uptime watchdog accepts in-progress monitor runs

### Assessment
- **Priority:** priority/high
- **Type:** type/bug
- **Areas:** area/observability
- **Size:** size/s
- **Status:** status/triage
- **Automation Readiness:** automation/skip (Score: 55/100)

### Labels Applied
- `type/bug`
- `priority/high`
- `size/s`
- `status/triage`
- `automation/skip`
- `area/observability`

### Automation Readiness Details
- Bug report missin...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1458
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

## [LRN-20261108-055447-889] correction

**Logged**: 2026-11-07T14:15:19Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1458

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> <!-- hermes-response-to:6405090622 -->
**Context:** Issue #1458 — Bug: uptime watchdog accepts in-progress monitor runs

(1) You've correctly identified the root cause. The workflow at `.github/workflows/external-uptime-watchdog.yml` queries `gh api "repos/${{ github.repository }}/actions/workflows/external-uptime-monitor.yml/runs?per_page=1"` without a `status` filter, so the API returns the most recent run regardless of whether it's `completed`, `in_progress`, or `queued`. The subsequent check...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1458
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

## [LRN-20261108-055447-890] correction

**Logged**: 2026-11-07T08:06:39Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @gigachad-senior-dev[bot] on francovp/cabros-bot#1457

### Details
@gigachad-senior-dev[bot] provided feedback that may indicate a correction or negative response to the trainee's engagement:

> ## 🤖 Senior Dev / TL Evaluation (Automated)

**Issue:** #1457 - Investigate production /healthcheck returning 503

### Assessment
- **Priority:** priority/medium
- **Type:** type/enhancement
- **Areas:** area/api
- **Size:** size/s
- **Status:** status/triage
- **Automation Readiness:** automation/skip (Score: 30/100)

### Labels Applied
- `type/enhancement`
- `priority/medium`
- `size/s`
- `status/triage`
- `automation/skip`
- `area/api`

### Automation Readiness Details
- Feature/enhancement m...

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: francovp/cabros-bot#1457
- Tags: correction, feedback, trainee, engagement, gigachad-senior-dev[bot]
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: 2026-11-08
- Last-Seen: 2026-11-08

