fix: preserve Discord 429 attempts (CB-102)

## Summary

Preserves the cumulative request count (`attemptCount`) in Discord HTTP 429 error results across retries and message chunks, and forwards this telemetry to Sentry and Telegram admin failure notifications. Also resolves merge conflicts with `master` and preserves optional prompt provenance metadata in alert grounding enrichment.

## Key Changes

- **Discord HTTP 429 Telemetry**: Updated `DiscordService` to track and return `attemptCount` across chunked message sends and retry loops.
- **Merge Conflict Resolution**: Merged latest `master` into `fix/issue-254-discord-attempt-telemetry`, resolving conflict markers in `agents.md` and `tests/unit/discord-service.test.js`.
- **Grounding Prompt Provenance**: Updated `generateEnrichedAlert` in `src/services/grounding/gemini.js` to expose `prompt_provenance` alongside `promptProvenance` for backwards compatibility.

## Technical Implementation

- `src/services/notification/DiscordService.js`: `sendChunk()` tracks attempts per chunk, and `send()` accumulates total attempts across all chunks before returning a 429 failure.
- `src/services/grounding/gemini.js`: Includes both `promptProvenance` and `prompt_provenance` property keys on the returned enriched alert object.
- `agents.md`: Documented Discord 429 attempt telemetry behavior and test coverage alongside alert risk-metadata coverage documentation.

## Testing

- Verified focused unit tests: `pnpm test -- tests/unit/discord-service.test.js` (15 passed) and `pnpm test -- tests/unit/gemini-client.test.js` (16 passed).
- Executed full test suite: `pnpm test` (43 test suites passed, 279 tests passed).

## References

- **GitHub Issue**: Fixes #254
- **Linear**: [CB-102](https://linear.app/knil/issue/CB-102/preserve-discord-429-attempt-counts-in-telemetry-gh-254)
