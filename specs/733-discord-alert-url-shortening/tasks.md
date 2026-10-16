# Tasks: Discord Alert URL Shortening

**Input**: [spec.md](spec.md) and [plan.md](plan.md)  
**Prerequisites**: Requirements and implementation plan complete.

## Implementation and Verification

- [x] T001 Inspect the existing formatter and shared URL-shortener wiring in `src/services/notification/`.
- [x] T002 Pass the shared shortener to Discord alert formatting in `src/services/notification/DiscordService.js` and `src/services/notification/NotificationManagerBootstrap.js`.
- [x] T003 Preserve the shortener in admin dry-run formatting in `src/controllers/admin/testAlert.js`.
- [x] T004 Cover successful shortening, failure fallback, bootstrap wiring, and Discord service behavior in the existing unit and integration tests.
- [x] T005 Add provider hostname lookalikes and use parsed exact hostnames in `tests/integration/cross-channel-url-shortening.test.js`.
- [x] T006 Run the focused cross-channel integration suite.
- [ ] T007 Run focused Discord and notification-bootstrap unit suites.
- [ ] T008 Push the review fix, clear applicable PR review threads, and verify CI and OpenClaw deployment evidence.

## Dependencies

- T001 precedes T002–T005.
- T006–T008 validate the implementation and delivery.
