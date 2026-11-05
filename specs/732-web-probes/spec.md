# Web liveness and readiness probes

Issue: https://github.com/francovp/cabros-bot/issues/732
Acceptance authority: decision comment 6645596475 (2026-11-04).

## User scenarios and requirements

- Operators can call public GET /livez and receive 200 `{status: "alive", uptimeMs}` without dependency I/O, including during shutdown.
- Public GET /readyz returns `{status: "ready" | "not_ready", checks: [{name, status}]}`. Check statuses are `ready`, `unconfigured`, or `fail`.
- Reuse the existing cached dependency readiness service and bootstrap state. Preserve its conservative verdict: at least one considered dependency must be healthy and all considered dependencies must be healthy. Disabled dependencies are unconfigured.
- Pending/failed bootstrap or process drain returns 503; dependency failures return 503. Recheck lifecycle after asynchronous dependency collection.
- Preview/API-only Telegram disablement alone does not fail readiness. Existing bootstrap rules determine required components.
- Preserve /healthcheck and /ready responses and deployment healthCheckPath. Worker health stays heartbeat-based; no HTTP listener added.
- No new environment variables, Remote Config settings, or external dependencies. Public payloads contain check names/status only, never provider errors or configuration.
- New probe paths share the existing deadline/logging exemption so a short API timeout cannot replace their bounded readiness response with HTTP 408.

## Success criteria

Integration coverage proves dependency failure, startup failure, drain (including during a probe), healthy API-only previews, liveness without I/O, and legacy compatibility. OpenAPI, Postman and operator docs agree with runtime.
