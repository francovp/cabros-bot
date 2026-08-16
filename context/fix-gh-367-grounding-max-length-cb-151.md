# fix: honor GROUNDING_MAX_LENGTH in active alert enrichment (CB-151)

## Summary

Enforce `GROUNDING_MAX_LENGTH` limit on alert text passed into the active enrichment prompt (`groundAlert` -> `generateEnrichedAlert`) while preserving full untruncated alert text for delivery, storage, and fallback.

## Key Changes

- Exported `GROUNDING_MAX_LENGTH` from `src/services/grounding/config.js` with positive integer fallback handling (default: 2000).
- Updated `src/services/grounding/grounding.js` to dynamically resolve `maxLength` from `process.env.GROUNDING_MAX_LENGTH` when not provided in options and forward it to `generateEnrichedAlert`.
- Updated `src/services/grounding/gemini.js` to bound the alert text component of `alertContext` to `maxLength` before constructing the enrichment prompt.
- Added comprehensive unit tests in `tests/unit/gemini-enrichment-max-length.test.js` and `tests/unit/grounding.test.js`.
- Added end-to-end integration test in `tests/integration/alert-grounding.test.js` asserting that `GROUNDING_MAX_LENGTH` bounds the prompt sent to the LLM while the full untruncated alert text is delivered to channels.

## Technical Implementation

- `src/services/grounding/config.js`: Parses `GROUNDING_MAX_LENGTH` with safe fallback to `2000` if invalid or <= 0, and exports it in `module.exports`.
- `src/services/grounding/grounding.js`: `groundAlert` resolves `maxLength` (supporting runtime env updates) and passes it in `options` to `generateEnrichedAlert`.
- `src/services/grounding/gemini.js`: `generateEnrichedAlert` bounds `text` to `maxLength` when building `alertContext` for `PromptKeys.ALERT_ENRICHMENT`, preventing token/cost overruns while leaving `original_text`, response payloads, and storage untruncated.

## Testing

- Verified initial test failures in `tests/unit/gemini-enrichment-max-length.test.js` and `tests/integration/alert-grounding.test.js` following strict TDD.
- Ran focused unit tests: `pnpm test -- tests/unit/gemini-enrichment-max-length.test.js` and `pnpm test -- tests/unit/grounding.test.js`.
- Ran focused integration tests: `pnpm test -- tests/integration/alert-grounding.test.js`.
- Ran full test suite: `pnpm test` (106 test suites, 1576 tests passed).
- Verified ESLint: 0 errors on modified files.

## References

- **Linear**: [CB-151](https://linear.app/knil/issue/CB-151/honor-grounding-max-length-in-active-alert-enrichment-gh-367)
- **GitHub Issue**: Fixes #367
