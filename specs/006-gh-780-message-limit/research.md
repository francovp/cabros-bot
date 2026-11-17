# Research: Configurable generic message limit

## Findings

- The current generic-message handler clips at a constant 4,000 characters and appends `...`. It reports `truncated`, `originalLength`, and `deliveredLength` only when clipping occurs; this behavior is already merged through PR #946 for issue #602.
- `RemoteConfigService` already validates numeric settings with defaults and inclusive bounds. `getRuntimeConfig()` uses environment values when Remote Config is disabled/unavailable and overlays a fresh Remote Config template when one has loaded.
- The former GH-780 PR used direct `process.env` parsing and changed the response contract. The repository owner closed it because it would rename fields, change the non-truncation response, and omit newer routing/storage behavior. The owner requested a narrow follow-up that keeps the current response and uses `getRuntimeConfig()`.

## Decisions

### Read the effective value from the shared runtime configuration service

- **Decision**: Register `GENERIC_MESSAGE_MAX_LENGTH` as an eligible bounded numeric setting and read it when validating each request.
- **Rationale**: This reuses existing environment parsing, Remote Config precedence, freshness handling, and fail-open behavior without a second parser or request-time network call.
- **Alternatives considered**: Parse `process.env` directly (does not observe Remote Config and duplicates validation); accept a per-request length override (changes the public request contract and conflicts with the operator-controlled scope).

### Preserve existing truncation semantics

- **Decision**: Keep the 4,000-character default, the 1..20,000 range, the existing suffix, and metadata only when truncation occurs.
- **Rationale**: This completes the unshipped configuration part of GH-780 while preserving the already-deployed GH-602 response contract.
- **Alternatives considered**: Always include metadata or rename `deliveredLength` to `messageLength` (breaking response-shape changes rejected in the closed PR review).

## Open Questions

None. The owner specified the default, bounds, runtime source, and compatibility constraints in the existing GH-780/PR #1087 discussion.
