# fix: make issue-automator skip loop continue past 2 issues until non-skip outcome

## Description

The issue-automator skill had a bug where it stopped after processing 2 issues if both ended in `IN_REVIEW` (no agent writes) or `LOCAL_DEADLOCK`. The expected behavior is to keep advancing through the backlog until finding an issue that requires actual agent work, or until no more open issues exist.

### Changes

- **Unified skip outcomes**: Both `LOCAL_DEADLOCK` and `IN_REVIEW` no-writes are now treated as **skip outcomes** — the agent produced no PR or changes, so the cursor advances to the next oldest issue.
- **Skip loop instead of one fallback**: Step 6 was restructured from a "process one fallback then stop" model into a loop: fetch next oldest, process, if skip again → continue; if non-skip → finalize; if no issues → stop.
- **Hard Rule #4**: Clarified that the "max 2" limit applies only to issues requiring agent writes. Zero-work skips don't consume this budget.
- **Hard Rule #3 and #5**: Updated to match the new skip loop terminology.
- **Hard Rule #7**: Updated to say "keep fetching until non-skip or none remain" instead of "continue to the next oldest issue" (which implied only one more).
- **Outcomes reference**: Updated fallback allowance, limits, and skip loop policy in `outcomes-and-deadlocks.md`.

### Files changed

- `.agents/skills/issue-automator/SKILL.md` — Hard Rules #3-#7, Step 6, Outcome Summary
- `.agents/skills/issue-automator/references/outcomes-and-deadlocks.md` — Outcome contract and Deadlock Policy section 2, 8
