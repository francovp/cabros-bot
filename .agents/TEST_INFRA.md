# Agent Skills Test Infrastructure

This directory documents the zero-dependency test suite and validation gates for Cabros Bot agent skills in `.agents/skills/`.

## Overview

All skills maintained in `.agents/skills/` are executed and consumed by automated AI coding agents and human operators. To prevent workflow failure, script syntax errors, or prompt bloat from breaking agent runs, skills are validated through a 4-tier automated test harness.

The runner script is located at:
`file://.agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh`

## Validation Tiers

### Tier 1: Frontmatter & Metadata Integrity
- Ensures every skill directory contains a `SKILL.md` file.
- Verifies `SKILL.md` starts with valid YAML frontmatter delimiters (`---`).
- Enforces mandatory fields:
  - `name`: Must match the parent skill directory basename exactly.
  - `description`: Must be a non-empty, actionable summary of when the skill triggers.

### Tier 2: Size & Bloat Limits
- Enforces the repository rule that `SKILL.md` files must remain strictly under 500 lines (`<= 500`).
- Detailed tables, extensive catalogs, and verbose scripts must be split into references or separate scripts to preserve agent context windows.

### Tier 3: Script Permissions & Syntax Integrity
- Scans for all `.sh` shell scripts located within `.agents/skills/`.
- Verifies bash syntax validity via `bash -n "$script"`.
- Enforces executable permissions (`[ -x "$script" ]` / `chmod +x`).

### Tier 4: Secret & Credential Safety
- Scans all files in each skill directory for unredacted secrets or live tokens:
  - GitHub PATs (`ghp_*`, `github_pat_*`)
  - Google API keys (`AIzaSy*`)
  - OpenAI API keys (`sk-*`)
  - Raw JWT tokens (`eyJ*.*`)
- Prevents accidental exposure of live credentials in prompt documentation or automation scripts.

## Running Locally

Run all tiers across all skills:
```bash
bash .agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh --all
```

Run a specific validation tier:
```bash
bash .agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh --tier 1
bash .agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh --tier 2
bash .agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh --tier 3
bash .agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh --tier 4
```

Validate a single skill:
```bash
bash .agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh --skill cabros-skill-optimizer
```

Override skills directory (useful in tests and isolated fixtures):
```bash
bash .agents/skills/cabros-skill-optimizer/scripts/test-skills-e2e.sh --skills-dir /path/to/custom-skills --all
```

Run Jest test suite:
```bash
pnpm test -- tests/unit/skills-validation.test.js
```

## CI Integration

The test runner has **zero external dependencies** (no npm packages, no Python/PyYAML requirements) and runs in **< 1 second**.

It is integrated into GitHub Actions CI in two places:
1. `.github/workflows/skills-ci.yml`: A dedicated, fast workflow triggered on pushes and pull requests touching `.agents/skills/**`.
2. `.github/workflows/node.js.yml`: A fast pre-build validation step ensuring all skills are valid prior to long-running test suites.
