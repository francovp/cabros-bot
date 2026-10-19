## [LRN-20261010-001] correction

**Logged**: 2026-10-10T21:50:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Reject invalid `dryRun` values with HTTP 400 instead of coercing to defaults.

### Details
In Issue #1153, @francovp clarified that coercing invalid or unrecognized `dryRun` values to a default (like `true` or `false`) is incorrect because it hides client bugs and breaks the strict OpenAPI boolean contract. Specifically, coercing to `false` was a prior bug that led to unintended live deliveries. The correct approach is explicit fail-closed validation at the request boundary using `isRecognisedDryRunValue` from `src/lib/dryRunRequest.js`, returning a `400 Bad Request` with code `INVALID_REQUEST`.

### Suggested Action
Always implement strict validation for boolean flags that control safety-critical behavior (like dry-runs) and reject invalid inputs rather than assuming a default.

### Metadata
- Source: user_feedback
- Related Files: src/lib/dryRunRequest.js
- Tags: validation, safety, api-contract
- See Also: none
- Pattern-Key: harden.input_validation

---

## [LRN-20261010-002] best_practice

**Logged**: 2026-10-10T21:52:00Z
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Define failure modes first, then layer resilience patterns (retries, timeouts, circuit-breakers).

### Details
In Issue #1109, @gigachad-senior-dev provided senior-level guidance on operational thinking: prioritize defining how a system can fail before implementing recovery mechanisms. Additionally, emphasize the use of structured logs and correlation IDs over simple printf debugging for better observability.

### Suggested Action
When designing new integrations or features, start the design doc/discussion with a "Failure Modes" section before detailing the "Happy Path" or "Resilience" strategies.

### Metadata
- Source: user_feedback
- Related Files: none
- Tags: sre, observability, resilience
- See Also: none
- Pattern-Key: simplify.operational-thinking

---

## [LRN-20261012-001] correction

**Logged**: 2026-10-12T00:18:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
"Environment-only" gate classifications must be verified empirically — they are testable claims, not documentation axioms.

### Details
In Issue #721, @francovp discovered that four Firestore storage feature flags (classified as "environment-only" because "they are process-startup gates that decide where a collection lives") were actually re-evaluated on every call via `getFirestore()` / `isFirestoreEnabled()`. A gate re-read per call is not a startup gate, so they are remotely toggleable. The classification was documenting an assumption nobody had verified.

Two consequences emerged when making them remote:
1. A published `false` must beat a `true` in `render.yaml` — `env || remote` gets this wrong; it needs `remote ?? env`.
2. `getRuntimeConfig()` cannot distinguish "Remote Config said false" from "environment says false" — it returns a value for every schema key. Using it made `ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE` (deprecated alias) unreachable.

Also, a template `defaultValue` is not a default — the Admin SDK reports unmatched parameters with source `'remote'`, so shipping `false` would silently disable storage modes in production. `useInAppDefault: true` is the correct encoding for "no published value".

### Suggested Action
On any "this is environment-only" annotation in this repo: verify the claim with a grep of the gate functions. The claim is testable, and it was wrong here.

### Metadata
- Source: user_feedback
- Related Files: firebase-remote-config-template.json, src/services/storage/
- Tags: remote-config, feature-flags, verification
- See Also: Issue #721, PR #1367
- Pattern-Key: harden.config-verification
---

## [LRN-20261017-001] correction

**Logged**: 2026-10-17T18:14:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Address PR feedback: fix merge commit blocker, dryRun query handling, and doc nits.

### Details
From QA feedback on PR #1379 by @francovp:
- **Blocker**: Branch contains merge commit while master requires linear history (non_fast_forward + required_linear_history ruleset). Must rebase or squash.
- **Should-fix**: Unrecognized `dryRun` query values (like `?dryRun=yes`) incorrectly take live delivery path instead of returning 400. Body validation works correctly.
- **Doc nits**: 
  1. OpenAPI promises `code: 'INVALID_REQUEST'` but handler doesn't emit it
  2. Request-body dryRun description has garbled prose: "Takes precedence over nothing..." should be "dryValidate wins"

### Suggested Action
1. Rebase PR to eliminate merge commit (`git rebase origin/master` or squash commits)
2. Fix dryRun validation to check both `req.body` and `req.query` for boolean values
3. Update error handling to include `code: 'INVALID_REQUEST'` in dryRun validation responses
4. Correct the request-body dryRun description in OpenAPI/docs

### Metadata
- Source: user_feedback
- Related Files: PR #1379, src/lib/dryRunRequest.js, src/controllers/webhooks/handlers/message/message.js, docs/webhooks.md
- Tags: validation, api-contract, git-workflow, documentation
- See Also: PR #1379 QA feedback
- Pattern-Key: harden.pr_quality

[LRN-1792261874-1] correction: ## 🔍 QA report: ✅ Passed
## 🔍 QA report: ✅ Passed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 4 · **Author:** Grace

The round-4 blocker is genuinely fixed: the global white-space:nowrap on .data-table th is gone and nowrap is now scoped to .table-scroll .data-table th, which I verified by serving origin/master's admin.css into the identical page — the Outcomes 320px overflow drops from 523px (with nowrap) to 26px, below master's own 43px, and every other view is 0px at 1440/1024/768/375/320. The Postman examples now carry success:true and a new test guards that every saved example contains the fields its schema marks required, and I confirmed the corrected OpenAPI NewsAnalysis* schemas match the service's real payload. All three nice-to-haves landed, and I re-verified every acceptance criterion in a real browser against the live pause/resume endpoints (POST then GET status in the server log; the card shows the re-read, not the echo). pnpm test is green on a second run (252/252, 5646/5646); the one failure in my first run is the same pre-existing flake class, reproduced on a pristine master checkout in a different untouched file, and lint is identical to master with 0 problems in touched files. Four non-blocking nits are listed below.

| | Check | Details |
|---|---|---|
| ✅ | BLOCKER fix: global white-space:nowrap removed from .data-table th and scoped to .table-scroll .data-table th | src/admin/admin.css: the global rule no longer carries nowrap; line 182 adds `.table-scroll .data-table th { white-space: nowrap; }`, lines 168-181 document why, and `.table-scroll` gained `min-width: 0` (line 276). In the browser, computed white-space on the Outcomes 'Performance by window' headers is `normal`, and the News monitor's wrapped-table headers are the only ones still nowrap. |
| ✅ | BLOCKER fix: page-level horizontal overflow on pre-existing bare tables, measured against master on the same DOM | A/B by route-fulfilling /admin/admin.css with `git show origin/master:src/admin/admin.css` into the same page. Outcomes 'Performance by window' (9 columns, rendered): PR 0px at 375 / 26px at 320; master 0px at 375 / 43px at 320; the round-4 nowrap build measured 468px / 523px. Alerts (Sentiment calibration Band/Count, Delivery by channel, Risk metadata coverage), Outcomes Calibration buckets (Confidence Range/Alerts/Avg Return (1h)/Avg Return (4h)/Target Hit Rate) and News monitor (3 tables + 4 charts) are all 0px at 1440/1024/768/375/320. The residual 26px at 320px is pre-existing on master and reduced by this PR. |
| ✅ | Regression guard for the CSS invariant | tests/unit/admin-charts.test.js adds two source-level tests: the global `.data-table th` rule must not match white-space:nowrap, the scoped `.table-scroll .data-table th` rule must, and `.table-scroll` must keep min-width:0 plus overflow:auto. Source-level rather than a rendered scrollWidth assertion (the vm harness has no layout engine), so I verified the rendered widths myself at five viewports. |
| ✅ | SECONDARY fix: success:true in both Postman 200 examples | CabrosBot.postman_collection.json: 'GET News Monitor Summary' and 'GET News Monitor Analyses' 200 bodies both begin with "success": true. tests/unit/postman-collection.test.js gains a guard asserting each saved example contains every field NewsAnalysisSummary/NewsAnalysisList marks required and that success is true, so the drift cannot return. |
| ✅ | OpenAPI NewsAnalysis* schemas match the runtime payload | Cross-checked against NewsAnalysisStorageService: formatAnalysisDoc returns createdAt (not analyzedAt), tokens as number\|null, promptVersion/expiresAt nullable; getSummary returns window/totalAnalyses/totalAlertsSent/bySymbol[x].{totalAnalyses,alertsSent,averageConfidence}/byEventCategory[x].{total,alertsSent,averageConfidence}/falsePositiveProxy with NO top-level alertRatePercent; listAnalyses returns only {analyses, nextCursor}. Required lists and property names in openapi.json now agree, and the controller prepends success:true on both 200 paths. |
| ✅ | Nice-to-have (a): afterEach router-stack pop in the new integration test | tests/integration/news-monitor-analyses-endpoint.test.js:37-45 restores process.env, resets the Firestore client and pops app._router.stack, with a comment explaining route accumulation across suites. Same pattern as symbol-analyses-endpoint.test.js. |
| ✅ | Nice-to-have (b): stale charts/tables cleared when a summary read fails | admin-newsmonitor.js loadSummary failure path replaces the KPI grid with 'Delivery analytics unavailable.' and all three breakdown sections with 'Breakdown unavailable — reload to refresh.'. Verified in the browser with a 503 response: no stale chart or table remained beside the error. |
| ✅ | Nice-to-have (c): src/admin/index.html indentation | The three untouched nav lines are back to 8-space indentation; `grep -n ' $' src/admin/index.html` finds no trailing whitespace. The only `git diff --check` finding in the whole diff is 'new blank line at EOF' in AGENTS.md. |
| ✅ | Status card: paused reads as a warning | Against the live GET /api/news-monitor/status: running renders a green RUNNING badge with 'Running normally'; pausing renders className 'dashboard-section banner-error', badge 'status-badge status-danger' reading PAUSED, title 'No news alerts are being produced', plus Paused at (relative timestamp) and Reason rows. Screenshot captured. |
| ✅ | Unread state never reads as running | After 'Clear key' and a fresh load of ?view=newsMonitor, the card renders 'Unavailable' / status-misconfigured with 'The pause state could not be read, so it is unknown rather than running.' Network log shows only /openapi.json and no /api/* request before authentication. |
| ✅ | Kill switch: confirm, then re-read status (both mutations) | Local server request log with LOG_LEVEL=info: POST /api/news-monitor/pause 200 followed by GET /api/news-monitor/status 200, then POST /api/news-monitor/resume 200 followed by GET /api/news-monitor/status 200. A confirm dialog fired for both. To prove the card shows the re-read rather than the pause echo, I paused from the console with reason 'QA console pause reason', then changed the reason server-side via curl, then pressed Refresh: the card rendered 'SERVER-SIDE reason changed after console pause'. |
| ✅ | No outbound message from preview or test | ENABLE_TELEGRAM_BOT, ENABLE_WHATSAPP_ALERTS and ENABLE_DISCORD_ALERTS were all false and TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID empty for the entire session. Only /api/news-monitor/{status,pause,resume,summary,analyses}, /api/status, /healthcheck and /admin were requested; no delivery endpoint was called. Nothing was delivered. |
| ✅ | Summary KPI mapping and derived alert rate | Payload totalAnalyses=128/totalAlertsSent=17 renders Analyses 128, Alerts sent 17, Alert rate 13.28% with meta '13.28% of analyses became alerts (17 of 128)', False-positive proxy 35.29% with '6 of 17 delivered alerts had no follow-up within 24h'. Breakdown tables derive per-row rates from the fields that exist: BTCUSDT 9/64=14.06%, ETHUSDT 8/64=12.5%, none 0/96=0%, price_surge 12/21=57.14%, price_decline 5/11=45.45%; rows sort by volume desc. |
| ✅ | Charts: barChart + sparkline with aria-label and reachable data table | Four svg[role=img] on the view, all with aria-labels stating the finding: 'Analyses by symbol. 2 points, high 64, low 64, latest 64.', 'Analyses by event category. 3 points, high 96, low 11, latest 11.', 'Analyses by symbol. 2 categories, high 64 at BTCUSDT, low 64 at BTCUSDT.', 'Analyses by event category. 3 categories, high 96 at none, low 11 at price_decline.' Bar values are non-zero (64/64 and 96/21/11). Sparklines appear only with >=2 points and each carries a POINT/VALUE table; bar charts expose a 'Show data' disclosure. The 12 unlabeled SVGs are the nav icons and all carry aria-hidden=true. |
| ✅ | Zero alerts over a populated window vs an empty window | 120 analyses / 0 alerts renders 'Alert rate 0%' with meta '0% of analyses became alerts (0 of 120)'. 0 analyses / 0 alerts renders an em dash with 'No analyses recorded in this window' and 'No delivered alerts at or above the threshold were evaluated'. The two are never confused, and breakdown/analyses empty states read 'No analyses recorded in this window.', 'No event categories recorded in this window.' and 'No recorded analyses match these filters.' |
| ✅ | NEWS_MONITOR_PAUSED renders as a named action | With a 503 {code:'NEWS_MONITOR_PAUSED', reason:'Gemini quota exhausted for the day', pausedAt:...}, the view replaces the generic error block with 'The news monitor is paused — resume to continue.', the explanation sentence, 'Recorded reason: Gemini quota exhausted for the day' and 'Paused at 15 h ago'. Screenshot captured. |
| ✅ | Analyses cursor paging and filter invalidation | Load analyses requests no cursor; Next page requests ...&before=8a2d5c1f0b3e4d7a8c5b9e4f6d2a1b07 and renders SOLUSDT instead of repeating page 1. After paging, Next is disabled and Previous enabled; typing in Symbol disables both and sets 'Filters changed — load analyses to refresh.' The deep link carries newsMonitor.summary.from/to/threshold and newsMonitor.analyses.from/to/limit/symbol. |
| ✅ | Column correctness against the real payload | 'Analyzed' renders from createdAt as a relative timestamp (7 h ago), not an em dash; 'Event category' renders the labels price_surge and none rather than blanking them; 'Confidence'/'Sentiment' use the 0-1 formatter (0.88/0.82); the false-positive Threshold renders 0.70, not 0.7%. |
| ✅ | adminWrite/admin.operator role not bypassed | The view uses sendRequest for every call and passes requiredRole 'admin.operator' for pause/resume and 'admin.viewer' for the three reads, matching x-admin-role in openapi.json for all five operations and the adminRead/adminWrite route middleware in src/routes/index.js:132-138. canPerformMutation() is checked before either mutation. No private auth or error path was added. |
| ✅ | Contract surfaces agree: four-surface parity | No new endpoint, request, environment variable, feature flag or Remote Config key. The corrected schemas, the controller response, the console and the Postman examples all agree. tests/unit/postman-collection.test.js, tests/unit/openapi-contract.test.js and tests/unit/admin-hosting-parity.test.js all pass. |
| ✅ | src/admin is source, public/admin is output, committed in sync | SHA-256 of all 9 files (admin.js, admin.css, index.html, admin-charts.js, admin-request.js, admin-components.js, admin-diagnostics.js, admin-newsmonitor.js, vue.runtime.global.prod.js) match between src/admin and public/admin, and public/admin has no file without a source. |
| ✅ | CSP, no inline script/CDN, no innerHTML | Response header is script-src 'self' https://www.gstatic.com with script-src-attr 'none'; the new asset is an external <script src="/admin/admin-newsmonitor.js" defer>. admin-newsmonitor.js contains no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, Function or remote URL. The only console errors in the whole session were the pre-existing /favicon.ico 404 and ERR_CONNECTION_REFUSED after I stopped the server. |
| ✅ | Accessibility of the new view | Both new wide tables sit in .table-scroll with role=region, tabindex=0 and an aria-label. All inputs are wrapped in a <label> (Pause reason (optional), From, To, Alert threshold, Limit, Symbol, Event category). #view-status carries aria-live=polite. The new view adds no sortable column, so no aria-sort is required. |
| ✅ | API error contract on the affected endpoints | Live: 401 {"error":"Unauthorized: Missing API key"} without a key; 400 INVALID_REQUEST for limit=999, limit=0, from=not-a-date and to=nope (with ENABLE_FIRESTORE_NEWS_ANALYSIS=true); 403 FEATURE_DISABLED with the flag off; 503 STORAGE_UNAVAILABLE when enabled without Firestore. success:true appears only on the 200 path. Rate limiting untouched. |
| ✅ | Test suite green, and the one flake attributed | First pnpm test run: 251 passed / 1 failed - tests/integration/news-monitor-cache.test.js 'should reuse cached no-event analyses without calling providers again' with 'socket hang up', in a file this PR does not touch; it passes 34/34 in isolation and in combination with the news-monitor suites (61/61). Second full run: 252/252 suites, 5646/5646 tests. A pristine origin/master copy failed a different untouched test (tests/integration/rate-limiter-webhook.test.js, expected 204 got 404), confirming the flake class is pre-existing. |
| ✅ | Lint matches the master baseline | pnpm lint reports 1245 problems (1231 errors, 14 warnings) on the branch and exactly 1245 (1231/14) on a pristine origin/master copy. Targeted eslint over all 7 touched source and test files reports 0 problems. The branch therefore adds zero lint findings; the earlier 1229 figure was simply an older master. |
| ✅ | Clean worktree after tests | git status --porcelain is empty after two full pnpm test runs and a lint run. No test wrote into src/admin or public/admin. |
| ✅ | Mergeability, checks, threads, attribution label | PR 1356 reports mergeable=MERGEABLE and mergeStateStatus=CLEAN; all 8 status checks are SUCCESS (Analyze js/py, CodeQL, build, build_and_preview_or_deploy, Deploy Preview, gitleaks); 0 review threads; attribution label grace-space-bunny-free is present. The branch does contain two merge commits, but the repository ruleset allows only squash/rebase with required_linear_history, so they do not block a linear master. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `pnpm test` | run 1: 251 passed / 1 failed (news-monitor-cache.test.js, 'socket hang up'); run 2: 252 passed, 5646 passed / 0 failed |
| `pnpm test -- tests/integration/news-monitor-cache.test.js` | 1 passed, 34 passed / 0 failed |
| `pnpm test -- tests/integration/news-monitor-cache.test.js tests/integration/news-monitor-analyses-endpoint.test.js tests/integration/news-monitor-basic.test.js` | 3 passed, 61 passed / 0 failed |
| `pnpm lint` | 1245 problems (1231 errors, 14 warnings) - identical to the pristine origin/master baseline |
| `npx eslint src/admin/admin-newsmonitor.js src/admin/admin.js src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js tests/unit/admin-client.test.js tests/unit/admin-charts.test.js tests/integration/news-monitor-analyses-endpoint.test.js` | 0 errors, 0 warnings (only an .html 'no matching configuration' notice) |
| `npx jest --detectOpenHandles (in /tmp/pr1356-master, a git archive of origin/master with symlinked node_modules)` | 250 passed / 1 failed (rate-limiter-webhook.test.js: expected 204, received 404) - proves the single-test flake is pre-existing |
| `git diff --check origin/master...HEAD` | 1 finding: 'new blank line at EOF' in AGENTS.md (no whitespace errors) |
| `git status --porcelain` | empty (clean) after all test and lint runs |
| `sha256sum comparison of src/admin/* vs public/admin/* (9 files) plus comm of the two listings` | all 9 MATCH; no file in public/admin without a source |
| `curl -s -D - -o /dev/null http://localhost:5391/admin` | 200 with script-src 'self' https://www.gstatic.com; script-src-attr 'none' |
| `curl against the local server for 401 (no key), 400 (limit=999, limit=0, from=not-a-date, to=nope), 403 (flag off), 503 (flag on, no Firestore)` | all as documented above with the {error, code} envelope |
| `node index.js (PORT=5391, all notification channels off, LOG_LEVEL=info) and the browser request log` | POST /api/news-monitor/pause 200 -> GET /api/news-monitor/status 200; POST /api/news-monitor/resume 200 -> GET /api/news-monitor/status 200; GET /healthcheck 200; /admin 200; /openapi.json 200 |
| `documentElement.scrollWidth - clientWidth measured at 1440/1024/768/375/320 on newsMonitor, outcomes (summary), alerts (analytics), outcomes (calibration) and presets, with every table rendered, plus the same measurement with origin/master's admin.css served into the same page` | 0px everywhere except Outcomes at 320px: 26px with this PR vs 43px with master CSS (both pre-existing); 0px on presets which has no bare .data-table |

</details>

### 📸 Evidence

**1. News monitor view at 1440px against the real local server with the feature flag off: green RUNNING state card, kill switch, and the honest 'Delivery analytics unavailable.' plus 'Breakdown unavailable - reload to refresh.' instead of fabricated numbers.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1356/round-4-muvyk4u8/01.png" alt="News monitor view at 1440px against the real local server with the feature flag off: green RUNNING state card, kill switch, and the honest 'Delivery analytics unavailable.' plus 'Breakdown unavailable - reload to refresh.' instead of fabricated numbers." width="760">

**2. Paused state card at 1440px after a real POST /api/news-monitor/pause: the Monitor state panel is a red banner-error warning with a red PAUSED badge, 'No news alerts are being produced', Paused at 'just now' and the typed reason.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1356/round-4-muvyk4u8/02.png" alt="Paused state card at 1440px after a real POST /api/news-monitor/pause: the Monitor state panel is a red banner-error warning with a red PAUSED badge, 'No news alerts are being produced', Paused at 'just now' and the typed reason." width="760">

**3. Full news monitor view at 1440px with the delivery-analytics payload: four KPI cards (128 / 17 / derived 13.28% / 35.29% proxy) with sparklines, both bar-chart breakdowns with their data tables and derived per-row alert rates, and the false-positive proxy panel.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1356/round-4-muvyk4u8/03.png" alt="Full news monitor view at 1440px with the delivery-analytics payload: four KPI cards (128 / 17 / derived 13.28% / 35.29% proxy) with sparklines, both bar-chart breakdowns with their data tables and derived per-row alert rates, and the false-positive proxy panel." width="760">

**4. Same view at 375px with the analyses list loaded: no page-level horizontal scrollbar - the two breakdown tables and the analyses table pan inside their own .table-scroll regions while headers stay on one line.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1356/round-4-muvyk4u8/04.png" alt="Same view at 375px with the analyses list loaded: no page-level horizontal scrollbar - the two breakdown tables and the analyses table pan inside their own .table-scroll regions while headers stay on one line." width="760">

**5. NEWS_MONITOR_PAUSED state at 1440px: 'The news monitor is paused - resume to continue.' with the explanation, 'Recorded reason: Gemini quota exhausted for the day' and 'Paused at 15 h ago', with the breakdown panels emptied rather than left stale.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1356/round-4-muvyk4u8/05.png" alt="NEWS_MONITOR_PAUSED state at 1440px: 'The news monitor is paused - resume to continue.' with the explanation, 'Recorded reason: Gemini quota exhausted for the day' and 'Paused at 15 h ago', with the breakdown panels emptied rather than left stale." width="760">

**6. Outcomes view at 320px with 'Performance by window' rendered: headers wrap (white-space normal) and the page-level overflow is 26px - the 468px/523px regression is gone and this is below master's own 43px on the identical payload.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1356/round-4-muvyk4u8/06.png" alt="Outcomes view at 320px with 'Performance by window' rendered: headers wrap (white-space normal) and the page-level overflow is 26px - the 468px/523px regression is gone and this is below master's own 43px on the identical payload." width="760">


<sub>Posted by cubefarm · merges automatically once GitHub's checks pass</sub>

[LRN-1792261875-2] correction: ## 🔍 QA report: ✅ Passed
## 🔍 QA report: ✅ Passed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 1 · **Author:** Ada

PR #1368 fixes the #948 starvation mechanism correctly and I confirmed it end-to-end through the real mounted webhook route, not just the unit tests: four concurrent alerts with ~3s base MCP latency under a 9s budget each issued exactly one coin_analysis call, applied enrichment (alertPath appliedRate24h 100 vs the issue's 0/31 baseline), stayed inside the budget at 6141ms, and left the circuit breaker closed; the slow-503 decline path issued exactly one tool call per alert, logged the residual/floor at info, and emitted zero generic budget-exhausted stubs, so the real provider error is no longer masked. Full suite is green (251 suites / 5626 tests), the changed files are eslint-clean with zero lint delta from the pre-existing 1245-problem baseline, the middleware and auth chain are byte-identical to master so nothing protected was weakened, no new environment variable or Remote Config key was introduced, OpenAPI and Postman carry the new enrichment.baseAttempts block, and git status is clean after every run with zero outbound provider invocations. Four non-blocking items go back to the author: one Postman saved example asserts a combination the code cannot produce (alert-level failedCount 0 together with skippedNonViableCount 1), one new unit test is tautological and executes 0 of 125 statements in enrichFromSignal so it pins nothing, the new telemetry is absent from the /admin Status explorer allowlist, and the red Deploy Preview check is Firebase Hosting channel quota rather than a code defect.

| | Check | Details |
|---|---|---|
| ✅ | Focused unit suite tests/unit/tradingview-mcp-service.test.js | 95 passed / 95 total in 66s on Node 24.18.0, matching the PR's claim of 86 baseline + 9 new. All nine #948 tests present: four-concurrent burst, primary-attempt arithmetic, non-viable decline, still-retries-when-viable, declined-retry-does-not-charge-breaker, viable-window-timeout-does-charge, p50/p95 projection with runtime-to-OpenAPI key parity, cumulative counters past the 200-sample cap, and applied-partial preservation. |
| ✅ | Full test suite pnpm test | 251 suites / 5626 tests, 0 failures, exit code 0, 309s. The PR's own note that unrelated integration suites are load-flaky on master did not reproduce here. |
| ✅ | Contract/alignment suites | postman-collection, openapi-contract, docs-alignment, status-endpoint and openapi-docs: 236/236 passed in 1.9s. |
| ✅ | pnpm lint | eslint on both changed JS files reports 'No issues found'. Repo-wide pnpm lint fails with 1245 pre-existing problems in files this PR does not touch; the delta is provably zero because only two JS files changed and both are clean. |
| ✅ | pnpm install --frozen-lockfile | Lockfile up to date, resolution step skipped, no dependency drift and no new package. |
| ✅ | AC1 four-alert concurrent fixture, 2-3s base latency, 9s budget | Real HTTP: four concurrent POST /api/webhook/alert?useTradingViewData=true against a local fake MCP with 1000ms per hop (~3s per three-hop call). All four returned HTTP 200 with enrichment applied; the fake server recorded exactly 4 coin_analysis tool calls (one per alert, zero retries); wall clock 6141ms inside the 9000ms budget; /api/status reported alertPath totalCount 4, appliedCount 4, appliedRate24h 100, and circuitBreaker closed with 0 consecutive failures. |
| ✅ | AC2 retry declined when the residual cannot fund a viable attempt | Real HTTP with a slow-503 fake MCP (6500ms tools delay). Four sequential alerts produced exactly 4 tool calls, skippedNonViableCount 4, and four info-level lines 'Declined non-viable base retry for BINANCE:<sym>; residual 231-241ms is below the 3000ms viable-attempt floor'. Exactly zero 'base analysis budget exceeded' generic stub lines, proving the real provider error is no longer masked. |
| ✅ | AC3 total MCP work stays inside the enrichment budget | 6141ms wall clock for the four-alert burst under a 9000ms per-alert budget; the base slice was 6750ms (75% of 9000 with volume confirmation on), matching the single-ternary split documented in AGENTS.md. |
| ✅ | AC4 base result surviving optional-enrichment timeout is applied partial | Named test runs on a real 5006ms timer and asserts tradingViewEnrichmentApplied true with tradingViewEnrichmentStatus partial, and separately asserts baseAttempts.appliedCount 1 plus alertPath.appliedCount 1. |
| ✅ | AC5 circuit-breaker and admin-page behavior preserved, delivery never blocked | After four slow-503 alerts the breaker reported state closed with consecutiveFailures 4 against a threshold of 5, i.e. one charge per alert rather than one per issued attempt - the path that on master opens the breaker on the third alert. Zero admin pages. All eight live alert requests returned HTTP 200. The flip side (a viable-window primary timeout still charges and still pages) has its own named test. |
| ✅ | AC6 p50/p95 base-attempt duration observable | dependencies.tradingViewMcp.enrichment.baseAttempts present in the live /api/status and /api/capabilities payload with all ten keys. In every observed state appliedCount + failedCount equalled attemptedCount and p50Ms <= p95Ms <= maxMs held; p50/p95/max were null with no observed sample as documented. |
| ✅ | Auth and rate limiting not weakened | /api/status and /api/webhook/alert without x-api-key both returned 401. app.js, index.js, src/routes/index.js, src/lib/rateLimiter.js, src/lib/bodySizeLimit.js, src/lib/auth.js and alert.js verified byte-identical to origin/master with git diff --quiet, so no protected path could have been changed. Security headers intact: CSP with script-src 'self' and no script-src-attr inline, X-Frame-Options SAMEORIGIN, HSTS, X-Request-Id. |
| ✅ | No new environment variable, flag or Remote Config key | Zero new process.env.* reads in src/ across the diff. .env.example, RemoteConfigService.js and firebase-remote-config-template.json untouched, which is correct for a code-level safety constant that is not operator tuning. |
| ✅ | Contract surfaces agree with the code | Served /openapi.json is byte-identical to the on-disk file and exposes TradingViewMcpRuntimeStatus.properties.enrichment.baseAttempts with all ten keys required; the unit test pins the runtime's emitted key set against that schema so they cannot drift. Postman adds one request with three saved variants and five assertion blocks. /openapi.json and /docs both return 200. |
| ✅ | Dependency failure fails open | Eight live alert requests against a failing/slow MCP all returned HTTP 200 with enriched true and per-channel results arrays present; no crash, no unhandled rejection, and no leaked interval was observed. |
| ✅ | No outbound message from the test run | Zero outbound provider invocations logged across the entire session (grep for sendMessage/greenapi/discord webhook returned 0). Every alert took the 'No notification channels enabled' dead-letter path with results [] and deliveredChannels [], because ENABLE_TELEGRAM_BOT, ENABLE_WHATSAPP_ALERTS and ENABLE_DISCORD_ALERTS were all off. |
| ✅ | Admin console real-browser checks and hosting parity | The PR touches neither src/admin nor public/admin and admin-hosting-parity.test.js is green. In Chromium at 1440/375/320px: 0 JavaScript errors and 0 CSP violations (only a pre-existing /favicon.ico 404), 0 innerHTML assignments in the live DOM, documentElement.scrollWidth === clientWidth at every width, the API key stayed masked and session-only, and an unknown ?view=does-not-exist canonicalised to ?view=overview rendering a non-blank workspace. Expanded the TradingView MCP card and confirmed it renders alertPath and circuit-breaker fields but not baseAttempts (observation C). |
| ✅ | Clean worktree invariant | git status --porcelain and git status --porcelain --untracked-files=all were both empty after the focused suite, the full suite, the coverage run and the live app run. All throwaway probe files lived in /tmp and were deleted; the app and fake MCP were stopped and healthcheck then returned connection-refused as expected. |
| ✅ | Merge hygiene | Exactly 1 commit on top of origin/master tip bc309b60, zero merge commits, mergeable MERGEABLE, no conflicts. Attribution label ada-space-bunny-free is present. The red Deploy Preview and build_and_preview_or_deploy checks are 429 RESOURCE_EXHAUSTED 'channel quota reached' from Firebase Hosting, which the floor brief explicitly treats as a non-blocker; build, CodeQL, gitleaks and all four Analyze checks are green. |
| ⏭️ | Observation A: Postman saved example is not reproducible | Non-blocking documentation defect. The saved response '200 OK - four concurrent alerts applied, one retry declined as non-viable' pairs enrichment.fullCount 4 / partialCount 0 / failedCount 0 with baseAttempts.skippedNonViableCount 1, which cannot co-occur: skippedNonViableCount is only set from the failing attempt's catch (TradingViewMcpService.js:700,720) which always sets retryable false, so sendWithRetry returns the failure and enrichFromSignal takes the !result.success branch (:733) recording 'failed' (:734). Proved by driving the real service (failedCount 1, fullCount 0) and over HTTP (failedCount 4 with skippedNonViableCount 4). All pm.test assertions pass, so no test catches it. No behaviour or build impact. |
| ⏭️ | Observation B: one new unit test is tautological | Non-blocking test-quality issue. The test 'gives the first base attempt the majority of the base budget, capped by the MCP request timeout' defines its own primaryAttemptMs = ({timeoutMs, baseBudgetMs}) => Math.min(timeoutMs, baseBudgetMs) and asserts on that local arrow function, constructing no service. Measured with jest --coverage --collectCoverageFrom on that single test: 0 of 125 statements in enrichFromSignal execute, with 0 executions of the minViableRetryAttemptMs block (L609-614), of attemptTimeoutMs (L677) and of _recordBaseAttempt. It would stay green if :677 used any other formula, so the PR's 'pinned by an arithmetic guard test' overstates this specific test; the primary allocation is behaviourally guarded by the other tests. No behaviour or build impact. |
| ⏭️ | Observation C: new telemetry absent from the /admin Status explorer | Non-blocking observability gap. src/admin/admin.js:1125-1130 renders enrichment through an explicit allowlist covering only enrichment.alertPath.*. Verified in a real browser after driving the decline path: the expanded TradingView MCP card showed alertPath window/total/applied/failed/rates and circuit-breaker state/cooldown/consecutiveFailures but no baseAttempts, skippedNonViableCount or p50Ms. The signal is reachable only via curl /api/capabilities \| jq, which the README documents. Repo precedent exists for expecting such counters on the Status card (signalOutcomeWorker). |
| ⏭️ | Observation D: pre-existing defects not caused by this PR | Recorded so they are not re-litigated against this PR. POST /api/webhook/alert with a malformed JSON body returns HTTP 500 with body 'undefined' instead of 400; a missing text field yields code INTERNAL_ERROR with retryable true instead of INVALID_REQUEST with retryable false; the validateApiKey 401 carries no shared envelope. All three sit in the middleware chain verified byte-identical to origin/master. pnpm lint fails repo-wide with 1245 pre-existing problems (CI uses continue-on-error) with zero delta from this PR. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 - lockfile up to date, no dependency drift |
| `pnpm test -- tests/unit/tradingview-mcp-service.test.js` | 95 passed, 0 failed (66s) |
| `pnpm test -- tests/unit/postman-collection.test.js tests/unit/openapi-contract.test.js tests/unit/docs-alignment.test.js tests/integration/status-endpoint.test.js tests/integration/openapi-docs.test.js --testTimeout=15000` | 236 passed, 0 failed (5 suites) |
| `pnpm test` | 251 suites, 5626 passed, 0 failed, exit 0 (309s) |
| `pnpm lint` | exit 1 - 1245 pre-existing problems repo-wide; zero delta from this PR |
| `npx eslint src/services/tradingview/TradingViewMcpService.js tests/unit/tradingview-mcp-service.test.js` | No issues found |
| `./node_modules/.bin/jest tests/unit/tradingview-mcp-service.test.js -t 'gives the first base attempt the majority of the base budget, capped by the MCP request timeout' --coverage --collectCoverageFrom='src/services/tradingview/TradingViewMcpService.js'` | 1 passed; coverage proves 0 of 125 enrichFromSignal statements executed (observation B) |
| `node probe-948.js (throwaway, /tmp) - drove the real service with a slow 503 to force a non-viable decline` | threw the real 'TradingView MCP HTTP 503'; enrichment.failedCount 1 / fullCount 0 alongside baseAttempts.skippedNonViableCount 1, appliedCount+failedCount==attemptedCount (observation A) |
| `node index.js on port 5391 with all notification channels off + local fake MCP on 5392` | GET /healthcheck 200; GET /api/status without x-api-key 401; with key 200; /api/capabilities identical to /api/status except a volatile timestamp; /openapi.json 200 and byte-identical to disk; /docs 200 |
| `4x POST /api/webhook/alert?useTradingViewData=true (concurrent, fake MCP 1000ms/hop, 9s budget)` | all 200; 6141ms wall clock; fake server saw exactly 4 coin_analysis calls; alertPath appliedRate24h 100; breaker closed |
| `4x sequential POST /api/webhook/alert?useTradingViewData=true (fake MCP 6500ms delay + HTTP 503)` | all 200 in ~6.9s each; exactly 4 tools/call; skippedNonViableCount 4; breaker closed at consecutiveFailures 4/5; zero 'base analysis budget exceeded' stub lines |
| `browser: http://127.0.0.1:5391/admin at 1440/1280/375/320px (Playwright)` | 0 JS errors, 0 CSP violations, 0 innerHTML assignments, 0px horizontal overflow at every width; unknown ?view= canonicalised to ?view=overview |
| `git status --porcelain && git status --porcelain --untracked-files=all` | empty (clean) after every suite, the coverage run and the live app run |
| `git log --merges --oneline origin/master..HEAD \| wc -l` | 0 merge commits - squash/rebase-able |

</details>

### 📸 Evidence

**1. Admin console Overview at 1280px with the API key unset - sidebar nav intact, 'Enter an API key to load live status', no JS or CSP errors**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1368/round-1-muvujuk0/01.png" alt="Admin console Overview at 1280px with the API key unset - sidebar nav intact, 'Enter an API key to load live status', no JS or CSP errors" width="760">

**2. Full-page Status view at desktop width - dependency grid with TradingView MCP honestly DEGRADED after the slow-503 decline path, all three delivery channels DISABLED, API key masked as dots with Session-only label**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1368/round-1-muvujuk0/02.png" alt="Full-page Status view at desktop width - dependency grid with TradingView MCP honestly DEGRADED after the slow-503 decline path, all three delivery channels DISABLED, API key masked as dots with Session-only label" width="760">

**3. Status view at 375px - KPI cards stack cleanly with documentElement.scrollWidth === clientWidth (0px page overflow)**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1368/round-1-muvujuk0/03.png" alt="Status view at 375px - KPI cards stack cleanly with documentElement.scrollWidth === clientWidth (0px page overflow)" width="760">

**4. Status view at 320px - still 0px page overflow; only the intentionally off-canvas sidebar nav extends past the viewport**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1368/round-1-muvujuk0/04.png" alt="Status view at 320px - still 0px page overflow; only the intentionally off-canvas sidebar nav extends past the viewport" width="760">


<sub>Posted by cubefarm · merges automatically once GitHub's checks pass</sub>

[LRN-1792261876-3] correction: ## Round 1 fixes pushed (`5cc3ed2a`)
## Round 1 fixes pushed (`5cc3ed2a`)

QA was right on both blockers, and the plaintext-password leak is a regression this branch introduced: master could not submit either card, so there was nothing to leak before.

**BLOCKER 1 — plaintext password in the URL.** The root cause was worse than the two paths QA measured, so the fix covers all of them:

- Both submit listeners are now attached at `DOMContentLoaded` top level, **before the first `await` and before any `setHidden(...)` reveal**, and `preventDefault()` is the first statement in each. QA's provenance check is what surfaced the third case: master attached `#connection-form`'s listener unconditionally at top level, and I had moved it into `setupLegacyConsole()`, which runs *after* `setHidden('legacy-connection', false)` — so the legacy key had the identical window.
- Readiness gates the **call**, not the listener: `firebaseAuthReady` flips only after `initializeApp` + `setPersistence` resolve, so a submit in the SDK race window reports `Sign-in is not available yet. Try again in a moment.` rather than calling the SDK. One listener per form is preserved, as AGENTS.md requires.
- The credential card is now withheld (`setHidden('auth-form', true)`) in the `!config.configured` branch and in the bootstrap `catch`, instead of leaving a live form beside "Firebase sign-in is unavailable".

**BLOCKER 2 — whitespace key.** The trim is now an explicit precondition in `saveLegacyApiKey()`, and `FakeElement.checkValidity()` no longer trims, so the double is no stricter than the browser. The test that previously passed *because of* the double is now satisfied by production code.

**Tests.** `FakeElement.dispatch()` returns the event so assertions can read `defaultPrevented` — the fake cannot perform a native GET, so that is the only available proxy. Three new regression tests pin the guarantee: a submit inside the SDK race window (`setPersistence` held pending), a submit while `config.configured` is false, and a legacy submit. Verified they fail against the pre-fix code (`3 failed`) and pass after. One collateral assertion changed: `expect(listForm.dispatch('submit')).resolves.toBeUndefined()` asserted `dispatch`'s old `undefined` return, so it is now a plain `await`.

**Chromium re-measurement of the exact reported scenarios:**

| Scenario | `location.search` after Enter | Result |
| :--- | :--- | :--- |
| `auth-config` → `{enabled:true, configured:false}` | `""` | form hidden, `formVisibleToUser: false`, forced `requestSubmit()` does not navigate, no password in URL |
| `configured:true`, SDK scripts delayed 5s, card revealed first | `""` | `Sign-in is not available yet. Try again in a moment.` |
| ready path | `""` | exactly one Firebase request, `Sign-in failed. Check the account and try again.` |
| whitespace-only key | `""` | refused, `validity.valid === true` (native `required` accepts it), nothing stored |
| valid key | `""` | saved to `sessionStorage`, `localStorage` empty, key never in a URL |

**Checks.** `admin-client`, `admin-hosting-parity`, `admin-request`, `admin-charts`, `openapi-docs`, `firebase-hosting-config`: 355 green. `npx eslint` on both changed files: 0 problems before and after. Full `pnpm test`: 5663/5665, the two failures being the pre-existing integration flake already documented in the PR body (that suite passes 95/95 in isolation and flakes identically on unmodified `master`). `git status --porcelain` clean; `public/admin/` regenerated and committed in parity.

Docs corrected: the AGENTS.md section now leads with the never-navigate invariant and the readiness gate, and `docs/api-reference.md` states how the URL guarantee is enforced instead of just asserting it.

[LRN-1792261876-4] correction: ## 🔍 QA report: ✅ Passed
## 🔍 QA report: ✅ Passed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 2 · **Author:** Margaret

Both round-1 blockers are genuinely fixed. The credential submit listeners are now attached at DOMContentLoaded top level before the first await and before either card is revealed, and each calls preventDefault() first, so a real Enter keypress during the Firebase SDK bootstrap or in the configured:false fail-open state leaves location.search empty (verified in Chromium with a 30s stalled SDK, a forced submit, and instrumented history writes). The all-whitespace API key is now refused by an explicit trim precondition in saveLegacyApiKey(), with the test double no longer stricter than the browser (measured validity.valid === true in Chromium). Docs corrected, src/admin and public/admin in parity, 359 admin tests green on three runs, zero new lint errors, and the one failing integration suite is a pre-existing cross-suite flake that is worse on master (3 failed there vs 1 here).

| | Check | Details |
|---|---|---|
| ✅ | BLOCKER 1: no navigation during the Firebase SDK race window | Stalled the gstatic Firebase CDN for 30s via Playwright route interception so the card is revealed with the bootstrap in flight, typed a valid email and password, pressed Enter. location.search === '', href unchanged, zero history.pushState/replaceState writes, and the message 'Sign-in is not available yet. Try again in a moment.' was shown with aria-invalid=true on both inputs. A synthetic submit in the same state reports event.defaultPrevented === true and firebase.auth() was never called. |
| ✅ | BLOCKER 1: no navigation when /admin/auth-config reports configured:false | Server booted with ENABLE_FIREBASE_ADMIN_AUTH=true and no FIREBASE_WEB_* set, which is the exact shape loadAuthConfig() fails open to at admin.js:517. auth-form hidden === true, sign-in button and email input not rendered (offsetParent === null), status line reads 'Firebase sign-in is unavailable.' A forced submit with credentials set returned defaultPrevented === true and left location.search === ''. |
| ✅ | BLOCKER 1: ready path submits exactly once and never navigates | Configured Firebase path (dummy placeholder web config). Real Enter in the email field produced exactly one POST to accounts:signInWithPassword; credentials appear only in the JSON request body, never in the URL. location.search === '' and zero history writes. A pointer click on the type=submit button likewise produced exactly one request, so there is no double-submit from the click+submit pair. |
| ✅ | BLOCKER 2: all-whitespace API key refused by production logic | Set apiKey.value = '   ' in Chromium and measured validity.valid === true, validity.valueMissing === false, checkValidity() === true — proving the browser accepts it, so the refusal cannot come from the double. Submit was refused with 'Enter an API key to use it for this session.', keyState.className 'response-error', aria-invalid='true', no sessionStorage write, no SSE request, location.search === ''. tests/unit/admin-client.test.js FakeElement.checkValidity() no longer trims (verified in the diff). |
| ✅ | AC1: Enter from either Firebase credential field submits exactly once | sign-in is type=submit with no action/method; implicit submission works from both fields. Tab order measured as auth-email -> auth-password -> sign-in. No keydown listener on either credential input in the unit harness, and confirmed in the browser. One request per interaction, from both Enter and a pointer click. |
| ✅ | AC2: empty or malformed Firebase email rejected by the browser before the SDK | email='not-an-email' with a filled password: requestSubmit() produced validity.typeMismatch === true, validity.valid === false, focus moved to auth-email, and zero identitytoolkit network requests were issued — the JS guard was never reached. The browser's own constraint validation is the first line of defence. |
| ✅ | AC3: errors associated with the relevant control, announced, no credential echo | A rejected sign-in rendered 'Sign-in failed. Check the account and try again.' in #auth-credentials-error (role=alert, referenced by both inputs via aria-describedby) with aria-invalid=true on both controls; the message contained neither the email nor the password. A forced submit with event.defaultPrevented observed. The legacy key error goes to #key-state (aria-live=polite, referenced by #api-key) with aria-invalid on #api-key. Editing a field clears both aria-invalid flags and hides the Firebase error. |
| ✅ | AC4: legacy key flow remains session-only and header-only | Enter on a valid key wrote sessionStorage['cabros-admin-api-key'] with localStorage.length === 0 and reported 'API key saved for this browser session.' The key was then sent on GET /api/admin/events with the value present in the x-api-key request header and absent from the URL (inspected the full request headers). End-to-end with a valid local key the SSE indicator reported 'Live' and the live status view loaded. With an invalid key the request returned 403 and SSE showed 'Unavailable', confirming auth still fails closed. |
| ✅ | AC5: unit/integration coverage for valid, invalid and keyboard submission on both paths | New 'credential entry forms' block in tests/unit/admin-client.test.js (9 tests) covers shell markup for both forms, submit-exactly-once with no keydown interceptor, blank and malformed email rejected before the SDK, rejected sign-in associated with both controls without echoing values, error cleared on edit, legacy key saved on submit and never in a URL, empty and whitespace-only key refused, and three defaultPrevented no-navigation pins (SDK race window, configured:false, legacy submit). |
| ✅ | src/admin vs public/admin hosting parity | tests/unit/admin-hosting-parity.test.js passed. Independently re-ran pnpm run build:hosting: 9 assets copied, no diff, git status --porcelain stayed empty. |
| ✅ | Lint: the diff adds zero lint errors | npx eslint on src/admin/admin.js and tests/unit/admin-client.test.js reported 0 errors (index.html is not covered by the config, 1 ignore warning). Repo-wide pnpm lint reports 1231 pre-existing errors in unrelated files, unchanged by this diff. |
| ✅ | Full test suite and master baseline comparison | PR head: 251/252 suites, 5664/5665 tests passed. The single failure is tests/integration/expanded-analysis-alert-endpoint.test.js 'returns 400 when neither body symbols nor EXPANDED_ANALYSIS_ALERT_SYMBOLS are defined' (expected 400, got 404), which passes 19/19 in isolation. I ran the full suite on origin/master in a separate detached worktree with node_modules linked: 3 failed suites / 3 failed tests (alert-inline-keyboard, maintenance-mode-endpoint, news-monitor-analysis-persistence). The flake is pre-existing and strictly worse without this PR; nothing in the diff is on those code paths. Admin-related suites: 359 passed, 0 failed on three consecutive runs. |
| ✅ | Clean worktree invariant | git status --porcelain was empty at the start, after pnpm run build:hosting, after three focused test runs, and at the end of the session. Tests wrote nothing into the worktree. |
| ✅ | Contract surfaces agree with the code | Changed files are AGENTS.md, docs/api-reference.md, src/admin/{admin.js,admin.css,index.html}, public/admin/{admin.js,admin.css,index.html} and tests/unit/admin-client.test.js. No endpoint, env var, Remote Config key, OpenAPI schema or Postman variant is touched, so no contract surface is required to change. Confirmed by grep over the changed-file list and by the absence of any process.env read in the diff. |
| ✅ | No secrets, no unsafe DOM, no auth weakening | No secret-shaped literal in the diff (no AIza key, bearer token, private key or long api-key assignment). No innerHTML, outerHTML, insertAdjacentHTML, document.write or eval added. All seven script tags are local /admin/*.js with no inline script and no CDN asset. CSP, X-Content-Type-Options and X-Frame-Options all served; no CSP violation in the browser console. validateApiKey, src/lib/auth.js, src/lib/adminAuth.js and src/routes/index.js are untouched and still fail closed: POST /api/webhook/alert returned 401 with no key and 403 with a bad key, GET /api/status returned 401. |
| ✅ | Dependency failure fails open; no crash or leaked interval | Across five server boots (legacy, Firebase configured, Firebase unconfigured, plus two repeats) the structured logs contain zero UnhandledPromiseRejection, uncaughtException, TypeError or ReferenceError entries. A dependency failure on the Firebase SDK path degrades to the withheld-form 'unavailable' state rather than an enabled form beside a dead message. |
| ✅ | Responsive layout, 375px and 320px, and mobile-relevant markup | At 375px and 320px documentElement.scrollWidth === clientWidth, so there is no page-level horizontal scrollbar on either credential card. Labels stack above inputs inside their .field/.key-field grid cells and the error spans both columns. The nav row that appears to overlap at 375px is an intentional overflow-x:auto scroller on #console-nav (scrollWidth 1010 vs clientWidth 308) whose CSS this diff does not touch. |
| ✅ | SSE indicator reflects real connection state | Reported 'Unavailable' with an invalid key (403 from /api/admin/events) and 'Live' with a valid local key once the stream connected — the indicator tracks the observed outcome rather than assuming health. |
| ✅ | No outbound message delivered from any test or preview run | ENABLE_TELEGRAM_BOT, ENABLE_WHATSAPP_ALERTS and ENABLE_DISCORD_ALERTS were off for every boot, with the news monitor, market scanner, schedulers, Firestore storage and Remote Config all disabled. Nothing was sent to Telegram, WhatsApp or Discord at any point; all assertions were made against API JSON and DOM state. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `git fetch origin master && git diff origin/master...HEAD --stat` | 9 files changed, 669 insertions(+), 102 deletions(-); base af7d4642 confirmed current |
| `git log --merges origin/master..HEAD --oneline \| wc -l` | 0 — no merge commits, squash/rebase ruleset-safe |
| `pnpm install --frozen-lockfile` | Lockfile is up to date, already installed |
| `pnpm test -- tests/unit/admin-client.test.js tests/unit/admin-hosting-parity.test.js tests/unit/admin-request.test.js tests/unit/admin-charts.test.js` | 4 suites passed, 342 tests passed, 0 failed |
| `pnpm run build:hosting && git status --porcelain` | 9 assets copied; git status empty — src/admin and public/admin in parity |
| `npx eslint src/admin/admin.js tests/unit/admin-client.test.js` | 0 errors, 0 warnings on changed JS (index.html not covered by config) |
| `pnpm lint` | 1231 errors / 14 warnings repo-wide, all pre-existing and outside this diff |
| `pnpm test` | 251 passed / 1 failed suites; 5664 passed / 1 failed tests (322s). Failure: expanded-analysis-alert-endpoint 'returns 400 when neither body symbols nor EXPANDED_ANALYSIS_ALERT_SYMBOLS are defined' — expected 400, got 404 |
| `pnpm test -- tests/integration/expanded-analysis-alert-endpoint.test.js` | 1 suite passed, 19 tests passed — passes in isolation, confirming a cross-suite flake |
| `pnpm test  (in a detached git worktree at origin/master, node_modules symlinked)` | 249 passed / 3 failed suites; 5652 passed / 3 failed tests. Failing: alert-inline-keyboard, maintenance-mode-endpoint, news-monitor-analysis-persistence — pre-existing flakiness, worse than on the PR head |
| `pnpm test -- tests/unit/admin-client.test.js tests/unit/admin-hosting-parity.test.js tests/unit/admin-request.test.js tests/unit/admin-charts.test.js tests/integration/admin-hosting-smoke.test.js tests/integration/openapi-docs.test.js tests/unit/firebase-hosting-config.test.js  (x3)` | 7 suites / 359 tests passed on all three consecutive runs |
| `PORT=5391 node index.js  (integrations off; three env variants: legacy key path, Firebase configured with placeholder web config, Firebase enabled but unconfigured)` | GET /healthcheck 200 in all three; /admin/auth-config returned {enabled:false,...}, {enabled:true,configured:true,...} and {enabled:true,configured:false,...} as intended |
| `curl -X POST /api/webhook/alert (no key / bad key) and GET /api/status (no key)` | 401, 403 and 401 — auth boundaries unchanged and failing closed |
| `git status --porcelain (start, after build:hosting, after 3 focused runs, at end)` | empty every time — tests never mutate the worktree |

</details>

### 📸 Evidence

**2. Valid key saved on Enter: 'API key saved for this browser session.' with the SSE indicator showing 'Unavailable' because the intentionally invalid local key was rejected**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/02.png" alt="Valid key saved on Enter: 'API key saved for this browser session.' with the SSE indicator showing 'Unavailable' because the intentionally invalid local key was rejected" width="760">

**3. Legacy credential card at 375px: label stacked above input, no page-level horizontal overflow**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/03.png" alt="Legacy credential card at 375px: label stacked above input, no page-level horizontal overflow" width="760">

**4. Legacy credential card at 320px: same layout, scrollWidth equals clientWidth**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/04.png" alt="Legacy credential card at 320px: same layout, scrollWidth equals clientWidth" width="760">

**5. Rejected Firebase sign-in: 'Sign-in failed. Check the account and try again.' rendered full width beneath the Sign in button and associated with both inputs via aria-describedby, aria-invalid=true on both, neither credential echoed, URL unchanged**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/05.png" alt="Rejected Firebase sign-in: 'Sign-in failed. Check the account and try again.' rendered full width beneath the Sign in button and associated with both inputs via aria-describedby, aria-invalid=true on both, neither credential echoed, URL unchanged" width="760">

**6. SDK race window: Firebase CDN stalled 30s so the card is revealed mid-bootstrap — a real Enter press yields 'Sign-in is not available yet. Try again in a moment.' with no navigation and zero history writes**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/06.png" alt="SDK race window: Firebase CDN stalled 30s so the card is revealed mid-bootstrap — a real Enter press yields 'Sign-in is not available yet. Try again in a moment.' with no navigation and zero history writes" width="760">

**7. configured:false state: the credential form is withheld entirely, leaving only 'Firebase sign-in is unavailable. Ask an administrator to configure it.'**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/07.png" alt="configured:false state: the credential form is withheld entirely, leaving only 'Firebase sign-in is unavailable. Ask an administrator to configure it.'" width="760">

**8. Legacy key flow end to end after Enter: 'API key saved for this browser session.', SSE indicator green and 'Live', live status view loaded, key present only in the x-api-key header**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/08.png" alt="Legacy key flow end to end after Enter: 'API key saved for this browser session.', SSE indicator green and 'Live', live status view loaded, key present only in the x-api-key header" width="760">

**9. Full-page 375px capture of both credential cards showing correct stacking and the field-associated error area**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1370/round-2-muw5nip3/09.png" alt="Full-page 375px capture of both credential cards showing correct stacking and the field-associated error area" width="760">


<sub>Posted by cubefarm · merges automatically once GitHub's checks pass</sub>

[LRN-1792261876-5] correction: ## 🔍 QA report: ❌ Failed
## 🔍 QA report: ❌ Failed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 1 · **Author:** Linus

The functional fix is correct and I independently confirmed it: extracted all five --data-raw payloads from master and HEAD and ran them through a real sh — on HEAD all five honour NOTIFY_WHATSAPP_CHAT_ID and emit valid JSON, on master all five ignore it, so the issue is genuinely reproduced and genuinely fixed, with the requested120363422033474991@g.us group as the default. However the edit reindents two of the three payload blocks and breaks the document structure: SKILL.md:316-325 loses its list continuation so the need-manual-deploy curl collapses into one run-on inline code blob with a literal 'bash' prefix and flattened line continuations, and SKILL.md:409-421 loses its '- ' marker so the deadlock notification step is promoted out of the 'CLI Authentication Failures' list to a top-level bullet. Proven with GitHub's own CommonMark renderer over the committed bytes. The new test matches payloads by regex and never parses structure, which is why it did not catch this. One non-blocking note: .github/workflows/firestore-backup.yml:105 still hardcodes the same chat id. The single full-suite failure is pre-existing order-dependent flakiness, proven by a pristine merge-base baseline that fails worse (2 tests, different suite).

| | Check | Details |
|---|---|---|
| ✅ | Issue requirement: destination is 120363422033474991@g.us | Confirmed. All five payloads resolve to 120363422033474991@g.us with the knob unset, in a real sh. |
| ✅ | Issue defect is real: master ignores NOTIFY_WHATSAPP_CHAT_ID | Real sh, master payloads, override=120363000000000999@g.us: all 5 emitted whatsappChatId=120363422033474991@g.us. The override was completely ignored, reproducing the issue. |
| ✅ | Fix works: HEAD honours the override | Real sh, HEAD payloads. Default (unset): all 5 -> 120363422033474991@g.us. Override set: all 5 -> 120363000000000999@g.us. All 10 renders parsed as valid JSON with channels=['whatsapp']. The '"..."' quoting breakout survives correctly. |
| ✅ | All five payloads use the knob (no bare literal) | grep confirms SKILL.md lines 76, 92, 324, 380, 419 all carry ${NOTIFY_WHATSAPP_CHAT_ID:-120363422033474991@g.us}; no payload contains a bare group literal. |
| ✅ | New test is a valid regression test | Ran the new test against master's SKILL.md in an isolated scratch tree: 4 failed / 4 passed, naming all five payload sites (73, 89, 324, 377, 416) plus the decisive override case. Against HEAD: 8/8 pass. |
| ❌ | BLOCKER: markdown structure regression, SKILL.md:316-325 | Line 316 lost its 3-space list-continuation indent, closing the ordered list after the preceding code block; the fence then sits at 4 spaces under a top-level paragraph, so it is no longer a fence and is absorbed as lazy continuation. GitHub's CommonMark renderer emits '</li></ol>' then a <p> in which the whole 7-line curl becomes one inline <code> blob prefixed with a literal 'bash', continuations flattened to spaces and fence markers as literal text. master renders it as a proper <pre> shell block inside list item 3. |
| ❌ | BLOCKER: markdown structure regression, SKILL.md:409-421 | Line 409 lost its '  - ' marker and the fence went 4->5 spaces, closing the nested sub-list early. The 'Send a WhatsApp global-deadlock notification' step is promoted to a top-level <li>, a peer of 'CLI Authentication Failures', 'Merge Conflicts' and 'Preview deployment timeout' instead of a sub-step of the first, and 'Then end the run...' becomes nested under it. The code block itself still renders. |
| ✅ | SKILL.md:368-382 (In-review payload) unchanged structurally | Checked for the same defect and cleared: rendered output is byte-identical between master and HEAD. The 4-space fence is still a valid fence inside the '6.' list item. Not a defect. |
| ❌ | New test does not cover markdown structure | notificationPayloads() extracts payloads with a regex and the suite asserts only on knob presence, literals, JSON validity and channels. No structural assertion exists, which is why both indentation regressions passed CI. |
| ❌ | NON-BLOCKING: remaining hardcoded destination outside the skill | .github/workflows/firestore-backup.yml:105 still carries "whatsappChatId": "120363422033474991@g.us" in its failure-notification payload. Same NOTIFY_* knob family (NOTIFY_WEBHOOK_URL/NOTIFY_API_KEY from secrets), and the rule this PR introduces would forbid it. It is a backup-failure alert rather than a PR notification so it is outside the issue's wording, and the new test only reads SKILL.md so it cannot see it. Follow-up, not a blocker. |
| ✅ | Focused skill suites | pnpm test over the 7 suites that read .agents/skills: 7 passed, 77 passed, 0 failed, exit 0. Matches the PR's claim exactly. |
| ✅ | pnpm lint on the new file | npx eslint tests/unit/issue-automator-notification-destination.test.js exits 0 with no findings. |
| ✅ | Repo-wide lint baseline unchanged | 1245 problems repo-wide, all pre-existing. The diff's only .js file is the new test, which lints clean, so this PR's lint delta is 0. |
| ✅ | Boots clean, integrations off | node index.js on port 5391 with ENABLE_TELEGRAM_BOT/WHATSAPP/DISCORD=false. GET /healthcheck 200 {"uptime":…}, /ready 200, /openapi.json 200, /admin 200, /docs 200, /admin/auth-config 200. No error or warn lines in the boot log. |
| ✅ | validateApiKey not weakened on webhook routes | Second instance on 5392 with WEBHOOK_API_KEY set. POST /api/webhook/alert: no key -> 401 'Unauthorized: Missing API key'; wrong key -> 403; correct key -> 200 dryRun. No auth code is in the diff. |
| ✅ | No outbound delivery from preview or test | grep for telegram\|whatsapp\|discord\|sendMessage across the auth-instance boot log returns exactly 1 line: 'Telegram Bot is disabled'. Every probe used dryRun=true or GET. Nothing was delivered. |
| ✅ | No secrets in the diff | The 3 changed files are SKILL.md, AGENTS.md and a new unit test. No API key, bot token, webhook URL, Sentry DSN or Binance key appears in any of them; the chat id is the operator's own notification group, already present on master. |
| ✅ | Contract surfaces agree with the code | The diff adds no endpoint, request variant, response shape, app env var or feature flag, so openapi.json, CabrosBot.postman_collection.json, .env.example and firebase-remote-config-template.json correctly need no edit. NOTIFY_WHATSAPP_CHAT_ID is pre-existing agent-tooling shell config (already at SKILL.md:63 on master) that the app never reads, matching the VERIFY_PREVIEW_ALLOWED_HOSTS precedent for .env.example/Remote Config exemption. |
| ✅ | src/admin and public/admin in sync | Neither tree is in the 3-file diff. Console loaded at 1400px and rendered correctly; console shows no CSP violation and no JS errors (only a pre-existing favicon.ico 404). |
| ✅ | Full suite on PR head | pnpm test on6eed1538 with Node 24.18.0: 253 suites, 5663 tests, 1 failed (tests/integration/status-endpoint.test.js, 'aliases /api/capabilities to expose TradingView MCP toolMetrics', expected 200 received 404). |
| ✅ | Full-suite failure attributed to pre-existing flakiness | Ran the full suite in a separate worktree at the exact merge-base af7d4642 with ZERO PR changes: 252 suites, 5655 tests, 2 failed (tests/integration/alerts-endpoint.test.js, two unrelated tests). The untouched baseline fails worse and on a different suite — the order-dependence signature. status-endpoint.test.js passes 129/129 in isolation on HEAD, and the new test mutates no process.env or global, so it cannot leak state. The PR's tests/setup.js:4 diagnosis and its CI coin-flip warning are accurate. |
| ✅ | git status --porcelain clean after all runs | Empty after the focused runs, the two full runs, the lint runs and the scratch-tree regression test. Tests are read-only. |
| ✅ | Mechanical: single commit, no merge commits, mergeable | 1 commit (6eed1538), mergeable MERGEABLE / mergeStateStatus CLEAN, no conflicts, so the ruleset squash/rebase requirement is met. Branch is 1 commit behind master (e6ea588d) — not a conflict, but a rebase would avoid a second full-suite CI coin-flip. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `git diff origin/master...HEAD -- .agents/skills/issue-automator/SKILL.md AGENTS.md` | 3 changed files: SKILL.md +45/-45, AGENTS.md +1/-0, new 175-line test |
| `gh pr view 1372 --json mergeable,mergeStateStatus,commits,labels` | MERGEABLE / CLEAN, 1 commit, no merge commits, label opencode-space-bunny-free |
| `grep -rn '120363422033474991' --include='*.md' --include='*.js' --include='*.yml' .` | all SKILL.md payload literals now reference the knob; one hardcoded literal remains at .github/workflows/firestore-backup.yml:105 |
| `gh api markdown --method POST -f mode=gfm  (region C2, lines 300-331, master vs HEAD)` | master: notification step inside <ol> item 3, curl in a <pre> shell block. HEAD: </li></ol> then <p> with the curl collapsed into one inline <code> blob prefixed 'bash' |
| `gh api markdown --method POST -f mode=gfm  (region B2, lines 401-427, master vs HEAD)` | master: notification step is a nested <li> under 'CLI Authentication Failures'. HEAD: promoted to a top-level <li> and 'Then end the run' nested beneath it |
| `gh api markdown --method POST -f mode=gfm  (region A2, lines 353-392, master vs HEAD)` | byte-identical output — no regression in the In-review payload |
| `sh -c "curl --data-raw '<payload>'" for all 5 payloads, default and override, on master and HEAD` | 10/10 valid JSON on HEAD (5 default + 5 override honoured); 10/10 valid JSON on master with the override ignored in all 5; EXIT=0 |
| `npx jest (new test against master's SKILL.md in an isolated scratch tree)` | 4 failed / 4 passed, naming all five payload sites — proves it is a real regression test |
| `pnpm test -- tests/unit/verify-preview-deployment-binding.test.js tests/unit/claim-issue-comment-noise.test.js tests/unit/detect-unused-features-skill.test.js tests/unit/agent-cross-review-skill.test.js tests/unit/issue-automator-preview-url-docs.test.js tests/unit/issue-automator-needs-user-prefilter.test.js tests/unit/issue-automator-notification-destination.test.js --testTimeout=5000` | 7 passed, 77 tests passed, 0 failed, exit 0 |
| `npx eslint tests/unit/issue-automator-notification-destination.test.js` | exit 0, no findings |
| `pnpm run lint` | 1245 problems, all pre-existing; this PR's delta is 0 |
| `node index.js (PORT=5391, all delivery channels off) then GET /healthcheck /ready /openapi.json /admin /docs /admin/auth-config` | 200 on all six; no error or warn lines in the boot log |
| `POST /api/webhook/alert on a key-protected instance (5392): no key / wrong key / correct key+dryRun` | 401 'Unauthorized: Missing API key' / 403 / 200 {success:true,dryRun:true} |
| `grep -Ein 'telegram\|whatsapp\|discord\|sendMessage' boot-auth.log` | 1 line: 'Telegram Bot is disabled' — zero outbound delivery |
| `pnpm test  (PR head 6eed1538, Node 24.18.0)` | 253 suites, 5663 tests, 1 failed (status-endpoint.test.js), 311.59 s |
| `pnpm test  (pristine merge-base af7d4642 in a separate worktree, zero PR changes)` | 252 suites, 5655 tests, 2 failed (alerts-endpoint.test.js), 313.52 s — baseline fails worse |
| `pnpm test -- tests/integration/status-endpoint.test.js --testTimeout=15000` | 1 passed, 129 passed — passes in isolation, confirming order dependence |
| `git status --porcelain (after all runs)` | empty — worktree clean |

</details>

### 🔧 What needs fixing

Two blocking fixes, both pure whitespace in .agents/skills/issue-automator/SKILL.md. Restore the original indentation; do not touch the payload content.

1) Region C, SKILL.md:316-325 ('need manual PR deploy'). Line 316 must keep its 3-space list-continuation indent and the fence must sit at the list item's content column (3), matching origin/master:
   - current: `Send a WhatsApp notification with issue and PR links to NOTIFY_WHATSAPP_CHAT_ID (default 120363422033474991@g.us):`
   - required: `   Send a WhatsApp notification with issue and PR links to NOTIFY_WHATSAPP_CHAT_ID (default 120363422033474991@g.us):`
   - lines 317-325: dedent every line by exactly one space (4 spaces -> 3), keeping the ```bash / ``` fences at 3 so they remain fences.

2) Region B, SKILL.md:409-421 ('global deadlock'). Line 409 must keep its nested-bullet marker so it stays a sibling of the other sub-steps under 'CLI Authentication Failures', and the fence must return to 4 spaces, matching origin/master:
   - current: `- Send a WhatsApp global-deadlock notification to NOTIFY_WHATSAPP_CHAT_ID (default 120363422033474991@g.us) with the issue URL and a PR URL if one exists:`
   - required: `  - Send a WhatsApp global-deadlock notification to NOTIFY_WHATSAPP_CHAT_ID (default 120363422033474991@g.us) with the issue URL and a PR URL if one exists:`
   - lines 410-421: dedent every line by exactly one space (5 -> 4).

The simplest correct edit is `git checkout origin/master -- .agents/skills/issue-automator/SKILL.md` and then re-apply only the five `"whatsappChatId": "'"${NOTIFY_WHATSAPP_CHAT_ID:-120363422033474991@g.us}"'"` substitutions plus the prose wording, leaving every leading-whitespace byte untouched. The current diff shows 45 added / 45 removed lines where only 14 should change content, which is the tell that whitespace moved.

Region A (SKILL.md:368-382) needs no change: I rendered master and HEAD and the output is byte-identical; the 4-space fence is still valid inside the '6.' list item.

Verify after fixing, e.g.:
  git diff origin/master...HEAD -- .agents/skills/issue-automator/SKILL.md | grep -c '^[+-]'
Expect a small number, not 90.

Please also add a structural assertion to tests/unit/issue-automator-notification-destination.test.js so this cannot regress silently. The existing suite matches payloads with a regex and never parses markdown structure, which is why both regressions passed CI. A cheap guard: for each of the five payload regions, assert the ```bash fence that opens it is indented at most 3 spaces relative to its enclosing list item's content column, and assert no payload line's leading whitespace decreases relative to the line before it when the previous line opened a fence. That is exactly the condition that produced the run-on collapse.

Optional follow-up (non-blocking, separate PR or a line in this one): .github/workflows/firestore-backup.yml:105 still hardcodes "whatsappChatId": "120363422033474991@g.us". It is the same NOTIFY_* family and the same literal, and the rule this PR introduces forbids it. Routing it through ${{ vars.NOTIFY_WHATSAPP_CHAT_ID || '120363422033474991@g.us' }} would make the contract you documented in AGENTS.md true across every notification path; leaving it out of the test scope is fine, but it should not stay silently inconsistent.

Not your problem, confirmed not attributable to this PR: the single full-suite failure. I ran the full suite in a separate worktree at the exact merge-base af7d4642 with zero changes from this PR and got 2 failures in a different suite (alerts-endpoint.test.js); status-endpoint.test.js passes 129/129 in isolation on HEAD. Your tests/setup.js:4 root-cause analysis and the 'expect CI to be a coin flip' warning are both accurate. Consider rebasing onto master (e6ea588d) so CI runs once instead of twice.

### 📸 Evidence

**1. Side-by-side rendering of the committed SKILL.md bytes through GitHub's own CommonMark renderer. Region C ('need manual PR deploy' payload, SKILL.md:316-325): on master (green) the notification step stays inside ordered-list item 3 with the curl as a clean code block; on PR HEAD (magenta) the list closes after the previous code block and the entire 7-line curl collapses into a run-on inline block prefixed with a literal 'bash', continuations flattened and fence markers rendered as text. Region B ('global deadlock' payload, SKILL.md:409-421): on master the notification step is a nested bullet under 'CLI Authentication Failures'; on HEAD it is promoted to a top-level bullet level with 'Merge Conflicts' and 'Preview deployment timeout / bounded retry'.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1372/round-1-muw93c35/01.png" alt="Side-by-side rendering of the committed SKILL.md bytes through GitHub's own CommonMark renderer. Region C ('need manual PR deploy' payload, SKILL.md:316-325): on master (green) the notification step stays inside ordered-list item 3 with the curl as a clean code block; on PR HEAD (magenta) the list closes after the previous code block and the entire 7-line curl collapses into a run-on inline block prefixed with a literal 'bash', continuations flattened and fence markers rendered as text. Region B ('global deadlock' payload, SKILL.md:409-421): on master the notification step is a nested bullet under 'CLI Authentication Failures'; on HEAD it is promoted to a top-level bullet level with 'Merge Conflicts' and 'Preview deployment timeout / bounded retry'." width="760">

**2. Admin console at http://127.0.0.1:5391/admin, 1400px, all notification channels disabled — renders correctly with no CSP violation and no JavaScript errors (only a pre-existing favicon.ico 404). Confirms src/admin and public/admin are unaffected, since neither tree is in this PR's 3-file diff.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1372/round-1-muw93c35/02.png" alt="Admin console at http://127.0.0.1:5391/admin, 1400px, all notification channels disabled — renders correctly with no CSP violation and no JavaScript errors (only a pre-existing favicon.ico 404). Confirms src/admin and public/admin are unaffected, since neither tree is in this PR's 3-file diff." width="760">


<sub>Posted by cubefarm · sent back to the developer for fixes</sub>

[LRN-1792261877-6] correction: ## 🔍 QA report: ✅ Passed
## 🔍 QA report: ✅ Passed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 1 · **Author:** Linus

The local supersession marker is no longer a short-circuit: durable commit order decides whenever both snapshots are readable, and the marker is only consulted where durable evidence is unavailable. I verified the behavioural delta with a direct 11-scenario probe run against both master and the branch — master fails exactly the reported case (skewed local marker suppressing a newer durable re-entry) while the branch returns false, and all ten fail-open/regression scenarios are byte-identical between the two sources. The new regression test genuinely pins the fix: restoring master's production source fails only that test with 'Expected: false / Received: true'. The full suite showed one unrelated integration failure, which I proved pre-existing across three runs (branch, master-source, pure master) tracing to the shared app._router.stack.pop() harness pattern under maxWorkers:1; CI is green on this commit. Contract surfaces are untouched, no new env vars, no outbound delivery, validateApiKey still rejects unauthenticated webhook calls, and the admin console is clean at 1440px and 375px.

| | Check | Details |
|---|---|---|
| ✅ | AC1 — A newer Firestore record is not classified as superseded solely because a local marker has an older or skewed generation | Direct probe outside Jest: local marker generation 5000 vs record generation 1000, durable supersession updateTime 1000.000000 vs durable record createTime 1005.500000. Branch returns false (re-entry proceeds); master returns true (the missed alert). The in-repo regression test 'reconciles a skewed local supersession marker against a newer durable re-entry (#919)' asserts the same and passes. |
| ✅ | AC1 inverse guard — the fix is not over-corrected into always-trust-durable | Probe with local marker generation 100 vs record generation 5000 and the durable record committed BEFORE the supersession (createTime 995 < updateTime 1000): both master and branch return true. The PR's own test 'still supersedes an older record when the local marker generation understates the supersession' passes. |
| ✅ | AC2 — Local-only and Firestore-unavailable behavior remains bounded and fail-open | Four probe scenarios with a local marker present: no Firestore at all -> true; durable read throws -> true; durable read stalls forever -> true in 52 ms against a 50 ms budget (RECONCILIATION_TIMEOUT_MS=500 remains the ceiling); and no marker + no Firestore -> false (unchanged default). All four match master exactly, so the fail-open contract is preserved rather than inverted. |
| ✅ | AC3 — A regression test covers a local-marker/newer-durable-record combination and verifies that the re-entry proceeds | All 6 new tests present and passing (117 total in the file). Independent mutation check: I checked out master's version of NotificationRedriveService.js while keeping the new tests; the suite failed with exactly one test, 'reconciles a skewed local supersession marker against a newer durable re-entry (#919)' — 'Expected: false / Received: true' at tests/unit/notification-redrive-service.test.js:1029. File restored afterwards (SHA-256 1a63146a… matches pre-check), worktree verified clean. |
| ✅ | No regression in adjacent supersession decisions | Probe covers locally-cancelled (keyed on record.id) -> true, durably-cancelled -> true, no-marker + durable supersession newer -> true, no-marker + durable record newer -> false. All identical on master and branch. The pre-existing 'recordNanos >= supersessionNanos -> return false' tie branch is now reachable in the marker case and behaves correctly. |
| ✅ | Full test suite on the branch | pnpm test: 253 suites, 5688 tests, 1 failed — 'POST /api/alerts/batch/export returns 400 when alertIds exceeds 1000' received 404 instead of 400. Unrelated to this change: the file never references redrive, and CI's build job passed the full suite on this exact commit (cd24fd55). See the pre-existing-flake check below. |
| ✅ | Pre-existing flake proven, not assumed | Three full-suite runs. (1) Branch: 1 fail in alerts-endpoint (404). (2) master source + PR tests: 2 fails — the expected #919 regression plus signal-outcome-integration 'POST /api/webhook/alert' got 404. (3) Pure master, PR fully reverted: 5682 tests, 3 fails in public-status-endpoint and openapi-docs, all 'socket hang up'. Three different unrelated files across branch and master. Mechanism: jest.config.js sets maxWorkers: 1 and ~24 integration files mount /api themselves then unwind with app._router.stack.pop() (alerts-endpoint.test.js:107-115, signal-outcome-integration.test.js:39-47), so an unbalanced stack push leaves the /api layer popped and later requests 404. Not caused by this PR. |
| ✅ | ESLint — no new lint debt | src/services/notification/NotificationRedriveService.js: 17 errors on branch and 17 on master (measured by piping master's blob through eslint --stdin). tests/unit/notification-redrive-service.test.js: 4 on branch and 4 on master. Repo-wide pnpm lint reports 1245 pre-existing problems; the CI Lint step is continue-on-error: true per issue #565. |
| ✅ | Contract surfaces agree with the code | Diff touches only AGENTS.md, NotificationRedriveService.js and its test file. Verified UNCHANGED: src/openapi/openapi.json, CabrosBot.postman_collection.json, .env.example, README.md, firebase-remote-config-template.json, render.yaml, firestore.indexes.json. No new process.env reads introduced, so the 'no contract impact' claim is accurate — isRepeatCooldownSuperseded() is internal and only surfaces through the existing cancelled dead-letter status. |
| ✅ | App boots and serves with integrations off | pnpm run start-dev on PORT=5391 with throwaway non-secret BOT_TOKEN/WEBHOOK_API_KEY, ENABLE_TELEGRAM_BOT/WHATSAPP/DISCORD=false, SENTRY=false. Log: 'Running server on port 5391', 'Telegram Bot is disabled', no throw. GET /healthcheck 200 with uptime field present; GET /ready 200 ready=true. |
| ✅ | Authentication is not weakened | GET /api/capabilities without x-api-key -> 401 'Unauthorized: Missing API key'; with key -> 200. POST /api/webhook/alert without x-api-key -> 401. validateAdminAccess is untouched by the diff. |
| ✅ | Honest readiness in /api/capabilities | dependencies.notificationRedrive reports enabled:false, configured:true, ready:false, status:'disabled', running:false, pendingCount:0 — no false green for the gate that was off. The admin console's dependency explorer renders the same verdict as a DISABLED card, matching the JSON. |
| ✅ | No outbound message from the QA run | POST /api/webhook/alert with x-api-key and dryRun:true -> 200, success:true, dryRun:true, requestId present, and no results/deliveredChannels keys, i.e. no dispatch was attempted. The status page shows Telegram, WhatsApp and Discord all DISABLED. The only warn-level log lines are the two intentional 401 access entries. |
| ✅ | No secrets in logs, output or the diff | grep for the throwaway key and bot token across the server log returns nothing — the logger's redaction is working. Regex scan of the full diff for API-key, bot-token, Discord-webhook, GreenAPI and Sentry-DSN shapes returns nothing. The API key travelled only in the x-api-key header and sessionStorage; the browser screenshot shows it masked. |
| ✅ | Admin console in a real browser | 1440x900 and 375x780. Zero JavaScript errors and zero CSP violations; the only console entry is a 404 for /favicon.ico, unrelated to the diff. documentElement.scrollWidth === clientWidth === 375 (no page-level horizontal scrollbar). Signed-out state shows 'Enter an API key to load live status' with no API traffic. After submitting the key the SSE indicator flips Offline -> Live. Unknown ?view=definitely-not-a-view canonicalises to ?view=overview and renders the workspace rather than a blank page. |
| ✅ | Worktree invariant and merge hygiene | git status --porcelain empty after every install, test run and temporary source swap; HEAD still cd24fd55. No commit, push, comment or merge performed. PR is MERGEABLE, single commit, no merge commits, no prior review verdicts, no conflicting files. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `nvm use 24.18.0 && pnpm install --frozen-lockfile` | Lockfile up to date, already up to date, done in 293ms |
| `pnpm test -- tests/unit/notification-redrive-service.test.js` | 117 passed, 0 failed (all 6 new tests present and green) |
| `git checkout origin/master -- src/services/notification/NotificationRedriveService.js && pnpm test -- tests/unit/notification-redrive-service.test.js` | 1 failed, 116 passed — only 'reconciles a skewed local supersession marker against a newer durable re-entry (#919)': Expected false, Received true (proves the test pins the fix); file restored and verified by SHA-256 |
| `node qa1374-probe.js <repo> (throwaway, 11 scenarios)` | branch: 11/11 verdicts as expected; master source: 10/11 (AC1 returns true = the bug) |
| `pnpm lint` | 1245 problems repo-wide, all pre-existing (Lint step is continue-on-error per #565) |
| `npx eslint src/services/notification/NotificationRedriveService.js` | 17 problems — identical to master's 17 |
| `npx eslint tests/unit/notification-redrive-service.test.js` | 4 problems — identical to master's 4 |
| `git show origin/master:<file> \| npx eslint --stdin --stdin-filename <file> (x2)` | master baseline: 17 and 4 — confirms zero new lint debt |
| `pnpm test (branch, cd24fd55)` | 253 suites, 5688 tests, 1 failed (alerts-endpoint batch/export 404) — proven pre-existing |
| `pnpm test (master production source + PR tests)` | 253 suites, 5688 tests, 2 failed: expected #919 regression + signal-outcome-integration 404 |
| `pnpm test (pure master, PR fully reverted)` | 253 suites, 5682 tests, 3 failed: public-status-endpoint + openapi-docs socket hang up |
| `pnpm test -- tests/integration/alerts-endpoint.test.js (x3)` | 3/3 green in isolation (269 tests each) |
| `gh pr checks 1374` | all pass, including build (node.js.yml, 6m2s) — CI green on cd24fd55 |
| `git diff --name-only origin/master...HEAD + per-file contract surface check` | 3 files changed; openapi/postman/.env.example/README/remote-config template/render.yaml/firestore.indexes.json all UNCHANGED |
| `curl /healthcheck, /ready, /api/capabilities (with and without key), POST /api/webhook/alert (401 and dryRun) on :5391` | 200 / 200 ready=true / 401 / 200 / 401 / 200 dryRun with no dispatch |
| `grep for key + bot token in server log; regex secret scan of the full diff` | no secret values in the log; no secret-shaped literals in the diff |
| `git status --porcelain (after every step)` | empty — worktree clean throughout |

</details>

### 📸 Evidence

**1. Admin console Overview at 1440px, signed out — renders the session-access card and 'Enter an API key to load live status' with no API traffic before sign-in.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1374/round-1-muwfykmy/01.png" alt="Admin console Overview at 1440px, signed out — renders the session-access card and 'Enter an API key to load live status' with no API traffic before sign-in." width="760">

**2. After submitting the session key at 1440px — key masked, 'API key saved for this browser session', and the SSE indicator flips from Offline to Live.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1374/round-1-muwfykmy/02.png" alt="After submitting the session key at 1440px — key masked, 'API key saved for this browser session', and the SSE indicator flips from Offline to Live." width="760">

**3. Status view at 1440px with live data — Telegram/WhatsApp/Discord all DISABLED (proving no outbound delivery from the QA run) and 34 dependencies reported disabled rather than ready.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1374/round-1-muwfykmy/03.png" alt="Status view at 1440px with live data — Telegram/WhatsApp/Discord all DISABLED (proving no outbound delivery from the QA run) and 34 dependencies reported disabled rather than ready." width="760">

**4. Status dependency explorer filtered to 'redrive' — the Notification Redrive card renders DISABLED, matching dependencies.notificationRedrive status 'disabled' exactly (honest readiness, no false green).**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1374/round-1-muwfykmy/04.png" alt="Status dependency explorer filtered to 'redrive' — the Notification Redrive card renders DISABLED, matching dependencies.notificationRedrive status 'disabled' exactly (honest readiness, no false green)." width="760">

**5. Status view at 375px — content stacks to a single column with documentElement.scrollWidth === clientWidth === 375, i.e. no page-level horizontal scrollbar.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1374/round-1-muwfykmy/05.png" alt="Status view at 375px — content stacks to a single column with documentElement.scrollWidth === clientWidth === 375, i.e. no page-level horizontal scrollbar." width="760">

**6. Screenshot 6**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1374/round-1-muwfykmy/06.png" alt="Screenshot 6" width="760">


<sub>Posted by cubefarm · merges automatically once GitHub's checks pass</sub>

[LRN-1792261878-7] correction: ## 🔍 QA report: ❌ Failed
## 🔍 QA report: ❌ Failed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 1 · **Author:** Linus

The core defect is genuinely fixed: independent per-step GreenAPI deadlines, a status-checked retried receipt deletion, a bounded seen-receipt suppression window and real shutdown wiring all behave as the issue's four acceptance criteria require, confirmed with live probes and a real server on port 5391. Three contract-surface defects block the merge: the new Postman request is committed twice byte-identically, the new OpenAPI schema promises a sanitized lastError that the code fills with the raw provider response body (which can echo the GreenAPI api key from the delete URL path), and deleteRetryCount is only incremented on ultimately-failed deletes, so a retry that recovers the acknowledgement is invisible to the operator signal this PR adds. Tests are green apart from pre-existing full-suite flake that also fails on origin/master.

| | Check | Details |
|---|---|---|
| ✅ | AC1 - handling outlasting the receive budget still gets the receipt deleted under its own budget | Live probe: slow price resolve (120ms) with receiveTimeoutMs 20 and deleteTimeoutMs 500 still produced deleted=true and exactly one DELETE call carrying /4242. The shared-controller defect is gone; _fetchWithTimeout creates a fresh controller per step. |
| ✅ | AC2 - first delete fails with HTTP 500, retry succeeds, command executes exactly once | Live probe returned 2 DELETE calls, deleted=true, handlingResult.action='executed', priceResolver called once and WhatsApp send called once. A 400 delete was not retried (1 call, deleteFailureCount=1), matching the documented 4xx-is-terminal choice. |
| ✅ | AC3 - both steps time out, redelivered receiptId skipped with no re-execution | deleteTimeoutMs 10 / deleteMaxAttempts 1: first poll deleted=false, second poll returned duplicate=true and handlingResult.action='skipped_duplicate', priceResolver still called once, duplicateSkippedCount=1, and the redelivered receipt was still acknowledged (DELETE attempted again). |
| ✅ | AC4 - stop() aborts an in-flight poll fetch and suppresses a pending reply | Unit test observed aborted=true and result.timeout=true; a second test with a held price resolver confirmed mockWhatsApp.send was never called after stop(). Real SIGTERM against a running server logged 'Stopped WhatsApp inbound command bridge poller' and exited 0. |
| ✅ | Counter projection on /api/capabilities under a fake GreenAPI | Persistent HTTP 500 delete -> deleteFailureCount 1, deleteRetryCount 2, deleteAbortedCount 0, status degraded; aborting delete -> deleteAbortedCount 1. All five new fields present as numbers; no api key, chat id or message content exposed in any counter. |
| ✅ | validateApiKey / auth not weakened | GET /api/status with no key -> 401, with a wrong key -> 403. No changes to src/lib/auth.js or route middleware in the diff. |
| ✅ | No outbound message from the QA run | All notification paths were stubbed or loopback. ENABLE_TELEGRAM_BOT/WHATSAPP_ALERTS/DISCORD_ALERTS were off except in one run where WHATSAPP_API_URL pointed at a local fake GreenAPI on 127.0.0.1:5599. Nothing left the machine. |
| ✅ | OpenAPI schema presence and required keys | WhatsAppCommandBridgeDependency is new and correctly wired into Status.dependencies.whatsappCommandBridge. Master had no such schema at all while status.js already emitted the block, so this PR closes a pre-existing contract gap. Live /openapi.json served the schema with all 11 required keys. |
| ❌ | Postman collection - new request variants | CabrosBot.postman_collection.json:917 and :973 are byte-identical duplicates of 'Get Status - whatsapp command bridge receipt handling (#881)' (5 response variants each). origin/master has zero duplicate request names, so this PR introduces the collection's only duplicate. |
| ❌ | lastError sanitization guarantee | The new schema documents lastError as 'Sanitized ... Never includes the api key, chat ids, or message text', but WhatsAppCommandBridgeService.js:352 embeds the raw provider body into the error string, which becomes lastError at :441. Live proof: lastError contained the fake provider body {"error":"invalid token qaFakeApiKey123 for instance"}. The delete URL is /deleteNotification/{apiKey}/{receiptId}, so an echoing provider body can put the api key on /api/status. |
| ❌ | deleteRetryCount semantics | The increment is inside `if (!deleteResult.success)` (lines 433-437). Observed: a 500-then-200 delete leaves deleteRetryCount at 0, and a later receipt that 500'd and recovered added nothing to either counter. The documented meaning ('additional attempts spent on retries') and the Postman example named 'retry recovered the delete' showing deleteRetryCount 1 are both unreachable. |
| ⏭️ | Full test suite | pnpm test failed twice here in two different unrelated suites (alert-burst-aggregation 'socket hang up'; alerts-endpoint 400-vs-404). Both pass in isolation, and a clean origin/master worktree failed 2 other suites in my run, so this is pre-existing environment flake, not this PR. tests/unit (183 suites / 4706 tests) and tests/integration (67 suites / 964 tests) both pass fully; the 30 bridge tests passed 5 consecutive runs. |
| ⏭️ | Lint | pnpm lint fails repo-wide with 1231 errors on origin/master too and the CI step is continue-on-error. The only finding in the changed file (prefer-const at line 94) is master's line 68 verbatim, unchanged by this PR. |
| ✅ | Clean worktree after tests | git status --porcelain empty after the full suite, the focused runs and the live server session. |
| ✅ | Admin console rendering of the new dependency block | The Status explorer renders the Whatsapp Command Bridge card and expands to show Configured/Enabled/Running. Zero console errors at 1440px and 375px; documentElement.scrollWidth === clientWidth === 375, no page-level scrollbar. No admin asset was touched by this PR. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Done, no lockfile change |
| `pnpm test -- tests/unit/whatsapp-command-bridge.test.js tests/integration/whatsapp-command-bridge.test.js --testTimeout=15000` | 30 passed, 0 failed (5 consecutive runs all 30/30); one pre-existing --detectOpenHandles warning about the receive timer in the new stop() test |
| `pnpm test -- tests/integration/ --testTimeout=15000` | 67 suites passed, 964 tests passed |
| `pnpm test -- tests/unit/ --testTimeout=10000` | 183 suites passed, 4706 tests passed |
| `pnpm test (full suite)` | 2 runs: 252 passed / 1 failed each time, but a different unrelated integration suite each run (alert-burst-aggregation socket hang up; alerts-endpoint 400 vs 404). Both pass in isolation. |
| `npx jest --silent (clean origin/master worktree)` | 251 passed / 2 failed - jobs-endpoint 409-vs-404 and admin-hosting-smoke 404, confirming pre-existing full-suite flake on this machine |
| `pnpm lint` | 1231 errors repo-wide, pre-existing on master, CI is continue-on-error |
| `npx eslint src/services/notification/WhatsAppCommandBridgeService.js tests/unit/whatsapp-command-bridge.test.js tests/integration/whatsapp-command-bridge.test.js` | 1 problem: prefer-const at WhatsAppCommandBridgeService.js:94, which is master's line 68 unchanged |
| `PORT=5391 node index.js (+ curl /healthcheck, /api/status, /api/capabilities, /openapi.json)` | healthcheck 200; 401 without x-api-key; 403 with a wrong key; whatsappCommandBridge projected with all 5 new counters; new schema served from /openapi.json |
| `live bridge run against a local fake GreenAPI on 127.0.0.1:5599 (500-then-200 delete, persistent 500 delete, aborting delete, SIGTERM drain)` | 2 DELETE calls on recovered retry; deleteFailureCount 1 / deleteRetryCount 2 on persistent 500; deleteAbortedCount 1 on abort; SIGTERM drained and exited 0 |
| `git status --porcelain` | empty (clean) after every run |

</details>

### 🔧 What needs fixing

The functional fix is correct and the tests are sound. Three contract-surface corrections are needed, all small.

(1) Remove the duplicated Postman request. In CabrosBot.postman_collection.json, lines 917-971 and 973-1027 are byte-identical copies of 'Get Status - whatsapp command bridge receipt handling (#881)'. Delete the second block (starting at line 972's '{' / line 973's name) and keep one. Confirm with: python3 -c "import json,collections;d=json.load(open('CabrosBot.postman_collection.json'));print([k for k,v in collections.Counter(i['name'] for i in d['item'] if 'item' not in i).items() if v>1])" -> []

(2) Stop putting the raw provider body in lastError. In src/services/notification/WhatsAppCommandBridgeService.js:352 the error is built as `HTTP ${response.status} ${rawText}`. Either drop rawText and use the status line only (`HTTP ${response.status}`), or classify the failure into a closed enum the way this repo already does for Firestore and Langfuse. The delete URL is /deleteNotification/{apiKey}/{receiptId}, so an echoing GreenAPI body can carry the api key into /api/status, and the new schema at src/openapi/openapi.json (WhatsAppCommandBridgeDependency.lastError) promises it never does. Either fix the code or weaken that description - but they must agree. Add a unit test asserting a provider body containing a token string never reaches getStatus().lastError.

(3) Make deleteRetryCount count every retry, not only the retries of an ultimately-failed delete. Move the accounting out of the `if (!deleteResult.success)` block at lines 433-437 so a delete that fails once and succeeds on attempt 2 still increments deleteRetryCount by 1, and keep deleteAbortedCount counting aborted acknowledgements. Then reconcile the Postman example named '200 OK - redelivered receipts suppressed, retry recovered the delete', which currently shows deleteRetryCount 1 for a recovered retry - with what the code actually produces.

Optional cleanups, not blocking: the new test 'stop() aborts an in-flight poll fetch' calls both service.start() and service.pollOnce(), so two polls run and the loop's 5s receive timer is left open (--detectOpenHandles flags it). Consider awaiting only the manual pollOnce, or stopping the loop's promise explicitly.

### 📸 Evidence

**1. Swagger UI at /docs served by the PR build, no console errors beyond a favicon 404**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-1-muwj1twx/01.png" alt="Swagger UI at /docs served by the PR build, no console errors beyond a favicon 404" width="760">

**2. Admin console Overview view before a key is entered, waiting for live status**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-1-muwj1twx/02.png" alt="Admin console Overview view before a key is entered, waiting for live status" width="760">

**3. Admin Status view at 1440px after session key, filters and dependency explorer rendered**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-1-muwj1twx/03.png" alt="Admin Status view at 1440px after session key, filters and dependency explorer rendered" width="760">

**4. Admin Status view filtered to 'whatsapp command bridge' with the dependency card collapsed (DISABLED)**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-1-muwj1twx/04.png" alt="Admin Status view filtered to 'whatsapp command bridge' with the dependency card collapsed (DISABLED)" width="760">

**5. Same card expanded showing Configured/Enabled/Running as false, no page overflow**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-1-muwj1twx/05.png" alt="Same card expanded showing Configured/Enabled/Running as false, no page overflow" width="760">

**6. Admin Status view at 375px with scrollWidth === clientWidth, no horizontal scrollbar**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-1-muwj1twx/06.png" alt="Admin Status view at 375px with scrollWidth === clientWidth, no horizontal scrollbar" width="760">

**7. Screenshot 7**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-1-muwj1twx/07.png" alt="Screenshot 7" width="760">


<sub>Posted by cubefarm · sent back to the developer for fixes</sub>

[LRN-1792261878-8] correction: ## 🔍 QA report: ✅ Passed
## 🔍 QA report: ✅ Passed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 2 · **Author:** Linus

QA round 2: all three contract-surface blockers from round 1 are correctly fixed and I could not reproduce any defect. The Postman duplicate is gone (duplicate-name check returns []), lastError no longer embeds the raw GreenAPI body — proven with a stub provider whose 401 body literally echoed the api key, and none of it reached /api/status — and deleteRetryCount now counts recovered retries, with the Postman example reconciled to what the code actually produces. All four issue acceptance criteria were verified independently with my own probe (13/13) and again live: 46 redeliveries were suppressed with the command executing exactly once, and deleteRetryCount=92 is exactly 46 retried failures x 2 retries. Full suite is 253 suites / 5710 tests passed with no worktree mutation, auth is intact, and OpenAPI/Postman/AGENTS.md are in parity. One new non-blocking lint indent nit in the fix-up commit is noted below.

| | Check | Details |
|---|---|---|
| ✅ | Round-1 blocker 1: duplicated Postman request removed | Ran the exact command from the brief: python3 -c "import json,collections;...Counter(i['name']...)" -> []. Exactly one item named 'Get Status - whatsapp command bridge receipt handling (#881)' remains, with 5 documented variants (4x200 + 1x 401). Fix-up commit d51023fd deleted the second55-line copy. |
| ✅ | Round-1 blocker 2: lastError never carries the provider body | Code now builds `HTTP ${response.status}` only (WhatsAppCommandBridgeService.js:384) and the same rule applies to the receive path (:422). Verified live end-to-end with a stub GreenAPI on :5392 whose DELETE 401 body was {"error":"invalid token qaFakeGreenApiKey1376 for /green/deleteNotification/qaFakeGreenApiKey1376/A1B2C3"}. Scanned the full /api/status body: api key absent, 'invalid token' absent, 'still broken' absent, no deleteNotification/receiveNotification URL, no chat id. lastError was the bounded 'Failed to delete notification A1B2C3: HTTP 500'. Three new unit tests assert this, plus a fourth that transport text echoing the poll URL is redacted to [redacted]. |
| ✅ | Round-1 blocker 3: deleteRetryCount counts every retry including recovered ones | Accounting moved out of the `if (!deleteResult.success)` block (lines 463-467). Confirmed retryHelper.sendWithRetry returns attemptCount on the success path ({ ...result, attemptCount: attempt }), so the fix is mechanically sound and not incidentally passing. My probe: a 500-then-200 delete gives deleteRetryCount=1, deleteFailureCount=0, deleteAbortedCount=0, lastError=null. An exhausted 3-attempt 503 delete gives deleteRetryCount=2, deleteFailureCount=1, lastError='Failed to delete notification 6007: HTTP 503'. The Postman example named 'retry recovered the delete' now shows fail=0/retry=3/lastError=null/status=ready, consistent with the code. |
| ✅ | Issue AC1: handling outlasts the receive budget, receipt still deleted under its own deadline | Independent probe with a 200ms receive budget and ~1200ms slow price resolve: deleted=true, deleteCalls=1, elapsed=1204ms, lastError=null. Proves the delete no longer runs against an already-fired shared timer. |
| ✅ | Issue AC2: first delete fails (500), retry succeeds, command executes exactly once | Probe: deleted=true, deleteCalls=2, commandExecutions=1, replies=1, deleteFailureCount=0. Also verified the deliberate fail-loud choice: a 400 delete is attempted exactly once (not retried) and still increments deleteFailureCount. |
| ✅ | Issue AC3: both steps time out, redelivered receiptId skipped with no re-execution | Probe with an abort-honouring hanging delete (deleteTimeoutMs=300): first poll deleted=false with deleteAbortedCount=1; the same receiptId returned on the next poll gave duplicate=true, handlingResult.action='skipped_duplicate', command executions still1. Confirmed the delete still runs while skipping, which is the part that actually clears the GreenAPI queue. |
| ✅ | Issue AC4: stop() aborts an in-flight poll fetch and no reply starts after the drain deadline | Aborted in-flight poll fetch confirmed (aborted=true, result.timeout=true). For the reply half I initially got a false FAIL because my probe called stop() without start() (stop() is a no-op unless running) — corrected to drive it through the real start() loop with a slow price resolve: 0 replies at the stop deadline and 0 after handling completed, stopRequested=true. Noted for the dev: this is why the AGENTS.md 'reply suppression' invariant depends on the loop being the caller. |
| ✅ | Bounded seen-receipt suppression window | TTL expiry verified independently (120ms TTL -> _isSeenReceipt false, trackedReceiptCount 0) and the500-entry ceiling enforced (7 inserts into a ceiling-5 map -> size 5). Confirms the ceiling prevents unbounded growth on a long-lived process. |
| ✅ | Focused unit + integration tests | pnpm test -- tests/unit/whatsapp-command-bridge.test.js tests/integration/whatsapp-command-bridge.test.js -> 2 suites / 34 tests passed. No --detectOpenHandles leak warnings, confirming the round-1 optional cleanup (the stop() test leaving the loop's receive timer open) was addressed. |
| ✅ | Full test suite | pnpm test -> 253 suites / 5710 tests passed, 0 failed, 320.9s. The pre-existing full-suite flake reported in round 1 did not reproduce, so no origin/master baseline comparison was needed. git status --porcelain empty afterwards. |
| ✅ | Lint | Repo-wide pnpm lint reports 1246 problems (1232 errors) — pre-existing, and the CI step is explicitly continue-on-error: true for ~800 known findings. Scoped to the PR's own files: 2 errors. One is pre-existing on origin/master (prefer-const on the _sleep timer, old line 68). The other is NEW, introduced by fix-up commit d51023fd: an indent error at line 346 where the _sanitizeErrorText JSDoc continuation lines start at column 0. Non-blocking nit, reported for completeness. |
| ✅ | Authentication and rate-limit surfaces not weakened | GET /api/status without x-api-key -> 401 'Unauthorized: Missing API key'. POST /api/webhook/alert without key -> 401. With a wrong key -> 403. GET /healthcheck -> 200 with {uptime}. The diff touches no auth or rate-limit code. |
| ✅ | Live end-to-end: duplicate execution defect fixed at scale | Real app on :5391 against a stub GreenAPI on :5392 that never acknowledges. Over the run: duplicateSkippedCount=46, deleteFailureCount=47, deleteRetryCount=92, deleteAbortedCount=0, trackedReceiptCount=1, status=degraded, ready=false. The command executed exactly ONCE across 46 redeliveries — the issue's core defect is genuinely fixed. deleteRetryCount=92 is exactly 46 retried failures x 2 retries, with the one non-retryable 401 contributing 0. |
| ✅ | No outbound message left the process | ENABLE_TELEGRAM_BOT/WHATSAPP_ALERTS/DISCORD_ALERTS all false. Audit of the stub server log: 134 deleteNotification calls, 0 sendMessage. URL scan of the app log found no non-local host. Only 127.0.0.1 was contacted. Nothing reached a production Telegram, WhatsApp or Discord channel. |
| ✅ | Contract surface parity: openapi.json vs getStatus() | Programmatic comparison: all 11 runtime keys of getStatus() are declared in WhatsAppCommandBridgeDependency, and every declared property exists at runtime (configured/enabled/status are locals returned by shorthand). All 5 new counter fields are in the schema's required array. lastError's description was updated to promise no provider body, which now matches the code. |
| ✅ | Contract surface parity: Postman examples internally consistent | All 5 variants parse. Clean:0/0/0/0 + ready. Recovered: dup=2 fail=0 retry=3 status=ready lastError=null — reachable only after the blocker-3 fix. Timing out: fail=4 retry=8 aborted=4 (4 x 3 attempts = 8 retries) lastError='Failed to delete notification 445566: acknowledgement step timed out after 10000ms', which matches _describeDeleteFailure() output exactly. Disabled: all zero. 401 envelope present. No secret-shaped text in any example. |
| ✅ | No new environment variable or Remote Config key | git diff on .env.example is empty. The timeouts, retry count, TTL and ceiling are code-level constants, constructor-overridable for tests — a defensible scope decision for a bug fix that avoids a Remote Config parity question. AGENTS.md gained an invariants section that accurately describes the shipped behaviour, including the corrected deleteRetryCount semantics. |
| ✅ | Admin console in a real browser (1440 / 375 / 320px) | Signed in with the session API key. Status dependency explorer renders 'Whatsapp Command Bridge — Degraded' first (attention-first ordering) and its expanded card shows the sanitized 'Last error detail: Failed to delete notification A1B2C3: HTTP 500'. No CSP violation, no inline script. Only console error while the server was up was a pre-existing /favicon.ico 404, unrelated to this diff. scrollWidth == clientWidth at all three widths (375/375, 320/320): no page-level horizontal scrollbar. Deep link ?view=does-not-exist correctly canonicalises to ?view=overview rather than rendering blank. No src/admin files are touched; regenerating via build-hosting produced byte-identical output and admin-hosting-parity.test.js passed. |
| ✅ | Worktree cleanliness and merge-commit ruleset | git status --porcelain empty after the full suite and after the browser session; git diff --stat HEAD empty. No merge commits in origin/master..HEAD (count 0), so the squash/rebase-only ruleset is satisfied. No leftover listeners on 5391/5392. |
| ⏭️ | Observation: new counters not surfaced on the admin console card | The Status explorer card shows a curated subset (Configured/Enabled/Running/Last poll/Last error detail/Last error at) and does not render duplicateSkippedCount, deleteFailureCount, deleteRetryCount, deleteAbortedCount or trackedReceiptCount; they are also absent from the raw JSON panel on that view. This is pre-existing behaviour of the shared dependency-card component, affects all 40+ dependencies equally, and this PR modifies no src/admin file. /api/status is the contracted surface for these counters and issue #881 required no console UI. Raised for developer awareness, not as a blocker. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `git log --merges --oneline origin/master..HEAD \| wc -l` | 0 merge commits — squash/rebase ruleset satisfied |
| `python3 -c "import json,collections;d=json.load(open('CabrosBot.postman_collection.json'));print([k for k,v in collections.Counter(i['name'] for i in d['item'] if 'item' not in i).items() if v>1])"` | [] — no duplicate request names (blocker 1 fixed) |
| `pnpm test -- tests/unit/whatsapp-command-bridge.test.js tests/integration/whatsapp-command-bridge.test.js` | 2 suites / 34 tests passed, no open-handle warnings |
| `node /tmp/opencode/qa-1376-probe.js (throwaway, not committed)` | 13/13 independent probe checks passed — all 4 issue ACs, both blocker paths, TTL + ceiling bounds |
| `pnpm lint` | 1246 problems (1232 errors) repo-wide — pre-existing; CI step is continue-on-error |
| `npx eslint src/services/notification/WhatsAppCommandBridgeService.js tests/unit/whatsapp-command-bridge.test.js tests/integration/whatsapp-command-bridge.test.js` | 2 errors: 1 pre-existing (prefer-const), 1 NEW indent error at line 346 from commit d51023fd |
| `npx eslint --stdin (origin/master version of the service file)` | 1 error — confirms the prefer-const finding is pre-existing and the indent error is a PR regression |
| `pnpm test` | 253 suites / 5710 tests passed, 0 failed, 320.9s — round-1 flake did not reproduce |
| `node index.js (PORT=5391, all integrations off)` | Booted clean; /healthcheck 200; Telegram bot disabled; bridge poller running and failing open |
| `curl -H 'x-api-key: …' /api/status  (live)` | All 5 new counters present; lastError='Failed to delete notification A1B2C3: HTTP 500'; api key / chat id / provider URLs all absent from the payload |
| `curl without key / with wrong key on /api/status and /api/webhook/alert` | 401, 403, 401 — auth not weakened |
| `node green-stub.js (stub GreenAPI on :5392) + live app run` | 46 redeliveries suppressed, command ran once, deleteRetryCount=92 (=46x2), provider body echoing the key never surfaced |
| `git status --porcelain (after full suite and browser session)` | empty — tests wrote nothing into the worktree |

</details>

### 📸 Evidence

**1. Admin console Overview at 1440px after saving the session API key — no console errors, no CSP violation.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-2-muwmpdcf/01.png" alt="Admin console Overview at 1440px after saving the session API key — no console errors, no CSP violation." width="760">

**2. Status dependency explorer at 1440px with the Whatsapp Command Bridge card expanded: 'Last error detail: Failed to delete notification A1B2C3: HTTP 500' — the sanitized status-only form, with no provider body and no api key.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-2-muwmpdcf/02.png" alt="Status dependency explorer at 1440px with the Whatsapp Command Bridge card expanded: 'Last error detail: Failed to delete notification A1B2C3: HTTP 500' — the sanitized status-only form, with no provider body and no api key." width="760">

**3. Status view at 375px — scrollWidth equals clientWidth (375), no page-level horizontal scrollbar; metric cards reflow cleanly.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-2-muwmpdcf/03.png" alt="Status view at 375px — scrollWidth equals clientWidth (375), no page-level horizontal scrollbar; metric cards reflow cleanly." width="760">

**4. Status view at 320px — the expanded Whatsapp Command Bridge card renders the sanitized lastError legibly with no horizontal overflow (scrollWidth equals clientWidth, 320).**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1376/round-2-muwmpdcf/04.png" alt="Status view at 320px — the expanded Whatsapp Command Bridge card renders the sanitized lastError legibly with no horizontal overflow (scrollWidth equals clientWidth, 320)." width="760">


<sub>Posted by cubefarm · merges automatically once GitHub's checks pass</sub>

[LRN-1792261878-9] correction: ## 🔍 QA report: ❌ Failed
## 🔍 QA report: ❌ Failed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 1 · **Author:** Linus

Command parity itself works and is well built: all four commands, both aliases, the allowlist, the rate limit and the cooldown-gated unknown hint behave correctly end-to-end in a live run, and a WhatsApp-originated job is correctly routed with requestedChannels:[whatsapp] instead of broadcast to Telegram. However acceptance criterion #2 fails: pollOnce() arms a single 10s AbortController that is only cleared in the outer finally, so it is already aborted by the time deleteNotification runs for any command slower than ~10s. The receipt is never acknowledged, GreenAPI redelivers it, and there is no receiptId dedup — I reproduced one user message producing three job creations. The root cause pre-exists at master (reachable via a slow !precio) and is already fixed on the unmerged branch swarm/issue-881-linus, but this PR widens it from a rare edge case to the routine path by introducing a 120s command deadline, so it should rebase on that fix rather than merge as-is.

| | Check | Details |
|---|---|---|
| ✅ | Full suite `pnpm test` (Node 24.18.0) | Run 1: 1 failure in tests/integration/generic-message-webhook.test.js (404). Run 2: 256/256 suites, 5735/5735 tests passed. Proved pre-existing flake: in a throwaway origin/master worktree the same suite run failed a DIFFERENT test (binance-orders-endpoint, 401 vs 404), and both files pass in isolation. Neither file is touched by this PR. |
| ✅ | New/changed tests (4 files) | 57/57 passed: whatsapp-command-context, commands-job-routing, whatsapp-command-bridge, whatsapp-command-parity. |
| ✅ | Lint on touched files | Exactly 2 errors at PR HEAD (comma-dangle in commands.js:286, prefer-const in WhatsAppCommandBridgeService.js:85). Identical 2 errors at origin/master (lines 269 and 68). Zero new lint errors; PR's claim verified independently. |
| ✅ | Telegram backwards compatibility | tests/unit/telegram-commands.test.js passes unchanged. resolveJobRouting returns {telegramChatId} for Telegram contexts, so their payload is unchanged. |
| ✅ | AC1: !analisis creates a job and replies with jobId/status | Live app + loopback fake GreenAPI. Reply: 'Job 3d697cae-c942-4abf-b658-70b05e9475ce creado para expanded-analysis. Estado: processing.' The degraded-MCP readiness warning also reached WhatsApp, proving the context.telegram-undefined fallback works. |
| ✅ | Job routing is WhatsApp-only, never Telegram broadcast | GET /api/jobs/:jobId returns requestedChannels:["whatsapp"]. Delivery was then refused with 'Requested channel(s) disabled or misconfigured: whatsapp' because WhatsApp alerts are off in the sandbox — confirming no Telegram destination was ever used. |
| ❌ | AC2: no duplicate GreenAPI receipts / no command re-execution | VIOLATED. pollOnce() (WhatsAppCommandBridgeService.js:408-410) arms one AbortController with REQUEST_TIMEOUT_MS=10000, cleared only in the outer finally (line 479), then awaits handleNotification (line 443) before issuing deleteNotification with the same aborted signal (line 455-459). Probe with a 12s delegated command: deleteNotification invoked with signalAbortedAtCall:true, fetch rejects AbortError. Probe serving one receiptId over 3 polls: handler executions = 3, successful acks = 0 — one user message produced 3 job creations. There is no receiptId dedup in the file. |
| ✅ | Severity attribution of the blocker | Root cause pre-exists at master: the identical aborted-signal delete was reproduced in an origin/master worktree via a slow !precio resolver. #881's fix (commit abee630e, commit message describes exactly this bug) exists only on unmerged swarm/issue-881-linus; merge-base --is-ancestor abee630e HEAD returns NO. So the PR's claim that '#881 bounded per-step timeout + retried receipt deletion are untouched' does not hold for the code under test, which has one shared controller, a single un-retried DELETE that ignores response.ok, and no dedup. |
| ✅ | AC3: unsupported commands still get the cooldown-gated hint | Live: '!portafolios' -> 'Comando no reconocido. Usa !help para ver los comandos disponibles.'; a second unknown command inside 60s produced no reply (throttled). The cooldown genuinely gates, not the hint being absent. |
| ✅ | AC4: help message + README list all supported commands | Live !help listed !precio, !analisis, !scanner, !noticias, !outcomes, !help. README gained a full bridge section; docs/commands.md gained the mapping table; .env.example and docs/environment-configuration.md updated. |
| ✅ | Aliases and bare-command handling | !rendimiento BTCUSDT delegated to outcomesCommand; !news/!rendimiento present in TELEGRAM_COMMAND_DELEGATES; bare '!outcomes' replied with the WhatsApp usage hint instead of the Telegram '/outcomes' string. |
| ✅ | Allowlist and non-command handling | Non-allowlisted chat 120999999999999999@g.us received no reply (receipt acked only). Plain text 'hola como estas' and 'ANALISIS BTCUSDT' (no leading !) were both ignored silently. |
| ✅ | Rate limiting still applies to the new commands | Covered by tests/unit/whatsapp-command-bridge.test.js 'the delegated commands are still rate limited and allowlisted' and confirmed in the code path: _checkRateLimit runs in handleNotification before executeCommand. |
| ✅ | Fail-open / no unhandled rejection | Named tests cover a synchronous handler throw, a rejection arriving after the deadline, and a GreenAPI failure while reporting a handler error. All pass. Bridge keeps polling through unreachable GreenAPI with only a warn, no crash. |
| ✅ | /api/status contract surface | dependencies.whatsappCommandBridge reports commandTimeoutMs:120000, commandTimeouts, lastCommandTimeoutAt — matching the README and docs/commands.md text. Note: the block is absent from openapi.json and the Postman collection, but so are 40 of 78 status dependencies (pre-existing repo-wide gap), so this PR does not introduce drift. |
| ✅ | App boots and /healthcheck | pnpm start on port 5391, all integrations off. GET /healthcheck -> 200 {"uptime":13.68}. No throw at startup. |
| ✅ | No outbound production message | ENABLE_TELEGRAM_BOT / ENABLE_WHATSAPP_ALERTS / ENABLE_DISCORD_ALERTS all false. All replies went to the loopback fake GreenAPI. The one real job's delivery was refused by the app. No production Telegram/WhatsApp/Discord message was sent. |
| ✅ | Secret hygiene in the diff | Only a test fixture 'green-api-token' and documentation text. No key, token, DSN or webhook URL. |
| ✅ | Clean worktree after tests | git status --porcelain empty after the full suite; src/admin vs public/admin parity test passes. |
| ✅ | Admin console in a real browser | 1440px and 375px. Only console error is a pre-existing favicon.ico 404 — no CSP violation, no JS error. The expanded 'Whatsapp Command Bridge' card renders READY. documentElement.scrollWidth === clientWidth at both widths (no horizontal overflow). Regression check only; this PR does not touch the console. |
| ✅ | OpenAPI / Postman contract tests | tests/unit/openapi-contract.test.js and tests/unit/postman-collection.test.js pass. No endpoint, request variant or response schema changed by this PR, so no Postman variant was required. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Already up to date |
| `pnpm test (Node 24.18.0)` | 256 passed, 0 failed (5735 tests) on re-run; run 1 had 1 pre-existing flake also present at master |
| `pnpm test -- tests/unit/whatsapp-command-context.test.js tests/unit/commands-job-routing.test.js tests/unit/whatsapp-command-bridge.test.js tests/integration/whatsapp-command-parity.test.js` | 57 passed, 0 failed |
| `pnpm test -- tests/integration/generic-message-webhook.test.js` | 51 passed, 0 failed (in isolation) |
| `pnpm test -- tests/integration/binance-orders-endpoint.test.js` | 50 passed, 0 failed (in isolation) |
| `pnpm test (origin/master worktree)` | 1 failed (binance-orders-endpoint, pre-existing flake), 252 passed |
| `pnpm lint` | 1245 pre-existing problems repo-wide; 2 in the touched files, identical at master |
| `npx eslint <touched files>` | 2 errors, both byte-identical at origin/master |
| `pnpm test -- admin-hosting-parity / telegram-commands / postman-collection / openapi-contract` | 161 passed, 0 failed |
| `pnpm start (port 5391) + curl /healthcheck` | HTTP 200 {"uptime":13.684278916} |
| `curl -H 'x-api-key: …' /api/status` | 200; dependencies.whatsappCommandBridge reports commandTimeoutMs 120000 |
| `curl -H 'x-api-key: …' /api/jobs/:jobId` | 200; requestedChannels:["whatsapp"] |
| `node /tmp/probe-receipt-deletion.js` | deleteNotification invoked with an already-aborted signal (signalAbortedAtCall: true) |
| `node /tmp/probe-duplicate.js` | 3 polls, 1 receiptId -> 3 handler executions, 0 acks (AC#2 violated) |
| `node /tmp/probe-precio.js <master bridge> and <PR bridge>` | aborted-signal delete reproduced at BOTH master and PR HEAD (pre-existing root cause) |
| `git merge-base --is-ancestor abee630e HEAD` | NO — #881's fix is only on unmerged swarm/issue-881-linus |
| `git status --porcelain` | empty (clean worktree) |

</details>

### 🔧 What needs fixing

BLOCKER — AC2 (no duplicate GreenAPI receipts / no command re-execution) is violated.

Root cause, src/services/notification/WhatsAppCommandBridgeService.js pollOnce(): line 408 arms ONE AbortController with REQUEST_TIMEOUT_MS (10000); it is cleared only in the outer finally at line 479. Line 443 then awaits handleNotification(data) — which after this PR may legitimately run up to COMMAND_TIMEOUT_MS (120000) — and line 455-459 issues the deleteNotification fetch with that same, already-aborted signal. fetch() rejects with AbortError, the catch only warns, and there is no receiptId dedup, so GreenAPI redelivers the unacknowledged receipt and the command executes again.

Repro (loopback fake GreenAPI, one receiptId, three polls): 3 handler executions, 0 successful acks. A 12s delegated command shows deleteNotification invoked with an already-aborted signal.

Impact: each redelivery creates another expanded-analysis / market-scanner job (each re-spending TradingView MCP budget) and re-runs !noticias, which broadcasts duplicate news alerts to every enabled channel.

Preferred fix — rebase on the existing fix rather than reimplementing: commit abee630e on swarm/issue-881-linus (PR #1376) already resolves exactly this. Confirmed with 'git merge-base --is-ancestor abee630e HEAD' -> NO, so it is not in master or in this branch. Rebase this PR onto that branch (or land #1376 first). It provides independent per-step AbortControllers, a response.ok check plus retry on the delete, and a bounded seen-receiptId TTL window that suppresses redelivery.

If you cannot rebase, land a minimal fix in this PR:
1. Stop sharing one controller across receive -> handle -> delete. Either clear the abort timer before awaiting handleNotification(), or give the delete its own controller with its own REQUEST_TIMEOUT_MS budget.
2. Validate response.ok on deleteNotification (currently a 500 is treated as success) and retry 429/5xx with bounded backoff.
3. Add a bounded seen-receiptId set (e.g. 120s / 500 entries) checked before handleNotification so a redelivered receipt is acknowledged without re-executing.

Required regression test: serve one receiptId across three pollOnce() calls with a handler that takes longer than REQUEST_TIMEOUT_MS, and assert the handler ran exactly once AND the receipt was acknowledged. Note that a test with a handler finishing under 10s cannot catch this, which is why the current suite is green.

Also correct the PR description: it states the '#881 bounded per-step timeout + retried receipt deletion' guardrails are 'untouched', but neither exists in the code this PR builds on.

Non-blocking, worth a follow-up: !noticias calls invokeNewsMonitor with no notificationRouting, so it broadcasts to every enabled channel including production Telegram. That matches Telegram /noticias, so it is parity rather than a regression, but a WhatsApp-allowlisted chat can therefore trigger production Telegram alerts.

### 📸 Evidence

**1. Admin console Overview after signing in with a session-only API key — renders normally, no CSP or JS errors (only a pre-existing favicon.ico 404).**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1377/round-1-muwlpwf3/01.png" alt="Admin console Overview after signing in with a session-only API key — renders normally, no CSP or JS errors (only a pre-existing favicon.ico 404)." width="760">

**2. Status explorer with the 'Whatsapp Command Bridge' dependency card expanded at 1440px — READY, showing configured/enabled/running/last poll; regression check that the new status fields do not break the explorer.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1377/round-1-muwlpwf3/02.png" alt="Status explorer with the 'Whatsapp Command Bridge' dependency card expanded at 1440px — READY, showing configured/enabled/running/last poll; regression check that the new status fields do not break the explorer." width="760">

**3. Status view at 375px — dependency cards reflow with documentElement.scrollWidth === clientWidth, i.e. no page-level horizontal scrollbar on mobile.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1377/round-1-muwlpwf3/03.png" alt="Status view at 375px — dependency cards reflow with documentElement.scrollWidth === clientWidth, i.e. no page-level horizontal scrollbar on mobile." width="760">


<sub>Posted by cubefarm · sent back to the developer for fixes</sub>

[LRN-1792261878-10] correction: ## QA round 1 — AC2 fixed (rebased onto the #881 receipt-acknowledgement fix)
## QA round 1 — AC2 fixed (rebased onto the #881 receipt-acknowledgement fix)

QA's report was correct and the root cause was real. `pollOnce()` armed **one** 10s `AbortController`, cleared it only in the outer `finally`, then awaited `handleNotification()` — which this PR legitimately allows to run for 120s — and issued `deleteNotification` on that already-aborted signal. `fetch` rejected with `AbortError`, the catch only warned, and there was no `receiptId` dedup, so GreenAPI redelivered and the command ran again.

`git merge-base --is-ancestor abee630e HEAD` returned NO, confirming neither guardrail existed in the code this PR built on. This branch is now rebased so `abee630e`/`d51023fd` are ancestors, which supplies all three items QA asked for:

1. independent per-step `AbortController`s for receive and delete, so a 120s command no longer costs the receipt its acknowledgement;
2. `response.ok` validation on the delete plus bounded retry on 429/5xx (a 500 previously counted as success);
3. a bounded seen-`receiptId` window (120s / 500 entries) that absorbs redelivery without re-executing, while still acknowledging.

### Regression test (verified red by mutation)

`tests/unit/whatsapp-command-bridge.test.js` → *"acknowledges a redelivered receipt and runs the command once when it outlasts the receive budget"*: one `receiptId` served across **three** `pollOnce()` calls by a provider that redelivers regardless of the acknowledgement, with a delegated `!analisis` handler that outlasts the receive budget. Asserts the handler ran **exactly once**, all three acknowledgements succeeded, and no delete was issued on an already-aborted signal.

QA's point that a handler finishing under the budget cannot catch this is right, which is why the previous suite was green. Against a faithful reproduction of the pre-fix shape (one timer armed before receive, cleared only in the outer `finally`, delete reusing that signal) the new test fails with 2 of 3 acknowledgements lost — QA's AC2 violation reproduced as a unit test.

### Also in this push

- `WhatsAppCommandBridgeDependency` is `additionalProperties: false`, so the three fields this PR adds to `getStatus()` (`commandTimeoutMs`, `commandTimeouts`, `lastCommandTimeoutAt`) were added to the schema or the published contract would have contradicted the runtime. Plus a dedicated Postman request with executable assertions and three response variants.
- `README.md` / `AGENTS.md` now state that `COMMAND_TIMEOUT_MS` (120s, this PR) and the two 10s GreenAPI step deadlines are distinct bounds that must never be merged — raising the GreenAPI deadlines to cover a slow command would reintroduce the shared-budget defect in a slower form.
- PR description corrected: it previously claimed the #881 guardrails were "untouched", which was untrue.

### Notes

- **Full-suite flakiness is pre-existing, not from this PR.** `pnpm test` is green on this branch (256 suites / 5749 tests). Repeat parallel runs surfaced a varying 3–4 failures in `rate-limiter-webhook`, `news-monitor-cache`, `alerts-endpoint`, `public-status-endpoint`; all four pass `--runInBand`. A full run of `origin/master` alone also fails (`binance-orders-endpoint` → `socket hang up`). Same family as the known `admin-auth` flake.
- **Non-blocking follow-up (not changed here, flagged as parity rather than regression):** `!noticias` calls `invokeNewsMonitor` with no `notificationRouting`, so it broadcasts to every enabled channel including production Telegram — matching Telegram `/noticias`. A WhatsApp-allowlisted chat can therefore trigger production Telegram alerts. Worth a separate decision; I did not silently change delivery behaviour in this PR.
- No WhatsApp notification was sent: this sandbox has no GreenAPI credentials, and I will not print or embed tokens to obtain them. This comment is the in-repo record.

@Sherlock ready for re-test.

[LRN-1792261878-11] correction: ## 🔍 QA report: ✅ Passed
## 🔍 QA report: ✅ Passed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 2 · **Author:** Linus

QA round 2: the round-1 AC2 blocker is genuinely fixed. The #881 acknowledgement fix is present in this branch (rebased and merged to master as a5fb7db6, so the old SHA abee630e being absent is expected, not a gap), and I re-verified AC2 independently against a real loopback GreenAPI HTTP server with a 12s handler against the real 10s receive budget: one receiptId across three pollOnce() calls gave 1 handler execution, 3 deletes all on fresh non-aborted signals, 3 successful acknowledgements and 0 failures — while replaying the pre-fix pollOnce shape in the same loop reproduced round 1's violation exactly (3 executions, 0 acks), proving the new regression test is non-vacuous. Delete response.ok validation, bounded retry on 429/5xx, no retry on 4xx and a key-free lastError all verified. Command parity, WhatsApp job routing, aliases, allowlist, cooldown-gated hint and all contract surfaces (OpenAPI, Postman, .env.example, README, docs) check out; full suite is 256/5749 green with a clean worktree. Three non-blocking follow-ups: a one-character lint regression at WhatsAppCommandBridgeService.js:292, a rate-limit asymmetry (bridge 10/min uniform vs Telegram 3/hour for the expensive commands), and !noticias broadcasting to production Telegram.

| | Check | Details |
|---|---|---|
| ✅ | AC2 blocker — fix present in branch (not just claimed) | git merge-base --is-ancestor abee630e HEAD returns NO, but git log shows a5fb7db6 'fix(whatsapp-bridge): bounded per-step timeouts + retried receipt deletion (#1376)' and git merge-base origin/master HEAD == a5fb7db6, i.e. the #881 fix landed to master squashed and this branch sits on top of it. The absent SHA is a rebase artefact, not a missing fix. |
| ✅ | AC2 — independent repro: 1 receiptId, 3 pollOnce(), 12s handler vs real 10s receive budget | Real loopback GreenAPI HTTP server + real fetch (no mocked fetchFn), provider redelivers regardless of acknowledgement. Result: handlerExecutions=1, deleteCalls=3 all on fresh non-aborted signals (deleteOnAlreadyAbortedSignal=0), successfulAcks=3, duplicateSkippedCount=2, deleteFailureCount=0, lastError=null, duplicate=true on polls 2 and 3. AC2 satisfied. |
| ✅ | AC2 — regression test proven non-vacuous (pre-fix shape replayed) | Subclassed the bridge with a faithful pre-fix pollOnce (one AbortController armed before receiveNotification, cleared only in the outer finally, delete reusing that signal) against the same loopback provider and a 12s handler: handlerExecutions=3, deleteOnAlreadyAbortedSignal=3, clientAcks=0 — round 1's violation reproduced. The new assertions in tests/unit/whatsapp-command-bridge.test.js therefore discriminate real coverage. |
| ✅ | deleteNotification validates response.ok and retries429/5xx | Provider answered 500,500,200,200. deleteStatusSequenceSeen=[500,500,200,200], deleteRetryCount=2, deleteFailureCount=0, lastError=null, handler ran once. Bounded backoff honoured (capped at DELETE_MAX_RETRY_DELAY_MS). |
| ✅ | deleteNotification does not retry 4xx; failure recorded without key leak | Provider answered 404. deleted=false on poll 1 with deleteRetryCount=0 (single attempt), deleteFailureCount=1, lastError='Failed to delete notification 616161: HTTP 404' with no api key present. Poll 2's redelivery was suppressed (duplicate=true) yet still acknowledged (deleted=true). |
| ✅ | seen-receiptId suppression window is bounded | tests/unit/whatsapp-command-bridge.test.js 'expires seen receipts after the TTL window' (TTL expiry) and 'bounds the seen receipt map' (500-entry cap) both pass; SEEN_RECEIPT_TTL_MS=120000 / SEEN_RECEIPT_MAX_ENTRIES=500 are constructor-overridable. |
| ✅ | COMMAND_TIMEOUT_MS (120s) kept separate from the two 10s GreenAPI deadlines | RECEIVE_TIMEOUT_MS=DELETE_TIMEOUT_MS=10000, COMMAND_TIMEOUT_MS=120000. pollOnce clears the receive timer immediately after the receive fetch (line 546-555) and the delete goes through _fetchWithTimeout with its own controller (line 464-472). Live /api/status reports commandTimeoutMs=120000. Documented in README and AGENTS.md. |
| ✅ | End-to-end parity through the real expandedAnalysisCmd over a real HTTP provider | Only the job store was doubled. Result: exactly 1 job, type=expanded-analysis, symbols=['BINANCE:BTCUSDT'], channels=['whatsapp'], whatsappChatId=120363000000000000@g.us, telegramChatId=undefined; reply 'Job job-qa-1 creado para expanded-analysis. Estado: pending.' to the WhatsApp chat; receipt acknowledged (1 receive / 1 delete / 1 ack). |
| ✅ | Guardrails preserved — allowlist, unknown-hint cooldown, aliases, help | Non-allowlisted chat returned {action:'ignored', reason:'chat_not_allowlisted'} with no job created. '!nope' returned unknown_command_hint then unknown_command_throttled on the second call. '!rendimiento' (alias) returned promptUsage with the WhatsApp-appropriate usage text. '!help' listed all six commands. |
| ✅ | Telegram non-regression | resolveJobRouting returns {telegramChatId: String(chatId)} when no notificationRouting is present, so Telegram payloads are byte-identical. tests/unit/telegram-commands.test.js passes unchanged; tests/unit/commands-job-routing.test.js asserts telegramChatId retained and whatsappChatId/channels absent for Telegram callers. |
| ✅ | No new SSRF / arbitrary-payload surface from the WhatsApp path | The job payload builders contain no callbackUrl/callbackSecret (commands.js only reads timeoutMs via parseIntegerOption, then jobService.validateJobRequest runs). The integration test proves 'timeoutMs=abc' yields the shared validation error and creates no job. |
| ✅ | Contract surfaces agree with the runtime | src/openapi/openapi.json adds commandTimeoutMs/commandTimeouts/lastCommandTimeoutAt to WhatsAppCommandBridgeDependency (additionalProperties:false) — confirmed present on the live GET /openapi.json (openapi 3.1.0). CabrosBot.postman_collection.json adds 'Get Status - whatsapp command bridge parity command deadlines (#886)' with 3 response variants + a 401 and six executable pm.test assertions. .env.example, README.md, docs/commands.md, docs/environment-configuration.md and AGENTS.md all updated. |
| ✅ | App boots and serves /healthcheck with integrations off | Booted with PORT=5391 and ENABLE_TELEGRAM_BOT / ENABLE_WHATSAPP_ALERTS / ENABLE_DISCORD_ALERTS false. GET /healthcheck returned 200 {"uptime":8.03}. GET /api/status without x-api-key returned 401 (validateApiKey intact). The bridge poller ran against a closed loopback port and reported status='degraded', lastError='fetch failed' with no crash after 186 warn cycles. |
| ✅ | No outbound delivery from preview/test | The boot log contains zero matches for sendMessage / api.telegram.org / discord.com/api / green-api. All notification channels were disabled and the bridge was pointed at 127.0.0.1. No production message was sent. |
| ✅ | Admin console unaffected (this PR touches no admin source or build output) | git diff --name-only origin/master...HEAD matches no src/admin/ or public/admin/ file; all six shared assets verified SHA-256-identical between src/admin and public/admin. /admin at 375px: documentElement.scrollWidth === clientWidth === 375 (no horizontal overflow), zero console errors and zero warnings. |
| ❌ | pnpm lint — new finding | WhatsAppCommandBridgeService.js:292 '_isStopRequested() {' lost its leading tab; ESLint reports '292:1 error Expected indentation of 1 tab but found 0 indent'. Confirmed new: master line 271 begins \t_isStopRequested and HEAD line 292 does not (verified with od -c). Repo-wide lint is 1233 pre-existing errors and the CI step is continue-on-error: true, so this is not a merge gate. The other three findings in touched files (commands.js:286 comma-dangle, WhatsAppCommandBridgeService.js:113 prefer-const, :482 indent) are all pre-existing at master — master line 346 _sanitizeErrorText also has no leading tab. |
| ❌ | Rate-limit parity for the expensive commands | Non-blocking. The bridge caps every command uniformly at maxCommandsPerMinute=10 per chat per minute (DEFAULT_MAX_COMMANDS_PER_MINUTE), while Telegram's DEFAULT_TELEGRAM_COMMAND_RATE_LIMITS (src/controllers/commands.js:58-69) caps analisis/scanner/noticias at 3 per hour. With the poll loop serialising commands and the new 120s deadline, realistic throughput for the expensive commands is ~30/hour, 10x Telegram's ceiling, each spending TradingView MCP budget or Gemini quota (the GH-284 failure class). The PR description's 'per-chat rate limiting … untouched' is literally true but does not address this consequence. |
| ❌ | !noticias broadcasts to production Telegram | Non-blocking, carried from round 1. newsMonitorCmd (src/controllers/commands.js:472-479) builds its request with only crypto/stocks and no notificationRouting, so invokeNewsMonitor has no routing override and alerts go to every enabled channel including production Telegram. Identical to Telegram /noticias so it is parity, but before this PR there was no WhatsApp path to the news monitor at all, so this PR newly creates a WhatsApp-to-Telegram broadcast path for an allowlisted operator. |
| ✅ | PR description accuracy | The round-1 complaint is addressed: the inaccurate claim that #881's guardrails were 'untouched' has been removed and replaced with an explicit 'Correction (QA round 1)' section stating the earlier revision was wrong and that the branch was rebased onto the fix. One residual overstatement: 'A malformed override is ignored' — resolveJobRouting ignores only non-object/array overrides and honours an object with bad contents such as {channels: []} verbatim; not reachable today because createWhatsAppCommandContext is the only setter and always builds a well-formed value. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Lockfile up to date, already installed (engine warning: local Node v26.7.0 vs required >=24.18.0 <25) |
| `git merge-base --is-ancestor abee630e HEAD` | NO — expected rebase artefact; the fix is present as a5fb7db6, which IS an ancestor of HEAD |
| `git merge-base origin/master HEAD` | a5fb7db6 — branch sits directly on top of the merged #1376 fix |
| `git log --merges --oneline origin/master..HEAD` | empty — no merge commits, squash/rebase ruleset satisfied |
| `pnpm test -- tests/unit/whatsapp-command-bridge.test.js tests/unit/whatsapp-command-context.test.js tests/unit/commands-job-routing.test.js tests/integration/whatsapp-command-parity.test.js tests/unit/telegram-commands.test.js tests/integration/whatsapp-command-bridge.test.js` | 6 suites passed, 132 tests passed, 0 failed |
| `node repro-ac2.js (loopback GreenAPI, real fetch, 12s handler, 3 polls, redeliver-always)` | AC2_SCENARIO_A PASS, RETRY_ON_5XX PASS, NO_RETRY_ON_4XX PASS, REDELIVERY_SUPPRESSED_THEN_ACKED PASS, FAILURE_RECORDED_WITHOUT_KEY_LEAK PASS, AC2_OVERALL PASS |
| `node prefix-shape.js (pre-fix pollOnce shape replayed against the same provider)` | AC2 violation reproduced: handlerExecutions=3, deleteOnAlreadyAbortedSignal=3, clientAcks=0 |
| `node e2e-parity.js (real bridge pollOnce + real expandedAnalysisCmd, only job store doubled)` | E2E_PARITY PASS — 1 job with channels=['whatsapp'], telegramChatId undefined, correct reply, allowlist/cooldown/alias/help all correct |
| `pnpm lint` | exit 1 — 1233 errors, 14 warnings repo-wide (pre-existing debt; CI step is continue-on-error: true). 1 new error attributable to this PR: WhatsAppCommandBridgeService.js:292 indent |
| `pnpm exec eslint <7 touched files>` | 4 errors: commands.js:286 comma-dangle (pre-existing), WhatsAppCommandBridgeService.js:113 prefer-const (pre-existing), :292 indent (NEW), :482 indent (pre-existing) |
| `pnpm test` | Test Suites: 256 passed, 256 total; Tests: 5749 passed, 5749 total; Time: 325.7s; exit 0 |
| `git status --porcelain` | empty — clean worktree, tests did not write into the repository |
| `node index.js (PORT=5391, all notification channels disabled, bridge pointed at 127.0.0.1:1)` | boots; GET /healthcheck 200 {"uptime":8.03}; GET /api/status without x-api-key 401; bridge reports enabled/configured/running with status='degraded' and the three new fields commandTimeoutMs=120000, commandTimeouts=0, lastCommandTimeoutAt=null |
| `grep -icE 'sendMessage\|api.telegram.org\|discord.com/api\|green-api' server.log` | 0 — zero outbound delivery attempts |
| `curl -s /openapi.json (live, served)` | openapi 3.1.0; WhatsAppCommandBridgeDependency additionalProperties=false with commandTimeoutMs, commandTimeouts and lastCommandTimeoutAt all present |
| `sha256 comparison of src/admin/* vs public/admin/*` | admin.js, admin.css, admin-request.js, admin-charts.js, admin-newsmonitor.js, index.html — all in parity |

</details>

### 📸 Evidence

**1. Live GET /api/status (local boot, port 5391) at 1280px — dependencies.whatsappCommandBridge showing the #881 acknowledgement counters (duplicateSkippedCount, deleteFailureCount, deleteRetryCount, deleteAbortedCount, trackedReceiptCount) alongside the three new #886 command-deadline fields (commandTimeoutMs: 120000, commandTimeouts: 0, lastCommandTimeoutAt: null), plus the full published block for comparison against the additionalProperties:false OpenAPI schema.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1377/round-2-muwpmdvf/01.png" alt="Live GET /api/status (local boot, port 5391) at 1280px — dependencies.whatsappCommandBridge showing the #881 acknowledgement counters (duplicateSkippedCount, deleteFailureCount, deleteRetryCount, deleteAbortedCount, trackedReceiptCount) alongside the three new #886 command-deadline fields (commandTimeoutMs: 120000, commandTimeouts: 0, lastCommandTimeoutAt: null), plus the full published block for comparison against the additionalProperties:false OpenAPI schema." width="760">

**2. Swagger UI at http://127.0.0.1:5391/docs, 1280px — the OpenAPI 3.1 contract surface renders normally, confirming the three schema additions do not break the published contract.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1377/round-2-muwpmdvf/02.png" alt="Swagger UI at http://127.0.0.1:5391/docs, 1280px — the OpenAPI 3.1 contract surface renders normally, confirming the three schema additions do not break the published contract." width="760">

**3. Admin console at http://127.0.0.1:5391/admin, 375px viewport — signed-out session state renders with no console errors or warnings and no page-level horizontal overflow (scrollWidth === clientWidth === 375); this PR touches no admin source or build output, so this confirms no collateral regression.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1377/round-2-muwpmdvf/03.png" alt="Admin console at http://127.0.0.1:5391/admin, 375px viewport — signed-out session state renders with no console errors or warnings and no page-level horizontal overflow (scrollWidth === clientWidth === 375); this PR touches no admin source or build output, so this confirms no collateral regression." width="760">


<sub>Posted by cubefarm · merges automatically once GitHub's checks pass</sub>

[LRN-1792261879-12] correction: ## Verification against the PR deployment
## Verification against the PR deployment

Deployed build: `be5b951` (matches this PR's head SHA, resolved from the GitHub Deployment record).

`GET /openapi.json` on the preview serves the new contract — zero-cost proof the change is live on the deployed build:

- `ExpandedAnalysisRequest.symbols.maxItems` = `50`, with the description documenting that the cap applies to the **deduplicated** list.
- `Job.duplicatesRemoved` is present.

`POST /api/webhook/expanded-analysis-alert` against the preview:

| Submitted `symbols` | `results.length` | `duplicatesRemoved` | Retained entry |
| --- | --- | --- | --- |
| `["BATS:AAPL","NASDAQ:AAPL"]` | 1 | 1 | `BATS:AAPL` |
| `["BATS:AAPL","NASDAQ:AAPL","NASDAQ_DLY:AAPL"]` | 1 | 2 | `BATS:AAPL` |

Both requests issued **exactly one** MCP call. `summary.total` is `1` in each case, and the retained entry is `BATS:AAPL` rather than `NASDAQ:AAPL` — confirming the #591 outbound-only alias invariant survives dedup on a live deployment.

`GET /healthcheck` → `200`. `GET /api/jobs/tradingview-analysis` → `401` (auth-gated, so the service is live).

### Note on the MCP failures in these responses

`status: "error"` with `TradingView MCP circuit breaker is OPEN` is a **pre-existing** condition on the shared MCP host (issue #630), not a regression from this change. It is also why these requests are a clean proof rather than a noisy one: the endpoint fails open and still returns the deduplicated symbol list and the count. Only the single deduplicated symbol was ever attempted, which is the behaviour under test.

### Local verification

- `pnpm test` → **256/256 suites, 5763/5763 tests passing**.
- One initial failure (`tests/integration/trust-proxy-rate-limiter.test.js`, `socket hang up`) was re-run: it reproduces intermittently on unmodified `origin/master`, passes 5/5 in isolation, and touches no file in this diff.
- No new lint findings.
- Local smoke test on port 5871 confirmed the cap-after-dedup path returns `400 Too many symbols requested (max: 50)` for 60 duplicates + 50 distinct.

### Scope note

The issue lists `POST /api/webhook/symbol-analysis` as accepting a `symbols` array. It actually takes a single `symbol`, so it inherits the shared parser (and therefore dedup) but a one-element array cannot contain a duplicate — no observable behaviour change there, and no code change was needed for that endpoint. Noted in the PR description.

[LRN-1792261879-13] correction: ## 🔍 QA report: ✅ Passed
## 🔍 QA report: ✅ Passed
**Tester:** Sherlock (cubefarm QA agent) · **Round:** 1 · **Author:** Ada

PR #1380 adds dedupeSymbolIdentifiers() to the shared expanded-analysis parser so the sync endpoint, async expanded-analysis jobs and symbol-analysis all inherit symbol deduplication, with the cap now applied after dedup and the collapse count reported as duplicatesRemoved. I verified all five acceptance criteria against a live server on port 5391 backed by a local MCP double that counts every tools/call: the 3-entry example issues exactly 2 MCP calls and produces 2 report sections, dedup is case- and alias-insensitive, first-occurrence order is preserved, and 60 duplicates + 50 distinct returns 400 with zero MCP calls while 60 duplicates + 1 distinct is accepted. Full suite is 256/256 suites and 5763/5763 tests passing with no new lint findings and a clean worktree. The one red CI check is a pre-existing flaky wall-clock assertion in event-bus-alert-flow.test.js, a file this diff does not touch; it passes 5/5 in isolation on both this branch and unmodified origin/master.

| | Check | Details |
|---|---|---|
| ✅ | PR gate: mergeable, no merge commits, no conflicts | gh api reports mergeable=MERGEABLE, mergeStateStatus=UNSTABLE, isDraft=false. `git log --merges origin/master..HEAD` is empty and the PR has exactly 1 squash-shaped commit (be5b951c), so the squash/rebase-only ruleset is satisfied. origin/master is at a6ff1ec9 and does not contain the PR head. |
| ✅ | AC1 - 3-entry request performs exactly 2 MCP analyses and the report has 2 sections | Live POST /api/webhook/expanded-analysis-alert with {symbols:['BINANCE:BTCUSDT','BINANCE:BTCUSDT','NASDAQ:NVDA'],dryRun:true} returned HTTP 200 with results.length=2, duplicatesRemoved=1. The local MCP double on :5392 recorded exactly 2 tools/call entries, both coin_analysis, with args (BINANCE/BTCUSDT) and (NASDAQ/NVDA). The rendered payload.alertText contains exactly one `^BTCUSDT ` section line and one `^NVDA ` section line. binance:btcusdt was never called. |
| ✅ | AC2 - deduplication is case-insensitive and exchange-normalized | ['binance:btcusdt',' BINANCE:BTCUSDT ','Binance:Btcusdt','NASDAQ:NVDA'] returned duplicatesRemoved=2, results.length=2 and exactly 2 MCP tool calls. Alias collapse ['BATS:AAPL','NASDAQ:AAPL','NASDAQ_DLY:AAPL'] returned exactly 1 MCP call, duplicatesRemoved=2, and results[0].symbol='BATS:AAPL' - confirming the #591 outbound-only invariant (the retained entry keeps the caller's exchange; the alias is applied only on the outbound call). |
| ✅ | Distinct venues for the same ticker are NOT merged (#591 rule preserved) | ['NASDAQ:ABC','NYSE:ABC','AMEX:ABC','FX_IDC:ABC','SPCFD:ABC'] returned duplicatesRemoved=0, results.length=5 and exactly 5 MCP tool calls. buildSymbolDedupeKey consults only MCP_EXCHANGE_ALIASES via resolveMcpExchange, so FX_IDC/SPCFD and any unlisted venue stay distinct rather than fabricating a market. |
| ✅ | AC3 - order of first occurrence is preserved in report ordering | ['NASDAQ:MSFT','BATS:AAPL','NASDAQ:MSFT','BINANCE:BTCUSDT','BATS:AAPL'] returned results in order ['NASDAQ:MSFT','BATS:AAPL','BINANCE:BTCUSDT'] with duplicatesRemoved=2. First occurrence wins. |
| ✅ | AC4 - MAX_SYMBOLS (50) still applies after deduplication | 60 copies of BINANCE:BTCUSDT + 50 distinct NASDAQ:SYMn returned HTTP 400 code=INVALID_REQUEST error='Too many symbols requested (max: 50)' with zero MCP calls (fails before any analysis). 60 copies + 1 distinct returned HTTP 200 with duplicatesRemoved=59 and results.length=2, proving the cap is applied to the deduplicated list and the error path issues no MCP traffic. |
| ✅ | AC5 - unit and integration coverage added | 9 new parser unit cases in tests/unit/expanded-analysis-alert-report.test.js (exact dupes, case/whitespace, alias collapse, first-occurrence ordering, distinct venues, MAX_SYMBOLS after dedup, EXPANDED_ANALYSIS_ALERT_SYMBOLS env fallback, re-parse idempotence, invalid-identifier precedence); 3 endpoint integration cases asserting exact MCP call counts and report-section counts; 1 async job case asserting 2 calls + duplicatesRemoved=1 + progress.total=2; 1 Postman case deriving duplicatesRemoved === submitted - analysed instead of hard-coding it. Tests are behavioural, not tautological. Suite delta is exactly +14 tests (5763 vs 5749 on master), matching the PR description. |
| ✅ | duplicatesRemoved reported on every response shape | 200 success: duplicatesRemoved=1. Dry-run 200: field present (keys success,dryRun,payload,results,summary,duplicatesRemoved,timedOut,timeoutMs,requestId,processingTimeMs). 502 ALL_SYMBOLS_FAILED (MCP killed): duplicatesRemoved=2 with results reduced to the 3 distinct symbols. 504 EXPANDED_ANALYSIS_ALERT_TIMEOUT (tools/call hung against a 1500ms deadline): duplicatesRemoved=3, timedOut=true, results.length=2, summary.total=2 - also confirming fillTimeoutResults index pairing still holds against a deduplicated list with no spurious third entry. |
| ✅ | Async job path (POST /api/jobs/tradingview-analysis, type expanded-analysis) | symbols=['BINANCE:BTCUSDT','binance:btcusdt','NASDAQ:NVDA'] returned 201, then GET /api/jobs/{jobId} reported status=completed, duplicatesRemoved=1, progress.total=2, results ['BINANCE:BTCUSDT','NASDAQ:NVDA'] with exactly 2 MCP tool calls and one BTCUSDT report section. Alias variant ['BATS:AAPL','NASDAQ:AAPL','NASDAQ_DLY:AAPL','NASDAQ:MSFT'] returned duplicatesRemoved=2, 2 MCP calls and results ['BATS:AAPL','NASDAQ:MSFT']. A job with no duplicates honestly reports duplicatesRemoved=0. The authoritative value is the count captured at creation (requestMetadata), not a re-parse, as documented. |
| ✅ | Auth not weakened on the touched webhook route | POST /api/webhook/expanded-analysis-alert without x-api-key returned HTTP 401 {"error":"Unauthorized: Missing API key"}; with a wrong key returned HTTP 403. validateApiKey is untouched by the diff. No rate-limit, Firebase token or CORS change appears in the 11 changed files. |
| ✅ | Contract surfaces in sync (OpenAPI, Postman, docs) | Live /openapi.json serves ExpandedAnalysisRequest.symbols.maxItems=50 with a description documenting case-insensitive comparison, alias collapse, first-occurrence ordering, retained caller exchange, cap-after-dedup and duplicatesRemoved, plus Job.duplicatesRemoved (integer, minimum 0). New Postman variant 'POST Expanded Analysis Alert (duplicate symbols)' sends 5 entries resolving to 3 symbols, uses dryRun, uses the {{apiKey}} placeholder (no committed secret), and carries executable pm.test assertions plus 200 and 400 response examples. docs/webhooks.md and AGENTS.md both gained a Symbol deduplication section recording the four invariants. The sync response body is an unenumerated JsonObject in this contract (pre-existing), so the field is documented via the symbols description, docs and Postman. |
| ✅ | No new environment variable, Remote Config key or feature gate | .env.example, firebase-remote-config-template.json and render.yaml are all untouched, and `git diff origin/master...HEAD -- src/` introduces zero new process.env reads. MAX_SYMBOLS stays a module constant of 50. /api/capabilities answers 200 and exposes no dedup-specific feature flag. |
| ✅ | pnpm lint - no new findings | The repo-wide lint baseline is 1247 problems on unmodified master. Comparing per changed file against origin/master in a separate worktree gave identical counts: JobService.js 12/12, expanded-analysis-alert-endpoint.test.js 5/5, jobs-endpoint.test.js 8/8, and 0/0 for expandedAnalysisAlertReport.js, expandedAnalysisAlert.js, expanded-analysis-alert-report.test.js and postman-collection.test.js. No new lint finding is attributable to this change. |
| ✅ | pnpm test - full suite | 256/256 suites and 5763/5763 tests passing, exit code 0, 323.957s. Re-verified with a focused re-run afterwards (6 suites, 184 tests passing, including admin-hosting-parity). |
| ✅ | CI 'build' check is red but the failure is pre-existing flakiness, not a regression | gh run view 37562292092 --log-failed shows the only failure is tests/integration/event-bus-alert-flow.test.js 'a slow async subscriber does not delay the HTTP response': expect(elapsed).toBeLessThan(200) received 360 - a wall-clock bound on a slow CI runner. `git diff --name-only origin/master...HEAD -- tests/integration/event-bus-alert-flow.test.js src/services/notification/` is empty, so neither the test nor the /api/webhook/alert code it exercises is in this diff. It passes 5/5 in isolation on the branch, 5/5 in isolation on unmodified master, and passed in both full-suite runs I executed locally. The changed code adds only a property assignment and one destructured read, which cannot account for 160 ms. |
| ✅ | Clean worktree invariant | git status --porcelain was empty after the full suite, after the focused runs, after all live-server traffic and at the end of the session (0 lines, including untracked files). Throwaway probes (fake MCP server and live test script) were written to /tmp only and deleted; the temporary origin/master comparison worktree was removed with git worktree remove. |
| ✅ | Dependency failure fails open; no outbound message delivered | Server booted with ENABLE_TELEGRAM_BOT/WHATSAPP_ALERTS/DISCORD_ALERTS=false and no chat ids; /healthcheck 200 and log line 'Telegram Bot is disabled'. Server log after the whole session: no 5xx, no unhandled rejection, no uncaught exception, no leaked interval. The three async-job runs do not honour dryRun (pre-existing: no dryRun handling in jobs.js or JobService.js), so they took the local zero-channel path - 'No notification channels enabled; alert dropped and dead-lettered' plus 'Admin zero-channel notification undeliverable on every operator channel'. Nothing left the process and no production Telegram, WhatsApp or Discord destination was contacted. |
| ✅ | Admin console and Swagger render without CSP violations or console errors | /admin loads and accepts the legacy session API key (ENABLE_FIREBASE_ADMIN_AUTH off), deep link ?view=analysis restores the view, and /docs plus /openapi.json answer 200. Console messages are clean apart from a pre-existing favicon.ico 404 and a pre-existing 'An invalid form control with name="" is not focusable' - see the next check. No CSP violation, no inline script, no CDN, no innerHTML introduced. At 375px documentElement.scrollWidth === clientWidth === 375, so no page-level horizontal scrollbar. |
| ⏭️ | Pre-existing (master) defect found: admin Playground forms cannot submit when Firebase admin auth is off | Not a PR #1380 issue and not a blocker - the diff touches zero files under src/admin/. The hidden #auth-form keeps two required inputs (#auth-email, #auth-password) in the DOM while offsetParent === null, so Chrome's document-wide constraint validation aborts requestSubmit() with 'An invalid form control with name="" is not focusable' and no request is ever sent ('No request sent.' persists). Reproduced identically against a separately booted unmodified origin/master build, which returned the same two unfocusable required ids and the same no-send behaviour. Reported for a separate issue: either drop required from the hidden Firebase fields when the card is hidden, or scope the Playground validity check to its own form. |
| ⏭️ | Observations for a follow-up issue (non-blocking) | (1) ExpandedAnalysisRequest.symbols still carries pattern ^[A-Z0-9_]+:[A-Z0-9._-]+$, which is uppercase-only, while the new description advertises case-insensitive handling and the runtime accepts and uppercases lowercase input - the pattern predates this PR but now reads as contradictory next to the new text. (2) duplicatesRemoved counts alias collapses, so a caller who deliberately requests both BATS:AAPL and NASDAQ:AAPL gets one analysis - correct, since the MCP server answers both from NASDAQ, but it is a visible behaviour change and is documented in docs/webhooks.md. |

<details><summary>🧪 Commands run</summary>

| Command | Result |
|---|---|
| `git log --merges --oneline origin/master..HEAD` | empty - no merge commits, squash/rebase ruleset satisfied |
| `gh pr view 1380 --json mergeable,mergeStateStatus,isDraft,labels` | MERGEABLE, UNSTABLE, isDraft=false, 1 commit, no conflicting review |
| `gh pr checks 1380` | build=fail, 7 others pass (Deploy Preview, gitleaks, CodeQL, 3 Analyze jobs, build_and_preview_or_deploy) |
| `gh run view 37562292092 --log-failed` | 1 failed suite: tests/integration/event-bus-alert-flow.test.js, expect(elapsed).toBeLessThan(200) received 360 - wall-clock flake in a file untouched by this diff |
| `pnpm install --frozen-lockfile` | Done in 285ms, lockfile up to date, exit 0 |
| `pnpm run lint` | 1247 problems repo-wide (identical pre-existing baseline); per changed file counts identical to origin/master, so no new findings from this PR |
| `npx eslint <each changed file> (branch) vs the same files in a detached origin/master worktree` | JobService 12=12, expanded-analysis-alert-endpoint.test.js 5=5, jobs-endpoint.test.js 8=8, other 4 changed files 0=0 |
| `pnpm test` | 256 passed / 256 total suites, 5763 passed / 5763 total tests, 323.957s, exit 0 |
| `npx jest --silent (unmodified origin/master in a temp worktree)` | 256 passed / 256 total suites, 5749 passed / 5749 total tests, exit 0 - branch adds exactly 14 tests, all passing; event-bus-alert-flow passed here too |
| `pnpm test -- tests/unit/expanded-analysis-alert-report.test.js tests/integration/expanded-analysis-alert-endpoint.test.js tests/integration/jobs-endpoint.test.js tests/unit/postman-collection.test.js tests/unit/openapi-contract.test.js tests/unit/admin-hosting-parity.test.js` | 6 suites passed, 184 tests passed |
| `pnpm test -- tests/integration/event-bus-alert-flow.test.js --testTimeout=15000  (x5, branch and unmodified master)` | 5 passed / 5 total on every one of the 10 runs |
| `git status --porcelain (after full suite, after focused runs, after live traffic, at session end)` | empty every time - tests write nothing into the worktree |
| `node index.js  (PORT=5391, all channels disabled, TRADINGVIEW_MCP_URL=http://127.0.0.1:5392/mcp)` | boots clean, GET /healthcheck 200, GET /admin 200, GET /docs 200, GET /openapi.json 200, 'Telegram Bot is disabled' |
| `node /tmp/qa1380-fake-mcp.js  (local MCP Streamable-HTTP double logging every tools/call)` | used to measure real outbound MCP call counts and args per scenario |
| `node /tmp/qa1380-live-probe.js  (20 live checks against :5391)` | 18/20 passed on first pass; the 2 failures were defects in my own probe (read r.body.alertText instead of r.body.payload.alertText on the dry-run path, and assumed symbol-analysis honours dryRun) - both re-verified correct by hand: report has exactly 1 BTCUSDT and 1 NVDA section; symbol-analysis without dryRun issues exactly 1 MCP call and returns analysisStatus=complete |
| `curl POST /api/webhook/expanded-analysis-alert (MCP down, and MCP hanging vs a 1500ms deadline)` | 502 ALL_SYMBOLS_FAILED with duplicatesRemoved=2; 504 EXPANDED_ANALYSIS_ALERT_TIMEOUT with duplicatesRemoved=3, timedOut=true, results.length=2, summary.total=2 |
| `curl POST /api/webhook/expanded-analysis-alert and /api/jobs/tradingview-analysis without and with x-api-key` | 401 Unauthorized: Missing API key; 403 on wrong key; validated payloads in both cases |
| `grep -E '"level":"(warn\|error)"' /tmp/qa1380-server.log` | 11 lines, all pre-existing/benign: a Node ExperimentalWarning, request-completed warns, and the zero-channel dead-letter path. No 5xx, no unhandled rejection |
| `git worktree remove --force /tmp/qa1380.ELf8 ; git status --porcelain` | temporary master worktree removed; worktree clean |

</details>

### 📸 Evidence

**1. Swagger UI at /docs on the PR build with POST /api/webhook/expanded-analysis-alert expanded - parameters, request-body example and the 200/400/502/504 response list all render; only console error is a pre-existing favicon.ico 404, no CSP violation.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1380/round-1-muxivn4l/01.png" alt="Swagger UI at /docs on the PR build with POST /api/webhook/expanded-analysis-alert expanded - parameters, request-body example and the 200/400/502/504 response list all render; only console error is a pre-existing favicon.ico 404, no CSP violation." width="760">

**2. Swagger UI schema view of ExpandedAnalysisRequest - the proof shot for the contract change: symbols is rendered as array<string> with the <= 50 items badge and the new description stating that duplicates are collapsed before any TradingView MCP call, that comparison is case-insensitive and uses the resolved MCP venue so BATS and NASDAQ_DLY fold into NASDAQ, that first occurrence wins and ordering follows it, that the retained entry keeps the caller's own exchange, and that maxItems applies to the deduplicated list with the collapsed count reported as duplicatesRemoved.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1380/round-1-muxivn4l/02.png" alt="Swagger UI schema view of ExpandedAnalysisRequest - the proof shot for the contract change: symbols is rendered as array<string> with the <= 50 items badge and the new description stating that duplicates are collapsed before any TradingView MCP call, that comparison is case-insensitive and uses the resolved MCP venue so BATS and NASDAQ_DLY fold into NASDAQ, that first occurrence wins and ordering follows it, that the retained entry keeps the caller's own exchange, and that maxItems applies to the deduplicated list with the collapsed count reported as duplicatesRemoved." width="760">

**3. Admin console at 1440px showing the Overview view with the legacy session API-key form (ENABLE_FIREBASE_ADMIN_AUTH off) - console loads, accepts the session key and renders without errors.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1380/round-1-muxivn4l/03.png" alt="Admin console at 1440px showing the Overview view with the legacy session API-key form (ENABLE_FIREBASE_ADMIN_AUTH off) - console loads, accepts the session key and renders without errors." width="760">

**4. Admin console Analysis view at 375px with the six-entry duplicate symbol list typed into the Expanded analysis form (BINANCE:BTCUSDT, binance:btcusdt, BATS:AAPL, NASDAQ:AAPL, NASDAQ_DLY:AAPL, NASDAQ:NVDA) - confirms narrow-viewport layout and documentElement.scrollWidth === clientWidth === 375, i.e. no page-level horizontal scrollbar.**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1380/round-1-muxivn4l/04.png" alt="Admin console Analysis view at 375px with the six-entry duplicate symbol list typed into the Expanded analysis form (BINANCE:BTCUSDT, binance:btcusdt, BATS:AAPL, NASDAQ:AAPL, NASDAQ_DLY:AAPL, NASDAQ:NVDA) - confirms narrow-viewport layout and documentElement.scrollWidth === clientWidth === 375, i.e. no page-level horizontal scrollbar." width="760">

**5. Screenshot 5**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1380/round-1-muxivn4l/05.png" alt="Screenshot 5" width="760">

**6. Screenshot 6**

<img src="https://github.com/francovp/cabros-bot/raw/swarm-qa-evidence/pr-1380/round-1-muxivn4l/06.png" alt="Screenshot 6" width="760">


<sub>Posted by cubefarm · merges automatically once GitHub's checks pass</sub>


---

## [LRN-20261018-001] correction

**Logged**: 2026-10-18T10:14:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
PR #1365 was deleting previous learnings instead of appending new ones.

### Details
On PR #1365 (docs(learnings): log corrections from @francovp on PR #1356 and PR #1352), @francovp provided correction on 2026-10-11T02:16:08Z: "PR is deleting too many learnings, don't remove previous learnings". The Virgin Trainee's PR was replacing the entire LEARNINGS.md file instead of appending new learning entries, causing loss of historical learnings.

### Suggested Action
When updating LEARNINGS.md, always append new entries to the end of the file rather than overwriting the entire file. Use the established format with proper ID generation (LRN-YYYYMMDD-XXX) and maintain all existing entries.

### Metadata
- Source: user_feedback
- Related Files: .learnings/LEARNINGS.md
- Tags: learnings, data-preservation, file-operations
- See Also: PR #1365
- Pattern-Key: harden.data_preservation

- [2026-10-19T04:20:58+00:00] @francovp on issue #601 (Add per-endpoint rate limiting for expensive operations): [GLOBAL_BLOCKED] Verification update 2026-10-18T12:19Z: the resolver selects active OpenClaw deployment 6702715040 for PR #968; its deployment-record SHA 5d2236e022178cfd006edfb80093d185cf598212 matches the current PR head. /healthcheck, /openapi.json, and /api/status each returned HTTP 502 on all three attempts. WEBHOOK_API_KEY is not available in this local run, so the served service.commit could not be read.  PR #968 is DIRTY against master. The four currently reported checks pass (Analyze actions, JavaScript/TypeScript, Python, and CodeQL); no Node.js CI or Deploy Preview check is reported. Four inline review threads remain unresolved. The latest PR discussion reports that the branch may replace master’s 1,000-request webhook-ingest bucket with a 30-per-minute tier and bypass getRateLimitKey/TRUST_PROXY; this must be verified and reconciled before merge.  This differs from the earlier Railway 404 report: the active OpenClaw deployment record now matches the PR head, but the preview endpoints are unavailable. Railway was not used, and no stale-SHA deployment refresh was triggered. The issue’s tier settings have documented defaults; no specific missing deployment variable was identified.  Operator next steps: restore the OpenClaw preview, reconcile PR #968 with current master, and resolve the webhook-ingest rate-limit regression and open review threads before considering merge.
