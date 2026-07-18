feat(skill): add detect-unused-features skill for Render production capability audit (CB-61)

## Summary

Add a `detect-unused-features` skill that audits the Render production deployment for disabled feature flags, unexposed capabilities, and `.env.example` gaps — then files actionable GitHub issues.

## Key Changes

### :mag: New skill: `detect-unused-features`

- Creates `.agents/skills/detect-unused-features/SKILL.md` with an 8-step audit workflow
- Fetches production `GET /api/capabilities` via curl to get live feature flag state
- Maps each disabled flag to specific env vars, credentials, and code paths for enablement
- Cross-references `ENABLE_*` vars in `src/` against `src/controllers/status.js` featureFlags to find unexposed capabilities
- Audits `.env.example` for missing env var documentation
- Detects Sentry profiling misconfiguration (flag enabled but missing `SENTRY_PROFILE_SESSION_SAMPLE_RATE`)
- Compares production commit vs master to flag unreleased merged features
- Files one deduplicated GitHub issue per finding with full enablement instructions

## Technical Implementation

### File Structure

    ```
    .agents/skills/detect-unused-features/
    └── SKILL.md                     # 247-line skill with automated audit workflow
    ```

No dependencies added, no existing files modified, no production code changed.

## Testing

All unit and integration tests (915 tests total across 70 test suites) were run locally and passed successfully.

## References

- Related skill: `.agents/skills/trading-profit-opportunity-scout/SKILL.md`
- Related skill: `.agents/skills/issue-automator/SKILL.md`
- **Linear**: [CB-61](https://linear.app/knil/issue/CB-61/featskill-add-detect-unused-features-skill-for-render-production)
