# Quickstart: Request-level Trader Intent Outcomes

1. Set the existing local API key and safe notification/test configuration; do not print credentials.
2. Run `pnpm test -- tests/unit/trader-intent.test.js`.
3. Run the focused alert, symbol-analysis, storage, outcome, OpenAPI, and Postman suites listed in `tasks.md`.
4. Start with `pnpm run start-dev`; verify `GET /healthcheck`.
5. Submit an invalid BUY plan and confirm `400 INVALID_REQUEST` before delivery.
6. Submit a valid dry-run alert with a complete plan and confirm the sanitized plan is returned without notification delivery.
7. Run `pnpm test` once, then `git diff --check` and parse all changed JSON/YAML.

Expected compatibility result: an otherwise identical request that omits `traderIntent` retains its existing status and response shape.
