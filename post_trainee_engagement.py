#!/usr/bin/env python3
"""Post Virgin Trainee engagement comments on recent PRs/issues without existing engagement."""

import sys
import time
sys.path.insert(0, 'trainee-tooling')

from github_app_client import GitHubAppClient, GitHubAppError

REPO = "francovp/cabros-bot"

# Engagement comments for PRs without existing trainee comments
PR_COMMENTS = {
    1223: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1223: Make calibration suppression test use its Gemini mock (GH-719) — test hygiene for the news monitor! 🧪

1. **Mock isolation**: The probe showed the pre-fix test had `gemini.analyzeNewsForSymbol` calls = 0 yet passed in 7ms. That's a classic "mock not actually used" gap. The `jest.resetModules()` + `doMock` before loading the route chain + `getCacheInstance().clear()` pattern is solid — it prevents singleton cache from serving warm entries that mask the provider call. Question: could this pattern be abstracted into a test helper (e.g., `withFreshModuleCache(() => import(...))`) for reuse across similar router tests?

2. **Mutation verification**: Lowering `NEWS_ALERT_THRESHOLD` to `0.1` against mocked confidence `0.45` proves the `toBeFalsy()` at `0.7` now discriminates on real behavior. This is exactly the kind of "prove the assertion bites" validation that catches vacuous passes. Any plans to add mutation testing (Stryker) to CI for critical paths like this?

3. **Calibration semantics**: "Calibration suppression" — does this mean the test verifies that when confidence is below threshold, the alert is suppressed (not sent), or that the calibration logic itself is bypassed? The name suggests the latter but the threshold mutation suggests the former. Clarifying in the test name or comment would help future readers.

4. **Full-suite confidence**: Green CI `build` (tests + Firebase emulator) on this PR is reassuring. Does the emulator suite exercise the news-monitor webhook end-to-end, or is that a separate integration test?

Test-first debugging with probe → mutate → isolate → verify is a textbook example of how to trust your test suite. Well done!""",

    1219: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1219: Cover explicit exchange precedence over crypto suffix (CB-128) — signal parsing precision! 🎯

1. **Precedence rule**: The test covers `EXCHANGE:SYMBOL` (explicit) vs `SYMBOLUSDT` (suffix heuristic). Is the rule "explicit exchange always wins" or "explicit exchange wins only when valid"? What happens if someone sends `INVALID:SYMBOLUSDT` — does it fall back to suffix heuristic or error?

2. **Exchange catalog**: What exchanges are recognized in the explicit format? `BINANCE`, `BYBIT`, `OKX`, `COINBASE`, `KRAKEN`, `KUCOIN`? Is there a centralized registry or a regex allowlist? The test should probably cover an unrecognized exchange to verify fallback behavior.

3. **Suffix ambiguity**: `SYMBOLUSDT` could be Binance, Bybit, OKX... The heuristic defaults to one (Binance?). Is that documented? Could there be a case where the user *means* Bybit but the suffix routes to Binance, causing data mismatch?

4. **CB-128 scope**: The issue mentions "explicit exchange precedence over crypto suffix" — are there other suffix heuristics (e.g., `SYMBOLUSDC`, `SYMBOLBUSD`, `SYMBOLPERP`) that follow the same precedence? The test matrix should cover the common stablecoin/perp suffixes.

5. **Error envelope**: If both explicit and suffix parsing fail, what's the error shape? Does it use the standardized error envelope from #1098 (`INVALID_REQUEST` with `details.field = "symbol"`)?

Explicit > heuristic is the right default — it makes user intent unambiguous. The test coverage on the boundary is exactly where bugs hide!""",

    1216: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1216: Add classifier.dev fallback for news-monitor — defense in depth for classification! 🛡️

1. **Trigger condition**: Fallback runs "only after Gemini returns `none` with a non-empty headline." What constitutes "non-empty"? `headline.trim().length > 0`? What about whitespace-only or very short headlines (< 10 chars)? The classifier might hallucinate on noise.

2. **Classifier contract**: You consume `results[0].label` + `confidence` — not `{classification, confidence, reasoning}`. Is this classifier.dev's native response shape, or an adapter? If classifier.dev changes their API, this breaks silently (fail-open to `none`). A response schema validation (Zod/JSON Schema) would catch drift early.

3. **Error handling**: "Any classifier HTTP error (5xx/429), timeout, network error, or invalid response fails open to `none`." This is correct for availability, but it means classifier failures are invisible. Should there be a `classifier.dev.error` metric/counter in `/api/status` so operators know the fallback is firing?

4. **Cost/SLA unknown**: "Classifier.dev cost/SLA is not documented in the contract." This is a risk — if classifier.dev becomes paid or rate-limited, the fallback could become a liability. Is there a circuit breaker or max-daily-calls guard?

5. **Gemini remains primary**: "No separate classifier to circuit-break ahead of this second pass." Makes sense — Gemini is the authority. But if Gemini is flaky (returns `none` frequently), classifier.dev becomes the de facto primary. Worth monitoring the `none` rate from Gemini.

6. **Per-alert telemetry**: `/api/status` reports the opt-in gate but not per-alert provider telemetry. Adding `classifierUsed: true/false` and `classifierLatencyMs` to the alert record would enable "how often does the fallback actually help?" analysis.

Fallback chains are great — observability on fallback activation is what makes them operable!""",

    1211: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1211: Replace JSON with visual controls in admin — UX over raw JSON! 🎨

1. **Component architecture**: `cabros-fields` and `cabros-result` are custom elements with self-hosted Vue 3 runtime — no UI kit. That's lightweight but means every form behavior (validation, conditional fields, dependent selects) is custom code. Is there a risk of "form framework" scope creep? The regression test for filter-driven auto-selection preserving edited payload is a good guard.

2. **Auth boundary**: "Authentication still uses existing Firebase ID-token/API-key checks and viewer/operator authorization. The `area/auth` tag is repository metadata, not evidence that these field components own auth." Good clarification — the components are presentation only, auth stays at the API layer. Does the Vue runtime need any auth context (e.g., `isOperator` for conditional field visibility)?

3. **JSON compatibility**: "This PR does not add an arbitrary JSON request editor or paste toggle, consistent with replacing JSON inputs with visual controls." This is a deliberate design choice — structured input only. But what about power users who want to paste a complex payload? Is there an "advanced mode" toggle planned, or is the visual form intended to cover all valid inputs?

4. **Playground state**: Operations use `playgroundInputCache` and `previousDefinition` pattern — no new global state library. The filter-driven auto-selection regression test covers preserving edited payload through filtering/switching. What about browser refresh or tab close? Is the cache persisted to localStorage/sessionStorage?

5. **Test coverage**: "Jest browser harness covers component interactions, and the repository has a local Playwright smoke script; there is no comprehensive CI end-to-end suite for the full workflow." The gap between unit (Jest) and smoke (Playwright) is where integration bugs live. Could a dedicated Playwright test for the admin order flow (select symbol → fill fields → submit → verify response) be added to CI?

6. **Hosting parity**: #1201 notes `public/admin/admin.js` drifted from `src/admin/admin.js`. This PR touches admin — does it update both source and built artifact, or is that a separate commit? The `build:hosting` step must stay in sync.

Visual controls > raw JSON for operator UX — but the "no arbitrary JSON" constraint means the form must be *complete* for all valid API inputs. That's a high bar!""",

    1209: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1209: Bump actions/setup-java from 4 to 6 — dependency hygiene for CI! ☕

1. **Breaking changes**: setup-java v6 requires Java 17+ as minimum (v4 supported Java 11). Does the project need Java at all? The `area/api`, `area/database`, `area/trading` labels on the automated evaluation seem broad for a Java setup action — is Java used by any build step (e.g., Kafka, Gradle, Android) or is this a transitive dependency of another action?

2. **Version pinning**: The bump is `from 4 to 6` — is this a major version pin in the workflow (e.g., `uses: actions/setup-java@v6`) or a version range? Pinning to major versions (`@v6`) is safer than `@v6.x.x` for supply chain, but means you opt into breaking changes on `v7`.

3. **Distribution**: setup-java v6 changed default distribution from `adopt` to `temurin`. Does the build need a specific distribution (Zulu, Corretto, Microsoft, Temurin)? Explicit `distribution: 'temurin'` in the workflow avoids surprises.

4. **Cache key**: If Java version/distribution changes, the cache key for `actions/cache` (if used for Maven/Gradle) should include the Java version to avoid stale cache hits.

5. **Automation readiness**: Score 45/100, `automation/skip` — "No special notes." The broad area labels suggest the automated evaluator couldn't narrow scope. A manual review of which workflows actually use `setup-java` would clarify impact.

Dependency bumps are low-glamour but high-leverage — catching a broken CI build before it blocks merges is the real win!""",

    1208: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1208: Bump actions/checkout from 4 to 7 — the gateway action for every workflow! 🚪

1. **Breaking changes**: checkout v7 drops Node 16 support (requires Node 20+). The runner images have Node 20+, so this should be fine. But v7 also changed the default `fetch-depth` behavior — v4 defaulted to 1 (shallow), v7 defaults to 0 (full history) unless specified. This can slow down workflows significantly for large repos. Is `fetch-depth: 1` explicitly set in affected workflows?

2. **Submodules**: v7 changed submodule behavior — `submodules: recursive` now fetches all submodules by default if `submodules: true`. Any workflows using submodules need review.

3. **Token permissions**: v7 requires `contents: read` permission explicitly for private repos. The `permissions` block in workflows should be audited.

4. **SSH vs HTTPS**: v7 improved SSH key handling for private submodules. If any workflow uses SSH URLs for submodules, this is a fix.

5. **Automation readiness**: Score 45/100, `automation/skip` — labels `area/observability`, `area/auth`, `area/database` are very broad. checkout is used by *all* workflows, so the evaluator correctly flags wide blast radius but can't pinpoint which workflows need attention.

Since checkout runs on every workflow run, even a 5s slowdown from full-history fetch compounds to hours of CI time per month. Explicit `fetch-depth: 1` where full history isn't needed is a quick win!""",

    1207: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1207: Bump actions/setup-node from 4 to 7 — Node toolchain update! 📦

1. **Node version policy**: setup-node v7 requires Node 20+ (v4 supported Node 16). The project uses Node 22 (per `engines` in package.json?), so this aligns. But does the workflow pin a specific Node version (`node-version: '22'`) or use a version file (`.nvmrc`, `.node-version`)? Explicit pinning in the workflow is more reproducible.

2. **Cache key**: v7 changed the default cache key format. If workflows use `cache: 'pnpm'` (or npm/yarn), the cache key now includes the Node version automatically. This is good — avoids Node 16 cache pollution on Node 22 runs. But verify the cache actually restores correctly.

3. **Registry**: v7 added `registry-url` input for custom registries. Not needed unless you use a private npm registry.

4. **Automation readiness**: Score 30/100, `automation/skip` — labels `area/auth`, `area/observability`. Again, setup-node is universal, so broad labels are expected. The low score suggests the evaluator sees risk but can't automate the fix.

5. **pnpm integration**: The project uses pnpm. setup-node v7's `cache: 'pnpm'` should work seamlessly. Any custom pnpm store path or `pnpm install --frozen-lockfile` flags in workflows should be preserved.

Node toolchain upgrades are "set and forget" if pinned correctly — the risk is implicit version resolution drifting across workflows!""",

    1206: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1206: Bump actions/cache from 4 to 6 — cache action modernization! 💾

1. **Backend changes**: cache v6 migrated from `tool-cache` (deprecated) to `actions/cache` v4 backend (S3-compatible). This is mostly transparent but can change cache hit/miss behavior for large artifacts.

2. **Key compression**: v6 introduced automatic key compression for long keys (> 512 chars). If any workflow constructs very long cache keys (e.g., hashing many file paths), this helps avoid "key too long" errors.

3. **Segment limits**: v6 enforces stricter segment limits (max 128 segments per key). Workflows with dynamically generated keys should be audited.

4. **Permission model**: v6 requires `actions: read` permission for cache access in some scenarios. Workflow `permissions` blocks may need updating.

5. **Automation readiness**: Score 45/100, `automation/skip` — labels `area/observability`, `area/auth`, `area/database`. Cache is universal, so broad impact is expected.

Cache action upgrades are usually safe but can cause mysterious "cache miss" spikes if key generation changes. A post-merge CI metrics check (cache hit rate) would catch regressions!""",

    1205: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1205: Bump pnpm/action-setup from 4 to 6 — pnpm installer update! 📦

1. **pnpm version**: action-setup v6 installs pnpm v9+ by default (v4 installed pnpm v8). Does the project need a specific pnpm version pinned in `package.json` (`packageManager` field) or `.npmrc`? The action respects `packageManager` but explicit `version: '9.x'` in the workflow step adds clarity.

2. **Node version coupling**: action-setup v6 requires setup-node to run first (for Node). The workflow order `setup-node` → `pnpm/action-setup` must be maintained. v6 is stricter about this.

3. **Store path**: v6 changed default store path behavior. If workflows customize `store-dir` or rely on global store location, verify it still works.

4. **Frozen lockfile**: `pnpm install --frozen-lockfile` is the standard CI command. Does the project use this? The action doesn't run install — it only sets up pnpm. The install step is separate.

5. **Automation readiness**: Score 40/100, `automation/skip` — label `area/database`. Odd label for a pnpm action — maybe the evaluator associated it with a workflow that touches database? Manual review needed.

pnpm 9+ brings performance improvements and better peer dependency handling — a net positive if the lockfile is compatible!""",
}

# Engagement comments for Issues without existing trainee comments
ISSUE_COMMENTS = {
    1222: """Hi @francovp! 🤖

Issue #1222: Standardize platform-agnostic deployment preflight with graceful fallback when render CLI is absent — ops hardening! 🚀

1. **Preflight scope**: What checks constitute the "deployment preflight"? Environment variable validation? Dependency health (DB, Redis, external APIs)? Schema migrations? Build artifact verification? A checklist in the issue would clarify the MVP.

2. **Platform-agnostic**: "Platform-agnostic" suggests this should work on Render, Railway, Fly.io, Kubernetes, bare metal... The abstraction layer needs to be thin — mostly checking "can the process start and reach its dependencies?" rather than platform-specific APIs.

3. **Render CLI fallback**: "Graceful fallback when render CLI is absent" — what does the fallback do? Skip Render-specific checks (service status, deploy hooks)? Use REST API directly? Shell out to `curl`? The fallback should have feature parity for critical checks.

4. **Failure modes**: What happens when preflight fails? Block deploy (CI gate)? Warn but allow? Alert on-call? The issue mentions "graceful fallback" but not the failure policy.

5. **Integration point**: Is this a standalone CLI (`bin/preflight`), a GitHub Action step, a Render Build Hook, or a pre-start script in the Dockerfile? Each has different tradeoffs for when it runs and what context it has.

6. **Observability**: Preflight results should be queryable (`/api/status` extension? deployment metadata in Firestore?) so operators can see "preflight passed at 2026-09-27T22:13:00Z with checks: env, db, redis" without digging logs.

Standardized preflight prevents "it works on my machine / in CI but not in prod" — the classic config drift killer!""",

    1221: """Hi @francovp! 🤖

Issue #1221: Support Node.js 26 runtime and add worktree node_modules setup helper — DX for parallel development! 🌳

1. **Node 26 support**: Node 26 is not yet released (as of 2026-09-27, Node 22 is current LTS, 23/24/25 are current/odd releases). Is this forward-looking for when 26 hits LTS (Oct 2027?), or is there a specific Node 26 feature needed (e.g., `node --experimental-strip-types`, new `test` runner features, V8 upgrades)?

2. **Worktree node_modules**: The helper should handle the "worktree node_modules dilemma":
   - **Shared**: Symlink `node_modules` from main worktree (saves space, but `pnpm install` in one worktree affects others)
   - **Isolated**: Each worktree runs `pnpm install` (clean isolation, but N× disk usage and install time)
   - **Hybrid**: pnpm's built-in worktree support (`pnpm install --workspace-root` + linked store) — this is the pnpm-native way.

3. **pnpm workspaces**: If the repo is a pnpm monorepo, worktrees need special handling — the lockfile is at the workspace root, and `pnpm install` in a worktree should reference the root lockfile. The helper should detect pnpm workspace and do the right thing.

4. **Git integration**: `git worktree add` creates the worktree. The helper could be a post-checkout hook or a wrapper script: `./scripts/worktree-setup.sh <branch>` that does `git worktree add`, then `pnpm install` with correct config.

5. **CI/CD**: Do CI pipelines need to test on Node 26? If so, the setup-node action matrix should include 26 (when available).

6. **Cleanup**: Worktree pruning (`git worktree prune`) and node_modules cleanup for deleted worktrees — the helper should have a `clean` subcommand.

Worktrees are a superpower for parallel PR reviews — investing in the setup DX pays off every time you `git worktree add`!""",

    1220: """Hi @francovp! 🤖

Issue #1220: Add zero-dependency agent skill validation suite to GitHub Actions workflow — CI for your skills! 🧪

1. **Validation scope**: What does "skill validation" cover?
   - SKILL.md frontmatter (name, description, version)?
   - Required files (scripts/, assets/, references/)?
   - Markdown linting (no broken links, valid code fences)?
   - Schema compliance (agentskills.io spec)?
   - Runtime smoke test (can the skill be loaded by OpenClaw)?

2. **Zero-dependency**: "Zero-dependency" means the validation runs without installing the full OpenClaw runtime? A Node.js script that parses SKILL.md and checks structure makes sense. Could use `ajv` for JSON schema validation of frontmatter.

3. **Workflow integration**: Where in CI? `pull_request` trigger on `skills/**`? `workflow_dispatch` for manual runs? `schedule` for nightly drift detection? The `area/ci` label suggests a reusable workflow other repos can call.

4. **Failure handling**: Validation failures should block PR merge (required status check). But false positives (style nits) are annoying — the suite should distinguish `error` (invalid skill) from `warn` (style suggestion).

5. **Skill registry**: Is there a central skill registry (ClawdHub, local index) that the validation syncs with? Or is it purely local filesystem scanning?

6. **Extensibility**: Other teams might want custom validators (e.g., "all skills must have a test script"). The suite should support plugin/hook architecture.

Validating skills in CI prevents "skill works on my machine but not in production" — and dogfooding your own skill framework is the best test!""",

    1218: """Hi @francovp! 🤖

Issue #1218: Add ordered validation and review gates to issue-automator — automation with guardrails! 🤖

1. **Gate ordering**: "Ordered validation and review gates" — what's the sequence? 
   1. Schema validation (issue has required fields)?
   2. Label validation (required labels present)?
   3. Assignment validation (owner assigned)?
   4. Policy checks (size label matches diff scope)?
   5. Review requirement (human approval before automation proceeds)?
   The order matters — fast/fail-fast checks first, expensive/human checks last.

2. **Review gate semantics**: "Review gates" — does this mean the automator pauses and waits for a human `/approve` comment? Or does it check for existing approvals (GitHub reviews, specific label)? The `area/automation` label suggests this drives automated actions (labeling, assignment, closing).

3. **Failure modes**: If a gate fails, what happens? Issue stays open with `needs-review` label? Comment posted with checklist? Automator exits with error (visible in Actions)? The feedback loop must be visible to the author.

4. **Bypass/override**: Are there cases where gates should be bypassed (hotfix, admin override)? A `bypass-gates` label or `@gigachad-senior-dev` comment trigger?

5. **Integration with existing automator**: The issue-automator-global skill handles triage. Does this issue extend it, or is it a new workflow? The `skill: issue-automator-global` in the repo suggests the skill is installed — the gates should be added as steps in that skill's workflow.

6. **Observability**: Gate results should be queryable — "show me issues stuck at gate 3" — for process metrics.

Ordered gates turn "automation runs wild" into "automation with accountability" — the maturity step every bot needs!""",

    1213: """Hi @francovp! 🤖

Issue #1213: Add opt-in classifier.dev fallback for news-monitor — classifier redundancy! 🔄

1. **Opt-in mechanism**: "Opt-in" suggests an environment variable (`ENABLE_CLASSIFIER_DEV_FALLBACK=true`) or Remote Config flag. Is it per-environment (prod only) or global? The PR #1216 (classifier.dev fallback) seems to implement this — is the issue the tracking ticket and PR the implementation?

2. **Fallback trigger**: Same as PR #1216 — "only after Gemini returns `none` with a non-empty headline." The classifier is a second opinion, not a replacement. Good.

3. **Classifier.dev reliability**: Since classifier.dev is external, what's the fallback *for the fallback*? If both Gemini and classifier.dev fail/return `none`, the alert gets no classification. Is "unclassified" an acceptable state, or should there be a default class (e.g., `news.general`)?

4. **Cost tracking**: Classifier.dev API calls cost money (or have rate limits). Is there a budget/counter in the FinOps tracker (#1189)? `classifierDevCallsToday` metric would prevent surprise bills.

5. **A/B evaluation**: With the fallback opt-in, can you run shadow mode (call classifier.dev but don't use result, just log agreement/disagreement with Gemini)? This validates the fallback quality before enabling.

6. **Observability**: `/api/status` should expose `classifierDevFallbackEnabled`, `classifierDevCalls24h`, `classifierDevAgreementRate` (when shadow mode runs).

Opt-in fallbacks let you validate in production without risk — the feature flag pattern applied to ML classifiers!""",

    1203: """Hi @francovp! 🤖

Issue #1203: Full-suite Jest failures are order-dependent — three different suites fail across runs while passing in isolation! 🧪

1. **Failure pattern**: "Three different suites fail across runs" — this is the hallmark of shared mutable state leaking between tests. Common culprits:
   - Global singletons (caches, config, DB connections) not reset in `afterEach`/`afterAll`
   - Module cache pollution (`require`/`import` caches mutated state)
   - Async operations (timers, promises, event emitters) not awaited/cleaned up
   - Environment variable mutations not restored
   - File system / temp directory leftovers

2. **Reproduction**: Can you run `pnpm test -- --runInBand` (serial execution) to confirm order-dependence? If serial passes but parallel fails, it's cross-test pollution. If serial *also* fails non-deterministically, it's flakiness (timing, network, randomness).

3. **Suspect modules**: The issue mentions "three different suites" — which ones? If they share a common dependency (e.g., all use `FirestoreService`, `TradingViewMCPClient`, `NotificationService`), that's the leak source.

4. **Jest config**: Does `jest.config.js` have `testEnvironment: 'node'`, `forceExit: true`, `detectOpenHandles: true`? These help surface leaks. `setupFilesAfterEnv` with a global cleanup hook (clear singletons, timers, mocks) is essential.

5. **Isolation tools**: `jest.resetModules()` in `beforeEach` for modules with singleton state. `jest.useFakeTimers()` for timer-dependent tests. `--runInBand` for debugging but not for CI (too slow).

6. **Bisect strategy**: `git bisect` on the test suite (run tests at each commit) to find the commit that introduced the leak. Or binary search on test files: run half the suite, see if failure reproduces.

Order-dependent failures are the "memory leaks" of test suites — they compound silently until the suite becomes unreliable. Fixing the isolation pattern (global cleanup, no shared mutable state) prevents recurrence!""",

    1201: """Hi @francovp! 🤖

Issue #1201: `public/admin/admin.js` has drifted from `src/admin/admin.js` — silent revert of SSE fixes on deploy! 🔄

1. **Drift mechanism**: The test `tests/unit/firebase-hosting-config.test.js` imports `scripts/build-hosting.js` and calls `buildHosting()`, which blindly copies `src/admin/*` → `public/admin/*`. Any `pnpm test` run executes this copy, silently overwriting fixes in `public/admin/admin.js` that don't exist in source. This is a **test mutating the working tree** — a cardinal sin in CI.

2. **Divergence details**: Two divergent copies exist:
   - `public/admin/admin.js`: has `handshakeTimeoutMs`/`handshakeTimer` SSE guard (7 occurrences)
   - `src/admin/admin.js`: lacks it entirely
   Regenerating from source deletes the fix. The `MM` status (staged ≠ unstaged) is the git signature of this drift.

3. **Root cause**: The build script is a one-way copy (`src` → `public`) with no verification. The test asserts the copy happened, not that `src` and `public` are *semantically equivalent*.

4. **Fix strategies** (from LRN-20260927-001):
   - Make test **not mutate working tree** — assert against temp output dir or restore files after asserting
   - Add post-copy verification in `build:hosting` to fail loudly when `src` and `public` diverge on content it didn't write
   - Consider making `public/admin/*` generated-and-gitignored; serve artifact built in CI
   - Same risk applies to `CabrosBot.postman_collection.json` and its test

5. **Immediate action**: The SSE guard fix in `public` needs to be backported to `src` *before* the next test run, or it will be lost again. Is there a PR open for this?

6. **Process**: `pnpm run build:hosting` (or `node scripts/build-hosting.js`) must be run and committed *atomically* with source changes. The CI should verify `git diff --exit-code` after build to catch drift.

This is a classic "generated file checked into git but build not enforced in CI" trap. The fix is making the build *verifiable* and *non-mutating* in tests!""",

    1200: """Hi @francovp! 🤖

Issue #1200: Crypto `/precio` truncates prices to whole dollars while equity keeps cents — precision inconsistency! 💰

1. **Formatting divergence**: Crypto prices (Binance) lose cents; equity prices (Twelve Data) keep them. Both go through `fetchPriceCryptoSymbol.js` — where does the formatting diverge? 
   - Binance returns `price` as string with 8 decimals (e.g., `"43250.12345678"`)
   - Twelve Data returns `close` with 2-4 decimals
   - The reply formatter likely applies different `round10` / `toFixed` logic per asset class

2. **User impact**: For BTC at $43,250.12, showing "$43,250" loses $0.12 — trivial for BTC but significant for low-value tokens (e.g., SHIB at $0.00001234 → "$0"). Equity at $150.25 shows correctly.

3. **Root cause candidates**:
   - `fetchPriceCryptoSymbol.js` applies `Math.round()` or `toFixed(0)` for crypto
   - Equity path uses `round10(price, -2)` (cents) or similar
   - The "bounded Binance 24h ticker context" for crypto might use a different formatter than the bare-price fallback

4. **Consistency policy**: Should crypto show 2 decimals (cents), 4 decimals (basis points), or full precision? The answer depends on the asset — BTC/ETH: 2 decimals; altcoins: 4-8; stablecoins: 4-6. A dynamic precision based on price magnitude (`price < 1 ? 8 : price < 100 ? 4 : 2`) is common.

5. **Telegram formatting**: `parse_mode: 'MarkdownV2'` — prices in code blocks (`` `price` ``) or bold? The formatting shouldn't affect precision.

6. **Test coverage**: Are there tests asserting crypto price format? The truncation might be an untested code path.

Precision consistency across asset classes is table stakes for a price bot — users notice when "it works for stocks but not crypto"!""",

    1199: """Hi @francovp! 🤖

Issue #1199: Outcome evaluation counts the partially-elapsed entry candle, inflating MFE/MAE and forging target/stop hits — metric integrity! 📊

1. **The bug**: "Partially-elapsed entry candle" — if a signal triggers at 14:32 on a 1H candle (14:00-15:00), the evaluation includes the 14:00-14:32 period *before the signal existed*. This inflates:
   - **MFE** (Max Favorable Excursion): pre-signal favorable move counts as "trade would have captured this"
   - **MAE** (Max Adverse Excursion): pre-signal adverse move counts as "trade would have survived this"
   - **Target/Stop hits**: Pre-signal price touching target/stop levels registers as a hit

2. **Entry timestamp precision**: Signals should have an exact entry timestamp (not just "candle open"). The evaluation window must start at `entryTimestamp`, not `candleOpenTimestamp`.

3. **Candle granularity**: If signals are on 1H candles but entry can be intra-candle (webhook arrives at 14:32), the evaluation must use sub-candle data (1m, 5m) or at minimum exclude the pre-entry portion of the entry candle.

4. **Data source**: Does the evaluator have access to sub-candle data (Binance klines 1m, Twelve Data 1min)? If only 1H candles are stored, the fix requires either:
   - Fetching finer granularity at evaluation time
   - Approximating: assume linear interpolation within the entry candle (imperfect but better than including pre-entry)

5. **Backfill impact**: Historical outcomes computed with this bug are inflated. Is there a re-evaluation job (`SignalOutcomeWorker`) that can recompute? The `area/database` label suggests schema migration may be needed.

6. **Metrics exposure**: `/api/outcomes/summary` should flag "pre-candle-entry-bias: true" for affected records so consumers know the data quality.

This is a silent accuracy killer — the dashboard looks great (high MFE, many target hits) but the strategy would lose money in live trading. Fixing the evaluation window is foundational for trust in the signal quality metrics!""",

    1198: """Hi @francovp! 🤖

Issue #1198: News-monitor pause is process-local, so it never pauses the scheduler running in the Render worker — distributed state gap! ⏸️

1. **Architecture**: News-monitor runs in two processes:
   - **Web/API process**: Receives `/api/news-monitor/pause` (or similar), sets in-memory flag
   - **Render worker process**: Runs the actual scheduler (cron/BullMQ), checks the flag — but it's a *different process*, so it sees the default (unpaused)

2. **State synchronization**: The pause state needs a shared backend:
   - **Firestore**: `settings/newsMonitor.paused` document — both processes read/write
   - **Redis**: `news-monitor:paused` key with TTL — fast, supports pub/sub for instant propagation
   - **Env var / Remote Config**: Too slow for runtime toggle

3. **Current implementation**: Where is the pause flag stored now? In-memory variable in the web process? The worker doesn't have access to it.

4. **Propagation latency**: If using Firestore, the worker polls every N seconds (or uses `onSnapshot` listener). What's the acceptable delay between "admin clicks pause" and "worker stops scheduling"? Seconds? Minutes?

5. **Resume behavior**: When unpaused, does the worker run missed cycles immediately (catch-up) or resume at next scheduled interval? Catch-up could flood the news API; resume-at-next is safer.

6. **Admin UI**: The admin console should show "Pause status: Active (worker synced 30s ago)" — operators need confidence the pause *worked*.

7. **Related**: #1177 (news monitor never runs) — if the scheduler is in the worker and the pause flag is in the web process, the worker might be running but the web process thinks it's paused (or vice versa).

Distributed state is the hardest part of scaling from "one process" to "web + worker" — shared storage + explicit sync is the only reliable pattern!""",

    1197: """Hi @francovp! 🤖

Issue #1197: Scanner ranking treats missing indicator data as RSI 0 and awards squeeze bonus to absent BBW — data quality bias! 📈

1. **RSI 0 default**: Missing RSI → treated as 0 → "oversold" → high rank. But RSI 0 is a valid extreme value (strongly oversold). The scanner can't distinguish "RSI is 0" from "RSI not computed". This systematically over-ranks symbols with missing data.

2. **BBW squeeze bonus**: Missing Bollinger Band Width → treated as 0 → "squeeze" (BBW near 0 = bands contracted) → bonus. But BBW 0 is also a valid extreme (price flatlined). Same problem: missing data masquerades as a bullish signal.

3. **Root cause**: The ranking algorithm uses `indicatorValue ?? 0` or `indicatorValue || 0` instead of explicit `null`/`undefined` checks. JavaScript's falsy coercion conflates "missing" with "zero."

4. **Fix strategies**:
   - **Explicit null checks**: `if (rsi === null || rsi === undefined) { skipSymbol(); }` — exclude symbols with missing required indicators
   - **Partial scoring**: Compute score with available indicators, penalize missing ones (e.g., `-10` per missing required indicator)
   - **Data quality gate**: Pre-filter scanner universe to symbols with complete indicator coverage (from the indicator computation pipeline)

5. **Indicator pipeline**: Where are indicators computed? TradingView MCP? Local TA library? If MCP, does it return `null` for uncomputable indicators, or omit the field? The contract matters.

6. **Observability**: `/api/scanner-presets/{id}/run` response should include `dataQuality: { symbolsWithFullData: 42, symbolsMissingRSI: 3, symbolsMissingBBW: 5 }` so operators see the bias magnitude.

7. **Test case**: A test with a symbol that has all indicators *except* RSI should verify it's excluded or penalized, not ranked as "oversold."

Treating missing data as extreme signal is a classic quant bug — it creates a "phantom alpha" from data gaps. Explicit null handling is the fix!""",
}

def main():
    print("Initializing GitHub App client...")
    client = GitHubAppClient()
    
    print(f"\n=== Posting engagement comments on {len(PR_COMMENTS)} PRs ===")
    for issue_num, comment in PR_COMMENTS.items():
        print(f"Posting to PR #{issue_num}...")
        try:
            result = client.post_comment(REPO, issue_num, comment)
            print(f"  ✅ Success: {result.get('html_url')}")
        except GitHubAppError as e:
            print(f"  ❌ Failed: {e}")
        time.sleep(2)  # Rate limit courtesy
    
    print(f"\n=== Posting engagement comments on {len(ISSUE_COMMENTS)} Issues ===")
    for issue_num, comment in ISSUE_COMMENTS.items():
        print(f"Posting to Issue #{issue_num}...")
        try:
            result = client.post_comment(REPO, issue_num, comment)
            print(f"  ✅ Success: {result.get('html_url')}")
        except GitHubAppError as e:
            print(f"  ❌ Failed: {e}")
        time.sleep(2)  # Rate limit courtesy
    
    print("\nDone!")

if __name__ == "__main__":
    main()