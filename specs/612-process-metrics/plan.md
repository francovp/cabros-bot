# Plan

Reuse PR #1048 and merge current master, retaining current routes/auth/schema additions. Correct uptime units and capture hrtime before scheduling each immediate. Clear timer/immediate handles on every finish, and use the shared error envelope. Align scoped-key, correlation-ID and timeout contracts; exercise unit, integration, contract and full tests, local smoke, two independent reviews, then Codex review and deployment checks. Rollback: revert the additive metrics change.
