# feat: enforce `agent-working` lifecycle and Linear ID in PR titles

## Summary

Enforce strict `agent-working` label lifecycle (add at start, remove on merge/review handoff) and ensure the Linear issue ID is always present in PR titles and issue/PR descriptions.

## Key Changes

- **`agent-working` lifecycle**: Label is now added immediately when an agent starts working on an issue (Step 1 pre-flight) and on PR creation (Step 4). It is removed when the PR is merged (Step 5) or handed off for human review (Step 7). The skip loop (Step 6) also cleans up stale `agent-working` labels on merged PRs.
- **Linear ID in PR title**: Every PR title must end with the Linear issue ID in parentheses, e.g. `feat: my awesome feature (CB-42)`. The context file enforces this format, and verification steps in Steps 4, 5, and 7 check and fix it if missing.
- **Linear ID in descriptions**: Both GitHub issue descriptions and PR body include a `**Linear**: [CB-XX](url)` reference in their References section.
- **Hard Rules**: Rule 9 now defines the full `agent-working` lifecycle contract. New Rule 18 mandates Linear ID in PR titles and descriptions.
- **Outcome Summary**: Now reports the Linear issue ID and confirms `agent-working` lifecycle compliance per issue.

## Testing

No code changes — only skill documentation updates. Verified by reading the full SKILL.md for consistency and format correctness.

## References

- Linear: [CB-XX] (to be filled after Linear issue creation)
