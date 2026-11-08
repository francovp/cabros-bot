## Virgin Trainee 🤖

Picking up issue #1255 - feat(whatsapp): register WHATSAPP_COMMAND_POLL_INTERVAL_MS in Remote Config schema and template.

### Plan
1. Register `WHATSAPP_COMMAND_POLL_INTERVAL_MS` in `RemoteConfigService.js` with type `number`, default `3000`, `min: 500`, `max: 60000`
2. Add parameter to `firebase-remote-config-template.json`
3. Consume parameter in `WhatsAppCommandBridgeService` via runtime/remote config
4. Add unit tests for bounds validation and Remote Config updates

Starting implementation...