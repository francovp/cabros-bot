# Scanner Preset Destinations

## Goal

Allow operators to route each scanner preset to its own Telegram, WhatsApp, and Discord destinations for manual, scheduled, and asynchronous runs.

## User Stories

- As an operator, I can configure multiple destinations per channel on a preset and opt that preset into destination-bound delivery.
- As an operator, a new preset keeps the current inherited broadcast behavior unless I explicitly choose `mode: "preset"`.
- As an operator, existing presets with legacy `channels` and singular destination fields retain their current routing after reads and updates.
- As an operator, a manual run can override saved destinations, or request existing job execution with `runAsyncJob: true`.
- As an operator, `/api/status` reports that preset destination routing is supported without disclosing destination values.

## Requirements

1. Presets store `mode: "preset" | "inherit"` and optional `destinations.telegramChatIds`, `destinations.whatsappChatIds`, and `destinations.discordWebhookUrls` arrays.
2. Destination arrays are validated at create/update time using the existing request-routing format checks. Invalid input returns `400 INVALID_DESTINATIONS`.
3. `inherit` preserves broadcast behavior. `preset` delivers only to configured preset destinations. Existing records without `mode` preserve their legacy routing behavior.
4. Manual request routing overrides saved destinations. Existing legacy `channels` and per-channel destination request fields remain supported.
5. Scheduled and manual runs use the same routing resolution and notification dispatch path.
6. `runAsyncJob: true` on a manual run creates an existing `market-scanner` job and persists the resolved routes in job metadata. Worker completion dispatches to the persisted destinations. Synchronous execution remains the default.
7. Destination values remain operator-scoped. `/api/webhook/market-scanner-alert` does not accept or resolve preset destinations; status responses expose no destination values.
8. OpenAPI, Postman, README/operator docs, and focused tests match the runtime behavior. No new environment variable or queue dependency is introduced.

## Non-goals

- Per-chat subscriptions or destination management UI.
- Changes to direct market-scanner webhook routing.
- Changes to existing job execution-mode gates or retention.
