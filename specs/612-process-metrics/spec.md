# Process metrics (#612)

Operators need a protected process-health snapshot without an always-running sampler. GET /api/metrics uses the existing admin-read authorization (including the scoped admin key). Return finite or null memory bytes, cumulative CPU microseconds, uptime seconds, Node version, process metadata, and mean/max lag milliseconds across five immediate callbacks. Clear probe resources after success or the one-second deadline; telemetry failure cannot crash the process.

Acceptance: unauthenticated/invalid credentials fail; authorized requests expose no secrets; uptime preserves seconds; queued callback delay contributes to lag; the deadline cancels pending work; OpenAPI/Postman agree with runtime. No new env or Remote Config settings.
