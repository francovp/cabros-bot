---
name: cabros-skill-optimizer
description: Improve this repository's `.agents/skills` from recent Codex sessions, GitHub PRs and review discussions, and current CLI behavior. Use when asked to reduce agent friction, token use, authentication failures, duplicate work, unnecessary human review, or global blocking in Cabros Bot skills; also use before revising issue automation, GitHub/Linear/Render workflows, or skill-based operational gates.
---

# Cabros Skill Optimizer

Improve only skill assets unless the user explicitly requests a broader repository change. Preserve existing product safety requirements, release gates, API-key protections, and feature gates. Optimize the workflow, never weaken a proven control merely to save tokens or time.

## Workflow

1. Preserve unrelated work. Inspect `git status --short`; do not overwrite user changes.
2. Gather small, current evidence before reading whole skills:

   ```bash
   rtk proxy bash .agents/skills/cabros-skill-optimizer/scripts/collect-skill-evidence.sh --pr-limit 15
   ```

   The collector is read-only. It reports skill size, recent skill commits, closed-duplicate PR evidence, unresolved inline threads, and Codex review-quota comments without printing secrets or full PR bodies.
3. If memory is available, perform one targeted registry search for the affected skill plus `auth`, `review`, `duplicate`, or `Render`. Read at most two linked recent recaps. Treat their facts as historical leads; re-query GitHub, Linear, CI, Render, and production before encoding a live-state rule.
4. Read only the affected skill and the matching section of [improvement-catalog.md](references/improvement-catalog.md). Do not load every repository skill or PR transcript.
5. Make a change only when it has: (a) a concrete source artifact, (b) a repeatable symptom or wasted step, and (c) a safe, measurable replacement. Prefer a short script for fragile, repeated CLI sequences.
6. Update `agents/openai.yaml` if the skill name, trigger, or default prompt changed. Keep `SKILL.md` under 500 lines and move detailed rules to a one-level-deep reference.
7. Validate with the commands in **Verification** and report only the integrations actually checked.

## Decision Rules

### Reduce discussion and review churn

- Use GitHub GraphQL `reviewThreads` as the authority for inline unresolved discussions. General PR comments are context, not actionable threads by themselves.
- If a Codex comment begins `You have reached your Codex usage limits for code reviews`, run one focused self-review against the changed diff and acceptance criteria. Do not wait, retry quota checks, reset a quiet window, or request human review solely because of that comment.
- Check issue, PR, branch, and Linear linkage before implementation. Reuse a matching open PR; if the work is already merged, synchronize trackers and stop instead of producing a parallel PR.
- Require human review only for an unresolved concrete concern, missing authority, material risk that cannot be tested, or a repository rule that explicitly requires it. Keep normal CI, preview, and quiet-window gates intact.

### Reduce tokens and friction

- Fetch machine-readable fields with `gh --json` and extract only needed properties. Bound PR, issue, log, and session windows before querying.
- Prefer `rg -n -C 2` and targeted file ranges over broad dumps. Read a referenced file only when its rule applies.
- Use `rtk` for supported high-output commands. If `rtk` cannot invoke a binary, use `rtk proxy <command>` once; do not repeatedly retry the unsupported form.
- Use temp files plus `--body-file` and `--description-file` for GitHub or Linear Markdown. Quote `jq` filters with single quotes in zsh.

### Make authentication failures local

- Preflight only the integration required for the next action and record its result without exposing credentials. A missing GitHub, Linear, Render, Sentry, or protected-endpoint credential blocks that dependent action, not source analysis, tests, or skill maintenance.
- Preserve the Cabros GitHub account convention when repository writes are required: save the original account, switch to `francovp`, and restore it with `issue-automator/scripts/gh-auth-utils.sh`.
- Fail closed before protected requests when a key is absent. Pass sensitive headers through stdin (`curl -H @-`), never command arguments, logs, redirects, or `--location`.
- For Render configuration, update the named key only, then explicitly deploy. Treat a paginated env list as inspection only; do not replace the environment from it.

### Prevent global blocks

- Classify a failure as `INTEGRATION_BLOCKED` when one external system is unavailable and continue independent local or read-only work.
- Use `LOCAL_DEADLOCK` only after bounded retries show the same issue-specific blocker and no safe alternate verification exists.
- Use `GLOBAL_BLOCKED` only when every safe path to the requested outcome needs unavailable authority or infrastructure. State the exact missing capability and the smallest human action needed.
- A protected E2E or production check that cannot run is `SKIPPED`, never `PASSED`. Report the prerequisite and retain all completed evidence.

## Change Targets

Apply the smallest relevant improvement:

| Evidence | Skill improvement |
| --- | --- |
| Parallel or duplicate PR | Add early issue/PR/Linear dedupe and a merged-work exit. |
| CLI auth error | Add a capability preflight and a scoped fallback; never add secret logging. |
| Quoting/parsing error | Add a body-file pattern or a tested helper script. |
| Rate-limited Codex review | Add a bounded self-review fallback with explicit checks. |
| Render preview or deploy ambiguity | Add bounded healthcheck verification and distinguish preview success from production rollout. |
| Full-suite-only failure | Preserve the full failure and require isolated rerun before calling it a regression. |
| Repeated verbose investigation | Add bounded queries, structured summaries, or a script that emits only decision fields. |

Do not invent findings from stale sessions, inaccessible observability, a lint-only warning, or a broad diff. Report `No measurements found` when production evidence is unavailable.

## Verification

Run both after an update:

```bash
rtk proxy bash -n .agents/skills/cabros-skill-optimizer/scripts/collect-skill-evidence.sh
rtk proxy python3 /Users/fgvaleriop/.codex/skills/.system/skill-creator/scripts/quick_validate.py .agents/skills/cabros-skill-optimizer
```

If the validator fails only because `PyYAML` is unavailable, do not install global packages. Validate the frontmatter with the locally available Ruby YAML parser, report that the official validator was environment-blocked, and continue with the script checks. Run the collector with `--help`; run its live mode only when GitHub read access is available. For an edited existing script, run its narrow regression or safe dry-run as well.

## Final Report

Return: changed skill files, evidence used, friction removed, validation results, and remaining scoped blockers. Do not claim a live integration was verified when its auth or production access was unavailable.
