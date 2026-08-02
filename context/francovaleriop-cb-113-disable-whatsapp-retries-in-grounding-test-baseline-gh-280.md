fix: disable whatsapp retries in grounding test baseline (CB-113)

## Summary
Disable WhatsApp alerts in shared alert-grounding integration test baseline so tests don't trigger GreenAPI retry-exhaustion logs or cause unnecessary timeouts.

## Key Changes
- Updated `ENABLE_WHATSAPP_ALERTS` from `'true'` to `'false'` in `beforeEach` environment setup in `tests/integration/alert-grounding.test.js`.
- Updated default `mockFetch` for WhatsApp to return `{ success: true, idMessage: 'test-wa-message-id' }`.
- Added dedicated test `routes alert delivery to whatsapp when requested and handles successful idMessage response` with WhatsApp explicitly enabled and verified delivery.

## Technical Implementation
- Shared `beforeEach` setup now defaults WhatsApp to disabled, eliminating 3-retry exhaustion delays on baseline alert tests.
- Routing tests re-initialize `NotificationManager` after explicitly configuring WhatsApp env variables.

## Testing
- Executed `pnpm test -- tests/integration/alert-grounding.test.js` (10 tests passed in 8.7s with zero GreenAPI retry exhaustion errors).

## References
- GitHub Issue: https://github.com/francovp/cabros-bot/issues/280
- **Linear**: [CB-113](https://linear.app/knil/issue/CB-113/disable-whatsapp-retries-in-grounding-test-baseline)
