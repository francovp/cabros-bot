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
