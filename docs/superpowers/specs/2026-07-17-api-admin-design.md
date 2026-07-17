# API administration site design

## Goal

Add an operator website at `/admin` to manage Cabros Bot's existing protected API. It provides dedicated workflows for operations, alerts, scanner presets, asynchronous jobs, and market analysis, plus a generic OpenAPI-based playground.

## Chosen approach

The administration UI is served by the existing Express application under `/admin`. It uses the current deployment as the API origin, so it does not require CORS changes or a separate deployment. It is an API client only: it adds no authentication backend, data store, or proxy.

The operator enters an API key in the browser. The key is kept only in `sessionStorage`, sent only as the existing `x-api-key` request header, and cleared when the browser session ends. It is never placed in URLs, logs, page markup, or API responses.

## Interface

- **Status**: fetches `/api/status` and shows readiness, capabilities, feature flags, and dependency state.
- **Alerts**: lists stored alerts, supports filtering and paging, shows alert details, and permits replay after a clear confirmation.
- **Scanner presets**: lists, creates, updates, deletes, and runs existing presets. Delete and run require confirmation.
- **Jobs**: creates TradingView analysis jobs, polls selected job status, and exposes the existing cancel/retry actions only when applicable.
- **Analysis**: provides focused request forms for expanded analysis, market scanner, volume confirmation, and news monitor.
- **Playground**: builds arbitrary requests from the public `/openapi.json` contract. It supports the documented method, path, query parameters, JSON body, request execution, and formatted response rendering.

## Data flow and failure handling

Browser actions call existing `/api` endpoints directly with `fetch`. The UI preserves server status codes and response bodies for the operator, masks API-key fields in visible request summaries, and gives actionable responses for unavailable capabilities, request validation errors, and network failures. A failed request never prevents a subsequent operation.

The UI reuses the current `validateApiKey` protection; no protected route is changed or bypassed. The existing public `/docs` and `/openapi.json` remain read-only.

## Scope boundaries

This first version does not add user accounts, server-side credential storage, a proxy, audit persistence, a new API endpoint, or a custom UI for every OpenAPI operation. The Playground is the escape hatch for endpoints without a dedicated workflow.

## Verification

Add focused tests for static admin delivery and client request construction where practical, update the Postman collection only if an API contract changes (none is planned), and run the full project test suite after implementation.
