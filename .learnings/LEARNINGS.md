# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260901-001] correction

**Logged**: 2026-09-01T00:25:00Z
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Avoid suggesting model training or RLHF

### Details
The trainee previously suggested implementing LLM-based prompt optimizers or asked about model training/RLHF. Franco explicitly stated this doesn't make sense as there are no plans to train models in the medium term.

### Suggested Action
Shift focus from AI model training/fine-tuning to architecture, orchestration, and integration. Do not ask or suggest RLHF/training-related improvements.

### Metadata
- Source: user_feedback
- Related Files: AGENTS.md
- Tags: scope, focus, trainee
- Pattern-Key: focus.no_training

---

## [LRN-20260901-002] correction

**Logged**: 2026-09-01T00:25:00Z
**Priority**: critical
**Status**: pending
**Area**: infra

### Summary
Maintain distinct identity using App credentials

### Details
The trainee was using `gh` CLI or environment tokens, which caused GitHub comments to appear as @francovp. This is an identity leak/impersonation issue.

### Suggested Action
Always use the designated Python script with GitHub App credentials to ensure comments are posted by the "Virgin Trainee" identity and not the user's account. Never use `gh` CLI for posting comments in this context.

### Metadata
- Source: error
- Related Files: AGENTS.md
- Tags: identity, auth, github, security
- Pattern-Key: harden.identity_separation

---

## [LRN-20260901-003] best_practice

**Logged**: 2026-09-01T00:25:00Z
**Priority**: medium
**Status**: pending
**Area**: docs

### Summary
Active interaction with Senior Dev

### Details
The trainee should not just be passive. It must actively respond to direct questions or mentions from @gigachad-senior-dev in PRs and Issues.

### Suggested Action
In every scan cycle, explicitly check for mentions or direct questions from @gigachad-senior-dev and provide a technical, inquisitive, or helpful response.

### Metadata
- Source: user_feedback
- Related Files: AGENTS.md
- Tags: interaction, trainee, senior-dev
- Pattern-Key: interact.senior_dev

---

## [LRN-20260901-004] best_practice

**Logged**: 2026-09-01T00:30:00Z
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Apply YAGNI and focus on immediate value delivery

### Details
The trainee suggested a full architectural refactor (Unified Command Dispatcher) for a small feature (4 WhatsApp commands). @gigachad-senior-dev corrected this, emphasizing that premature abstraction leads to leaky abstractions and delays value.

### Suggested Action
Avoid suggesting large-scale refactors for small features. Prioritize delivering the requested functionality first. Only propose architectural changes when there is a clear pattern (e.g., 3+ channels) or significant duplication.

### Metadata
- Source: user_feedback
- Related Files: AGENTS.md
- Tags: pragmatism, yagni, architecture
- Pattern-Key: focus.value_first

---

## [LRN-20260901-005] best_practice

**Logged**: 2026-09-01T00:30:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Separate Business Logic from Channel Presentation

### Details
Clarified the boundary between Business Logic and Channel Adapters. Business Logic should produce stable, channel-neutral structured results. The Channel Adapter is responsible for rendering that data into the platform-specific format (Markdown, escaping, etc.).

### Suggested Action
When designing cross-channel features, ensure the business layer does not contain platform-specific formatting. Move all presentation logic (e.g., WhatsApp vs Telegram styling) into the Adapter layer.

### Metadata
- Source: user_feedback
- Related Files: AGENTS.md
- Tags: architecture, soc, presentation
- Pattern-Key: arch.adapter_pattern

---

## [LRN-20260905-001] correction

**Logged**: 2026-09-05T02:06:31.059072Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Don't reinvent wheels - start with native solutions

### Details
On PR #1075 (feat(canary): add synthetic canary endpoint), @gigachad-senior-dev[bot] responded to @virgin-trainee-dev[bot]'s question about the chosen approach vs existing/built-in solutions. The feedback: "You're questioning the chosen approach vs. an existing/built-in solution. This is exactly the right mindset — don't reinvent wheels. However, the trade-off usually comes down to granularity, cost, and operational fit. Start with native if it solves 80%+ of the need."

### Suggested Action
When evaluating architectural decisions, first check if native/platform-provided solutions cover 80%+ of requirements before building custom implementations. Question custom approaches but understand the trade-offs (granularity, cost, operational fit).

### Metadata
- Source: user_feedback
- Related Files: PR #1075
- Tags: architecture, pragmatism, native-first
- Pattern-Key: arch.native_first

---

## [LRN-20260905-002] insight

**Logged**: 2026-09-05T02:06:51.594920Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
Senior Dev evaluations provide structured triage labels

### Details
Multiple PRs (#1093, #1094, #1095) received automated evaluations from gigachad-senior-dev[bot] with structured labels: priority, type, areas, size, status, and automation readiness score. This is valuable context for understanding how changes are assessed.

### Suggested Action
When engaging on PRs, reference the senior dev's evaluation labels to show awareness of the triage context. Use the automation readiness score to gauge if a PR is suitable for automated review vs human review.

### Metadata
- Source: observation
- Related Files: PR #1093, #1094, #1095
- Tags: triage, evaluation, senior-dev
- Pattern-Key: process.triage_labels

---
