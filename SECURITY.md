# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Cabros Bot, please report it through **GitHub's private vulnerability reporting** for this repository:

- https://github.com/francovp/cabros-bot/security/advisories/new

Do **not** open a public GitHub issue, send a public pull request, or post the report to any public channel. Public disclosure gives attackers time to exploit the issue before a fix is shipped and endangers every operator of this service.

If private vulnerability reporting is temporarily unavailable, do not disclose the vulnerability publicly; wait until the private reporting channel is restored.

We aim to acknowledge new reports within **3 business days** and to provide a triage outcome (accepted / duplicate / out of scope / needs more info) within **10 business days**. Timelines for a fix depend on severity and complexity; we will coordinate a disclosure window with you before publishing any advisory or patch.

## Safe Harbor

We will not pursue legal action against, request law enforcement investigation of, or restrict your account for, security research conducted in good faith that:

- Respects the scope and out-of-scope guidance below.
- Avoids privacy violations, data destruction, and disruption of the service for other users.
- Stops as soon as you confirm a vulnerability and shares reproduction details privately.
- Does not exploit a vulnerability beyond what is necessary to demonstrate it.

We expect researchers to give us a reasonable opportunity to remediate before any public disclosure.

## Scope

The following surfaces are **in scope** for vulnerability reports:

- The deployed HTTP API mounted under `/api/*`, including webhook ingest endpoints, the protected status / capabilities / jobs endpoints, the public OpenAPI contract at `/openapi.json`, and the Swagger UI at `/docs`.
- The browser admin console served from `/admin` and the Firebase Hosting deployment of that console.
- Telegram, WhatsApp, and Discord delivery paths, including authentication tokens, chat ID handling, retry logic, and Markdown formatting.
- The async TradingView job callback endpoints, including HMAC-SHA256 signature validation, SSRF-pinned DNS resolution, retry handling, and idempotency claims.
- The Binance Spot order execution controller (`/api/trading/binance/orders`), including API-key and admin authentication, exchange-info filter validation, request matching, idempotency, and reconciliation.
- Server-side Firestore persistence for alerts, replay attempts, idempotency claims, scanner presets, jobs, and signal outcomes, plus server-side Firebase Remote Config loading.
- Webhook authentication (`validateApiKey` timing-safe comparison, Firebase ID-token verification for the admin console).

The deployed service is publicly reachable at `https://cabros-bot-production.up.railway.app`; authorized Railway PR previews use the host pattern `cabros-bot-cabros-bot-pr-<PR_NUMBER>.up.railway.app`. Do not target any other infrastructure you may discover during research.

## Out of Scope

The following are **out of scope** and should not be reported through this channel:

- Bugs in third-party services we integrate with (GreenAPI, TradingView MCP, Binance, Telegram, Discord, Firebase, Google Gemini, Langfuse, Cloudflare AI Gateway, Twelve Data, Azure AI Inference, OpenRouter). Report those to the upstream maintainers instead.
- Social engineering, phishing, or credential-stuffing attacks against maintainers, operators, or users.
- Denial-of-service attacks, volumetric traffic, or rate-limit bypass research. The service already publishes rate-limit configuration in `agents.md`; report the configuration if you discover a flaw, not the result of exhausting it.
- Missing security headers that have no exploitable impact on the deployed routes (for example, headers that protect only the unauthenticated root route).
- Lack of a feature we have not implemented (request it as a normal issue, not a vulnerability).
- Scanner-generated findings with no reproducer and no demonstrated impact.
- Recently disclosed vulnerabilities that have not yet had a fix release and are documented in the project's commit history.

## What to Include

Helpful reports include:

- A clear, reproducible description of the vulnerability and its impact.
- The endpoint, payload, or configuration that triggers the issue.
- A proof-of-concept that does not depend on credentials you do not own.
- The environment (preview or production) and the timestamp of the observation.
- Your assessment of severity (for example, using CVSS) and any suggested mitigations.

If you can encrypt the report, use the maintainer's PGP key from their GitHub profile; otherwise plain Markdown in the private advisory is sufficient.

## Recognition

We credit reporters who follow this policy in release notes and security advisories unless you ask to remain anonymous. Responsible disclosure strengthens the service for the operators and users that depend on it.
