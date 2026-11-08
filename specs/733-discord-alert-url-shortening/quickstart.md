# Quickstart: Discord Alert URL Shortening

## Verify the feature

Run the focused cross-channel integration suite from the repository root:

```bash
pnpm test -- tests/integration/cross-channel-url-shortening.test.js
```

The suite checks that Discord and WhatsApp use the same shortened source links, shortening failures retain original links, and mock request matching rejects hostname/path lookalikes.

## Runtime behavior

- Discord uses the existing shared URL shortener when initialized.
- No shortener configuration means normal unshortened formatting.
- A shortener failure preserves the original URLs and does not block notification delivery.
- No new endpoint, environment variable, or API contract is introduced.
