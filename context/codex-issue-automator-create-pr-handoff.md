# fix(issue-automator): configure linear cli for cabrobot team

## Summary

Configure the Linear CLI at the project root to target the CabroBot (CB) team so all `linear` queries, searches, and issue operations use the correct workspace and team.

## Key Changes

### :wrench: Configure Linear CLI for CabroBot team

- Register `.linear.toml` at the project root targeting the CabroBot team
- Set team ID to `3aaac7ad-6ca9-419b-a99e-925d97e9ec03` (key `CB`)
- All `linear` CLI commands now default to the correct workspace and team

## Technical Implementation

### Linear CLI configuration

#### `.linear.toml` (new)

- Generated via `linear config --workspace knil` and edited to use the UUID team ID
- `workspace = "knil"` — matches existing credentials
- `team_id = "3aaac7ad-6ca9-419b-a99e-925d97e9ec03"` — CabroBot team UUID
- `issue_sort = "priority"` — default sort order

## Testing

### Verification

- `linear team list` — shows CB team with correct ID
- `linear team id` — returns the UUID
- `linear issue list` — correctly scoped to CB team

## References

- `issue-automator` skill
