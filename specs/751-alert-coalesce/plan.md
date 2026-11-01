# Implementation plan

Spec: specs/751-alert-coalesce/spec.md. Execute inline under issue-automator.

1. Red: integration tests concurrent duplicates, disabled default, destination isolation and failed delivery retry.
2. Implement bounded hash-keyed reservations with completion, TTL and generation-safe release. Unit-test expiry, eviction, failure and stale owners.
3. Integrate after validation, before enrichment. Finalize only full successful delivery; release in finally. Test zero/partial delivery, bypasses and cache failures.
4. Synchronize env, Remote Config schema/template/tests, README, OpenAPI and executable Postman example. Run focused tests, local HTTP smoke, full pnpm test once and diff check.
5. Sequential independent defect and Ponytail reviews, publish via create-pr, complete Codex feedback/quiet-window gates, merge if ready and validate master E2E.
