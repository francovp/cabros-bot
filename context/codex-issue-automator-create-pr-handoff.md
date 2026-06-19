# docs(issue-automator): enforce create-pr handoff

## Summary

Tighten the `issue-automator` skill so PR creation always flows through the `create-pr` skill and Linear tickets are written with a structured, self-contained description.

## Key Changes

### :link: Force PR creation through `create-pr`

- Require every PR to be created or updated through the `create-pr` skill
- Ban direct `gh pr create` and `gh pr edit` usage from `issue-automator`
- Make the branch context file the source of truth for the PR body

### :memo: Standardize Linear issue formatting

- Add a required Linear issue body structure with `Summary`, `Context`, `Acceptance Criteria`, and `References`
- Keep Linear tickets readable without jumping back to GitHub for basic context
- Preserve the GitHub issue number as the dedupe key

## Technical Implementation

### Skill workflow changes

#### `.agents/skills/issue-automator/SKILL.md`

- Added a hard rule to route all PR creation through the `create-pr` skill
- Expanded the Linear tracker step with a predictable description format
- Updated the action plan to require `context/<git-branch-name>.md` as the PR summary input before handing off to `create-pr`

## Testing

### Verification

- `git diff --check`
- Manual review of the updated workflow text for PR and Linear handoff

## References

- `create-pr` skill
- `issue-automator` skill
