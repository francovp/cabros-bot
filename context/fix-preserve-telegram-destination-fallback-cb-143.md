# fix: preserve per-request Telegram destination during Markdown fallback (CB-143)

## Summary

This change ensures that `TelegramService.send()` uses the resolved `chatId` (including per-request `telegramChatId` overrides) for both the primary MarkdownV2 delivery attempt and its plain-text fallback retry when MarkdownV2 entity formatting fails.

## Key Changes

- Updated `TelegramService.js` to pass `chatId` instead of `this.chatId` to `this.bot.telegram.sendMessage()` inside the MarkdownV2 parse-error fallback handler.
- Added unit tests in `tests/unit/telegram-service.test.js` asserting that per-request `telegramChatId` overrides are used for both the primary MarkdownV2 attempt and the plain-text fallback retry, as well as preserving default chat destination.

## Technical Implementation

- In `TelegramService.send(alert)`, `chatId` is resolved once at the top as `alert.telegramChatId || this.chatId`.
- Previously, line 115 retried plain-text delivery using `this.chatId`, which routed fallback alerts to the default chat instead of the requested override channel.
- Replacing `this.chatId` with `chatId` ensures destination consistency across formatting retries and message chunks without modifying Telegram formatting, message splitting, or error handling semantics.

## Testing

- Ran focused unit test suite: `pnpm test -- tests/unit/telegram-service.test.js` (passed 4/4 tests, including initial TDD failure verification).
- Ran full test suite: `pnpm test` (passed 1431/1431 tests across 102 test suites).

## References

- **Linear**: [CB-143](https://linear.app/knil/issue/CB-143/preserve-per-request-telegram-destinations-during-markdown-fallback)
- **GitHub Issue**: https://github.com/francovp/cabros-bot/issues/360
