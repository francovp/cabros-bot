fix: preserve Discord 429 attempt counts in telemetry (CB-102)

## Summary

Include the request attempt count in all Discord notification return payloads (success, HTTP 429 exhaustion, non-429 errors, budget aborts, timeouts) and preserve that attempt count through NotificationManager for Sentry external failure reporting and Telegram admin failure alerting.

## Key Changes

- **DiscordService**: Updated `sendChunk` and `send` to include `attemptCount` in every result object (success, status error, 429 retry exhaustion, rate limit delay budget aborts, timeouts, and multi-chunk aggregations).
- **NotificationManager**: Preserves `result.attemptCount` when emitting Sentry external failure metrics and when constructing Telegram admin failure alert messages.
- **Unit Tests**: Updated `tests/unit/discord-service.test.js` to assert `attemptCount` across success, 400 error, 429 retry exhaustion, rate limit delay aborts, and added explicit test in `tests/unit/notification-manager.test.js` verifying propagation to admin alert messages.

## Technical Implementation

- `DiscordService.js`: Track `totalAttempts` across chunk iterations and populate `attemptCount: attempt` in `sendChunk` return structures.
- `NotificationManager.js`: Formatter reads `result.attemptCount` when building failure details string `attempts ${result.attemptCount}` and passes `attemptCount: result.attemptCount || 1` to `sentryService.captureExternalFailure`.

## Testing

- `pnpm test -- tests/unit/discord-service.test.js tests/unit/notification-manager.test.js --testTimeout=5000`
- `pnpm test -- tests/unit/ --testTimeout=5000`

## References

- **GitHub Issue**: https://github.com/francovp/cabros-bot/issues/254
- **Linear**: [CB-102](https://linear.app/knil/issue/CB-102/preserve-discord-429-attempt-counts-in-telemetry-gh-254)
