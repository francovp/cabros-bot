#!/usr/bin/env python3
"""Post Virgin Trainee engagement comments on NEW issues/PRs since last scan."""

import jwt
import time
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

APP_ID = "4766306"
KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_token():
    with open(KEY_PATH, "rb") as key_file:
        private_key = serialization.load_pem_private_key(
            key_file.read(), password=None, backend=default_backend()
        )
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    headers = {"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    res = requests.get("https://api.github.com/app/installations", headers=headers)
    installation_id = res.json()[0]["id"]
    token_res = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens", headers=headers
    )
    return token_res.json()["token"]

def post_comment(token, issue_number, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    res = requests.post(url, headers=headers, json={"body": body})
    if res.status_code == 201:
        print(f"✅ Posted to #{issue_number}")
        return True
    else:
        print(f"❌ Failed #{issue_number}: {res.status_code} - {res.text}")
        return False

# New issues/PRs since last run (2026-09-27T00:17:40Z) not in engaged list
COMMENTS = {
    1203: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1203: test(jest): full-suite failures are order-dependent — this is a classic cross-suite state leakage problem!

1. **Shared module state**: The evidence shows `news-monitor` keeps a singleton cache, and `analyzer` already had a fix for this exact class of problem in `tests/unit/analyzer.test.js` using `jest.isolateModules()`. Is there a common pattern here for how to isolate modules that hold state (cooldown managers, quota trackers, etc.)?

2. **Env/global leakage**: `tests/setup.js` and suites that flip `process.env` flags (maintenance mode, Firebase enablement, dry-run) can leak into later suites. Should `tests/setup.js` include a `beforeEach` that snapshots/restores `process.env`? Or is there a Jest preset/config that handles this?

3. **`sync-production-env.test.js` constant failure**: This was a genuine bug (asserting `AGENTS.md` content stripped by doc-sync automation), now resolved. But it appeared in *every* run — does that mean it ran early and poisoned state for later suites, or is it just the canary that always fails first?

4. **Bisect strategy**: The suggestion to run with `--runInBand` to isolate cross-suite interference is solid. Once a specific offender is identified, the fix should be at the root (isolation/reset) rather than adding retries that mask real regressions.

5. **Acceptance criteria**: Three consecutive full-suite green runs is a good bar. Should there also be a CI gate that fails the build if any suite fails in full-suite but passes in isolation (a "flake detector" job)?

This is the kind of test hygiene that pays dividends every merge — love that it's being addressed systematically!""",

    1201: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1201: public/admin/admin.js has drifted from src/admin/admin.js — this is a critical build-reproducibility issue!

1. **Test mutates working tree**: `tests/unit/firebase-hosting-config.test.js` imports `scripts/build-hosting.js` and calls `buildHosting()`, which blindly copies `src/admin/*` → `public/admin/*`. Any `pnpm test` run executes this copy, silently overwriting fixes in `public/admin/admin.js` that don't exist in source. The revert manifests as `MM` status (staged ≠ unstaged) — a silent local revert that contributors can easily commit without touching `build:hosting` or the deploy workflow.

2. **Two divergent copies**: `public/admin/admin.js` (6,274 lines) has a `handshakeTimeoutMs`/`handshakeTimer` SSE handshake guard (7 occurrences), while `src/admin/admin.js` (6,261 lines) lacks it entirely. Regenerating from source deletes the fix. This is the exact pattern that bit you twice in one session.

3. **Postman collection same risk**: During one merge, `CabrosBot.postman_collection.json` and its test also had to be pinned back to master because the stale branch produced a result differing from both sides.

4. **Suggested fixes**:
   - Make the test **not** mutate working tree — assert against temp output dir or restore files after asserting
   - Add post-copy verification in `build:hosting` to fail loudly when `src` and `public` diverge on content it didn't write
   - Consider making `public/admin/*` generated-and-gitignored; serve artifact built in CI

This is a perfect example of "tests should not have side effects on the repo" — the fix in #1201 should prevent this class of silent revert entirely!""",

    1200: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1200: Crypto `/precio` truncates prices to whole dollars while equity keeps cents — a precision bug hiding in plain sight!

1. **Root cause**: `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js:158` uses `round10(data.price, 0)` (0 decimals) while the equity path at line 247 uses `round10(quote.price, -2)` (2 decimals). A BTC price of $104,523.47 is reported as $104,523 — 47 dollars of error!

2. **Inconsistency within same message**: The 24h ticker high/low formatting at line 40 correctly uses `-2` (2 decimals), but the spot price on the same reply uses `0` — visibly inconsistent within a single `/precio` response.

3. **Proposed fix**: Change line 158 to `round10(data.price, -2)` to match the equity path. For sub-cent precision on low-priced assets, gate on price magnitude rather than dropping to zero decimals for everything `>= 1`.

4. **Risk**: Low — presentation-only change; no API, webhook, or notification contract affected. The existing `BINANCE_FETCH_TIMEOUT_MS` handling and bare-price fallback on provider failure remain unchanged.

This is a great catch — the equity path getting it right proves the crypto behavior is an oversight, not a deliberate rule!""",

    1199: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1199: Outcome evaluation counts the partially-elapsed entry candle — this silently inflates MFE/MAE and forges target/stop hits!

1. **The bug**: `SignalOutcomeService.js:1194-1200` fetches klines starting at `receivedAtMs` (mid-bar). The first returned kline has `openTime <= receivedAt < closeTime`, but its `high`/`low` include pre-entry movement. The evaluation loop treats the entire bar as post-entry.

2. **Concrete failure**: Entry at 100, signal arrives 1min into a 5m bar that opened at 99. MAE computed as -1% (99→100) but true post-entry excursion is only -0.4%. The same bar's `high` can register a `targetHit` — a **fabricated win on a target the price touched before entry**.

3. **Propagation**: Wrong values flow into `hitRatePercent`, `targetHitRatePercent`, `stopHitRatePercent`, `expectancyR`, `returnPercent`, and `firstHitTime` — the exact metrics the product uses to tell traders which setups work.

4. **Proposed fix**: Skip the leading partial bar when `receivedAtMs > barOpenTime`, or clip it (skip stop/target checks for pre-entry portion, persist `firstBarPartial: true` flag). The flag lets consumers exclude affected windows.

5. **Related**: #650 fixed a closely-related intrabar-attribution problem for equity daily bars; this is the same defect class on the crypto sweep path.

This is the kind of silent data corruption that biases backtest results in ways nobody can detect downstream — critical to fix!""",

    1198: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1198: News-monitor pause is process-local — it never pauses the scheduler running in the Render worker! 🚨

1. **Two processes**: The pause endpoints are mounted on the **web** service (`src/routes/index.js:128-130`), but the scheduler runs in a **separate Render worker** (`render.yaml:69-119` with `NEWS_MONITOR_SCHEDULER_WORKER_ROLE: worker`).

2. **Process-local state**: `pauseState.js` uses a module-level `let` — one copy per Node process, never persisted. `POST /api/news-monitor/pause` flips a flag in the web process, `/api/news-monitor/status` reports `paused: true`, but the worker keeps sweeping.

3. **Silent failure**: The API says paused, so the operator believes the bleed is stopped. The scheduled sweeps keep firing and spending Gemini quota. The flag also resets on every web deploy/restart.

4. **Proposed fix**: Back the pause state with a shared store (Firestore `newsMonitorPause` document), following the pattern in `ChatPreferenceService.js`. Read with TTL cache, fail-open to last known value on Firestore error. Default to existing in-process behavior when gate is off.

5. **Compounds with #1177**: Diagnosing "news monitor never runs" requires a working pause toggle — and the toggle doesn't stop the worker.

This is an incident-response control that fails silently — exactly the kind of thing that causes 3 AM pages!""",

    1197: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1197: Scanner ranking treats missing indicator data as RSI 0 and awards squeeze bonus to absent BBW — this fabricates signal quality!

1. **Root cause**: `numberOrNull()` at `marketScannerScoring.js:291-294` returns `0` for `null`/`undefined` because `Number(null) === 0`. Call sites pass `?? null` for missing fields, but the `else` branches for "no data" (defaults: `momentumScore = 5`, `volumeScore = 3`) are **unreachable**.

2. **Two concrete failures**:
   - **Fabricated `RSI 0.0`**: Items with no indicator data get `momentumScore = 0` and chase penalty `-15`, scored as maximally-chased shorts
   - **Missing BBW grants max squeeze bonus**: `bbw: null → 0`, and `0 < 0.1` satisfies squeeze branch → `volatilityScore = 10` (highest possible). Items with no BBW rank above real trends.

3. **Proposed fix**: Make absence distinguishable from zero at parse boundary — check for `null`/`undefined`/empty string before `Number()`, then make consumers treat `null` as "no data" (use defaults, omit from reason string, no squeeze bonus).

4. **Risk**: Low — confined to one parsing helper plus consuming branches; complete-data items unaffected.

The scanner's entire product value is a trustworthy ranked shortlist — this makes it prefer items whose data is *missing* over items with real indicators!""",

    1204: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1204: feat(api): exempt public docs and admin console from global rate limiter (GH-768) — great ops improvement!

1. **Middleware order**: Mounting `getOpenApiDocsRouter()` **before** `rateLimiter` in `app.js` is the cleanest way to exempt `/openapi.json`, `/docs`, `/admin`, and static assets. Mirrors the existing exemption for `/healthcheck` and `/ready`.

2. **Operator impact**: Swagger UI issues multiple `no-cache` asset fetches per page load — previously these could exhaust the 100 req/15 min budget, or an API-key client under rate limit could lock the operator out of docs. This fixes both.

3. **Test coverage**: 2 integration tests added — docs/admin accessible after global limit exhausted, and browsing them doesn't consume the budget. Full suite: 198/198 test suites, 3978/3978 tests PASS.

4. **Documentation**: Updated `README.md`, `AGENTS.md`, `CabrosBot.postman_collection.json`, and context doc. The `public/admin/admin.js` sync via `build:hosting` is noted (pre-existing src/public drift from master).

5. **Acceptance criteria met**: Client exhausting `/api/*` budget can still fetch docs/admin without 429; protected `/api/*` behavior unchanged; docs updated.

Clean, surgical fix with comprehensive test coverage — exactly the kind of middleware ordering fix that prevents operator lockout during incidents!""",

    1193: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1193: feat(webhooks): classify alerts with signalClass enum (GH-858) — great addition for alert observability and routing!

1. **signalClass enum values**: The review mentions a closed string enum. What are the canonical values? `breakout`, `reversal`, `continuation`, `unknown`? Having the enum defined in one place (OpenAPI + validation + formatters) would prevent drift.

2. **Classification logic**: Is the classification done at webhook ingest time (based on alert payload) or downstream (based on analysis)? The `area/webhooks` + `area/trading` labels suggest it's part of the webhook pipeline.

3. **Routing impact**: Will `signalClass` drive notification routing (e.g., `breakout` → high-priority channel, `continuation` → batched digest)? Or is it primarily for analytics/outcome tracking?

4. **Backfill**: For existing alerts in Firestore, is there a migration to add `signalClass`, or will they be `unknown` until re-processed?

5. **Testing**: The `automation/skip` label suggests manual review — are there integration tests covering the enum validation and downstream consumers (formatters, routing, `/api/alerts/summary`)?

This adds structured signal taxonomy — a foundation for smarter alerting and outcome analysis!""",

    1090: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1090: feat(mcp): add strategy backtest endpoints (#629) — comprehensive TradingView MCP integration!

1. **Interval normalization**: Mapping `4h` and `240` to `1h` before calling upstream MCP tools — is this an upstream limitation (TV MCP only supports `1h`/`1d`)? The request parser handles this transparently.

2. **Caching strategy**: Deterministic parameter sorting + in-memory TTL cache in `StrategyResearchCache` prevents upstream rate limits. Is the cache key just sorted params, or does it include the tool name? The hash approach should handle param-order independence.

3. **Fail-open isolation**: Firestore persistence runs asynchronously and fails open; MCP upstream errors map to 400, 404, 429, 502, 504. This is the right pattern — persistence never blocks the response.

4. **Remote Config gating**: `ENABLE_STRATEGY_RESEARCH`, `STRATEGY_RESEARCH_CACHE_TTL_MS`, `STRATEGY_RESEARCH_RETENTION_DAYS` registered in `RemoteConfigService.js`, `firebase-remote-config-template.json`, `.env.example`. Feature flag in `/api/status` under `dependencies.tradingViewStrategyResearch`.

5. **Multi-user feedback incorporated**: @francovp's upstream schema requirements (enum values, interval mapping, caching) and @gigachad-senior-dev's scope concerns addressed by modular service layers and comprehensive test coverage (113 test suites, 2,204 tests passing).

6. **GLOBAL_BLOCKED + need manual PR deploy**: What's the deployment blocker? Is it the Firestore index requirement for `strategyResearch` collection, or something else?

This is a substantial feature with proper isolation, caching, and observability — impressive scope management!""",

    1209: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1209: chore(deps): bump actions/setup-java from 4 to 6 — major version upgrade for GitHub Actions!

1. **Breaking changes**: v6 migrates from Zulu Discovery API to Azul Metadata API, migrates to ESM, renames `jdkFile` input to `jdk-file` (with deprecated alias), and changes Maven cache key patterns. Any workflows using `actions/setup-java` need review for these.

2. **Security fixes**: Template injection fixes (zizmor alerts #118, #122) in e2e workflows, disabled persisted checkout credentials in e2e workflow.

3. **New features**: `cache-primary-key` output exposed, support for multi-field Java versions (e.g., `18.0.1.1`), pinning `java-version` as `"latest"`, Maven toolchains preserved across runs, Liberica NIK support.

4. **Compatibility score**: Dependabot provides a compatibility score — what's the score for this PR? High score = safe to merge after CI passes.

5. **Testing**: The project uses Java in CI (likely for Android or backend services). Does the full test suite run with this action? Any custom Maven/Gradle cache configs that might need updating?

Dependabot will auto-rebase — good to merge once CI green and compatibility score is acceptable!""",

    1208: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1208: chore(deps): bump actions/checkout from 4 to 7 — major upgrade with breaking changes!

1. **v7 breaking change**: Blocks checking out fork PR for `pull_request_target` and `workflow_run` by default — this is a **security hardening** (safer defaults for `pull_request_target`). Requires explicit `allow-unsafe-pr-checkout: true` if needed.

2. **v6 breaking change backported**: `allow-unsafe-pr-checkout` backported to v6.1.0 — the blog post https://github.blog/changelog/2026-06-18-safer-pull_request_target-defaults-for-github-actions-checkout/ explains the security rationale.

3. **ESM migration**: Module upgraded to ESM, `uuid` removed, `@actions/core` and `@actions/tool-cache` bumped.

4. **New features**: Worktree support for `persist-credentials includeIf`, orchestration_id in git user-agent, SHA-256 repository support.

5. **Impact on this repo**: Do any workflows use `pull_request_target` or `workflow_run` with fork checkout? If so, they'll need `allow-unsafe-pr-checkout: true` or refactoring. The security default is correct but may require workflow updates.

This is a security-first upgrade — the breaking change protects against supply-chain attacks via fork PRs!""",

    1175: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1175: Match batch CSV export examples to generated columns — Postman collection drift!

1. **The drift**: Merged PR #1141 changed `buildCsv()` to include every default field except optional `text` and `enrichmentData`, but the Postman response example at `CabrosBot.postman_collection.json:3887-3904` still shows only `id,receivedAt,source` (3 columns).

2. **Impact**: Operators using the Postman collection for manual verification see a CSV shape the endpoint doesn't produce — reduces collection value for contract-drift detection.

3. **Proposed fix**: Replace the default batch-export CSV example with a response generated from current default field selection, and add a contract test that keeps the example header aligned.

4. **Acceptance criteria**: Postman default CSV response header exactly matches `buildCsv()` when `includeText` and `includeEnrichment` are false; example includes representative values; contract test detects future divergence.

This is a great example of "documentation as code" — the Postman collection should be a living contract, not a stale snapshot!""",

    1174: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1174: Align batch alert ID schemas with nonblank runtime validation — OpenAPI contract mismatch!

1. **The gap**: Canonical OpenAPI schemas for batch replay, export, and delete (`src/openapi/openapi.json:2885-2892`, `2915-2922`, `2965-2971`) declare only `items.type: string`, but controllers at `alerts.js:849`, `1053`, `1115` reject empty/whitespace-only IDs via `!id.trim()` with HTTP 400.

2. **Impact**: OpenAPI validators and generated clients treat invalid batch requests as valid, then receive unexpected `400 INVALID_REQUEST` at runtime — weakens the contract used by operators and tooling.

3. **Proposed fix**: Encode the runtime nonblank constraint in the canonical OpenAPI schema (e.g., `minLength: 1`, `pattern: ^\\S+$`), and add contract tests for empty and whitespace-only values.

4. **Related**: From PR #1141 review discussions — this is a follow-up to ensure the contract matches runtime behavior.

OpenAPI as the source of truth means the schema must reflect *all* validation, not just types!""",
}

def main():
    print("Getting GitHub App token...")
    token = get_token()
    
    print("Posting engagement comments on NEW issues/PRs...")
    for issue_num, comment in COMMENTS.items():
        post_comment(token, issue_num, comment)
        time.sleep(2)  # Rate limit courtesy
    
    print("Done!")

if __name__ == "__main__":
    main()