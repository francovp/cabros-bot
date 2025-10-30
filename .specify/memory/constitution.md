<!--
Sync Impact Report

- Version change: unspecified/template -> 1.0.0
- Modified principles: (added) Code Quality & Readability; Simplicity & Minimalism; Testing Policy (No TDD, Minimal Tests Required); Review & Quality Gates; Incremental Delivery & Versioning
- Added sections: Development Workflow & Quality Gates
- Removed sections: none (template placeholders replaced)
- Templates requiring updates:
	- .specify/templates/plan-template.md ✅ updated
	- .specify/templates/spec-template.md ⚠ pending (recommend minor text to reflect testing policy)
	- .specify/templates/tasks-template.md ✅ updated
- Follow-up TODOs: RATIFICATION_DATE intentionally left TODO for confirmation
-->

# Cabros Crypto Bot — Specification Constitution

## Core Principles

### I. Code Quality & Readability
All code MUST be written for humans first. Prioritize clear naming, small functions, and focused modules. Comments are permitted to explain "why" but MUST NOT duplicate obvious code behavior. Code that is hard to read is considered a bug and MUST be simplified before merging.

Rationale: Readable code reduces onboarding time, lowers bug density, and speeds future changes.

### II. Simplicity & Minimalism
Implement the simplest solution that correctly solves the stated requirement. Avoid premature abstraction and over‑engineering. Follow YAGNI (You Ain't Gonna Need It) when designing APIs and internal helpers.

Rationale: Simple implementations are easier to maintain, test, and reason about in small teams.

### III. Testing Policy (NO TDD Mandate)
Testing is REQUIRED for critical logic and public-facing behaviors, but Test-Driven Development (TDD) is NOT mandated. The project REQUIRES a minimal, focused test-suite that covers:

- core business logic (unit-level, where bugs would cause wrong results)
- regression tests for previously reported bugs when practical

Tests SHOULD be small in scope and fast. They MUST validate behavior and guard critical regressions. Writing tests early is encouraged, but teams are not required to follow a red‑green‑refactor TDD cycle.

Rationale: We want reliable safety nets without enforcing workflow dogma that slows delivery.

### IV. Review & Quality Gates
All changes MUST go through code review. Pull requests MUST include a brief description of the change, a summary of rationale for design decisions if non‑obvious, and the minimal tests added or updated. CI MUST run linters and basic tests before merge.

Rationale: Peer review and automated checks catch style and logic issues early.

### V. Incremental Delivery & Semantic Versioning
Work in small, incremental changes. Public API or behavior changes MUST follow semantic versioning for released packages or published contracts. Breaking or governance-level changes to the constitution require a documented migration plan.

Rationale: Small changes reduce blast radius and make rollbacks simpler.

## Development Workflow & Quality Gates

- PRs MUST reference the related spec/plan entry (e.g., specs/feature-name) and list test coverage for the change.
- CI MUST run formatting (prettier/eslint/clang-format as applicable), static analysis, and the minimal test-suite.
- Major architectural changes MUST be accompanied by a short design note (in the plan or PR) and a risk/rollback plan.
- Tests are REQUIRED for critical paths; other tests are encouraged but kept minimal.

## Governance

Amendments to this constitution MUST be proposed via a pull request against `.specify/memory/constitution.md`. Each amendment PR MUST include:

- a short rationale and scope of the change
- a suggested semantic version bump and reason (MAJOR/MINOR/PATCH)
- a short migration or compliance note if the amendment changes developer obligations

Approval: A simple majority of maintainers (or the repository owners listed in README) MUST approve the PR for the amendment to be adopted. Emergency fixes MAY use a faster triage path but must be documented and ratified retroactively.

Versioning rules (summary):

- MAJOR: Backward-incompatible governance or principle removals/redefinitions
- MINOR: New principle/section added or material expansion of guidance
- PATCH: Wording clarifications, typos, or non‑semantic refinements

**Version**: 1.0.0 | **Ratified**: TODO(RATIFICATION_DATE): confirm original adoption date | **Last Amended**: 2025-10-26
<!-- End of constitution -->
