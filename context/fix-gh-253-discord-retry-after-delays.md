# fix: stop truncating Discord Retry-After delays (CB-101)

## Summary

Discord webhook rate-limit retries previously truncated parsed `Retry-After` delay hints to `maxRetryDelayMs` (default 5000ms), causing retries to be sent before the provider-requested delay elapsed. This change updates `DiscordService.sendChunk` to abort retry loops immediately if the provider-requested delay exceeds `maxRetryDelayMs` or remaining total wait budget, honoring Discord rate limits and returning a bounded HTTP 429 response without retrying early.

## Key Changes

- **DiscordService**: Updated `sendChunk` to evaluate `requiredDelayMs` directly against `maxRetryDelayMs` and `maxTotalRetryWaitMs`. If `requiredDelayMs` exceeds `maxRetryDelayMs`, the service logs a warning and aborts retries without sending early follow-up requests.
- **Unit Tests**: Added test cases in `tests/unit/discord-service.test.js` covering header and JSON body `Retry-After` values that exceed `maxRetryDelayMs` to verify no early follow-up requests are issued.

## Technical Implementation

- Removed `effectiveDelayMs = Math.min(rawDelayMs, this.maxRetryDelayMs)` truncation logic in `DiscordService.js`.
- Added explicit boundary check `if (requiredDelayMs > this.maxRetryDelayMs)` to log and return bounded HTTP 429 error.
- Preserved full provider delay sleep `await sleep(requiredDelayMs)` when delay fits within configured budgets.

## Testing

- `pnpm test -- tests/unit/discord-service.test.js` (Passed, 14/14 tests)

## References

- Fixes #253
- **Linear**: [CB-101](https://linear.app/knil/issue/CB-101/honor-discord-retry-after-delays-253)
