# Research: Discord Alert URL Shortening

## Existing Behavior

- `WhatsAppMarkdownFormatter` accepts an optional `urlShortener`, batches source URLs through `shortenUrlsParallel`, and preserves original URLs when shortening fails.
- `DiscordService` renders enriched alerts through `WhatsAppMarkdownFormatter` and can use the same formatter contract.
- `NotificationManagerBootstrap` owns the shared shortener instance; no new service or credential is needed.
- Green API URLs use an instance-specific hostname such as `1101234567.api.green-api.com`, as documented in `.env.example` and `docs/environment-configuration.md`.

## Decisions

1. Share the existing shortener instance with Discord. This preserves URL mapping behavior and avoids duplicate shortening requests.
2. Keep fallback behavior in the formatter. A provider failure must not block the alert or remove its source links.
3. Use parsed hostname equality in the integration test. URL substring matching accepts unrelated hosts or paths containing `discord.com` or `green-api.com`.
4. Use a valid Green API fixture URL and `apiKey`; the service appends that key to its configured base URL.

## Unresolved Questions

None. The issue's acceptance criteria specify the existing service, configuration, and fallback behavior.
