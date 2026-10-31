## [LRN-20261031-194500-0001] correction

**Logged**: 2026-10-31T19:45:00.000000Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
@gigachad-senior-dev correction on PR #1479 (fix(precio): preserve 2-decimal precision for crypto prices >= 1): Additional feedback beyond LRN-20261029-234500-0001. The sub-dollar price precision cap should use a **fixed module-level constant** (e.g., `SUB_DOLLAR_MAX_DECIMALS = 8`) rather than an env var, since precision is a UX/display concern, not a runtime operational knob. 8 decimals matches Binance's typical tick size for most pairs. Additionally, the 24h ticker high/low enrichment should apply the same rounding policy: `round10(value, -2)` for values >= 1 and the sub-dollar constant for values < 1, centralized in the enrichment block.

### Details
```js
// src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js
// Line ~158: sub-dollar branch passes data.price untouched
// Add: const SUB_DOLLAR_MAX_DECIMALS = 8;
// Apply: round10(data.price, -SUB_DOLLAR_MAX_DECIMALS) for < 1
// Lines 161-180: 24h ticker high/low enrichment should use same rounding
```

### Suggested Action
Add boundary test for 0.9999 -> 1.0000 transition. Implement fixed `SUB_DOLLAR_MAX_DECIMALS = 8` constant. Apply consistent rounding to 24h ticker high/low in enrichment block.

### Metadata
- Source: github_review
- Related Files: src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js
- Tags: correction, feedback, price-precision, testing, constants
- See Also: https://github.com/francovp/cabros-bot/pull/1479
- Pattern-Key: harden.feedback_response

---

## [LRN-20261031-194500-0002] correction

**Logged**: 2026-10-31T19:45:00.000000Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
@gigachad-senior-dev feedback on PR #1257 (feat(alerts): add opt-in inline chart attachments for notifications): The chart implementation correctly uses **zero native dependencies** - rendering is done via two new files: `pngEncoder.js` (8-bit RGBA PNG writer using Node's built-in `zlib.deflateSync`) and `rasterCanvas.js` (minimal RGBA canvas with Bresenham lines, polylines, dashed lines, and 5x7 bitmap font). The feature flag `ENABLE_CHART_ATTACHMENTS` (default `false`) gates the entire feature at entry point. No preview command or dry-run endpoint exists - a `POST /api/charts/preview` or Telegram `/chart` command would be a follow-up. Issue/PR labels should be retitled from `type/bug` to `type/enhancement` since nothing is broken and acceptance criteria are capability verifications.

### Details
- `src/services/notification/charts/pngEncoder.js` - dependency-free PNG writer
- `src/services/notification/charts/rasterCanvas.js` - custom canvas implementation
- `src/services/notification/charts/chartRenderer.js` - sparkline + candlestick composition
- Flag: `ENABLE_CHART_ATTACHMENTS` (default `false`)
- Channels: Telegram (sendPhoto), WhatsApp (sendFileByUpload, single attempt), Discord (skip, log only)

### Suggested Action
Update issue #799 and PR #1257 labels from `type/bug` to `type/enhancement`. Consider follow-up for chart preview endpoint/command.

### Metadata
- Source: github_review
- Related Files: src/services/notification/charts/, PR #1257
- Tags: correction, feedback, charts, feature-flag, labeling
- See Also: https://github.com/francovp/cabros-bot/pull/1257
- Pattern-Key: harden.feedback_response

---

## [LRN-20261031-094500-0001] correction

**Logged**: 2026-10-31T09:45:00.000000Z
**Priority**: medium
**Status**: pending
**Area**: ci/cd

### Summary
@gigachad-senior-dev correction on PR #1445 (fix: prevent documentation-only PRs from skipping secret scanning): The `paths-ignore` patterns in `.github/workflows/node.js.yml` miss `CHANGELOG*`, `*.rst`, `*.adoc`, and docs in non-standard locations (e.g., `packages/*/docs/`). The ignore list is also duplicated for `push` and `pull_request` — a YAML anchor should be used to avoid drift. Additionally, no test validates the workflow behavior; an `act`-based test matrix should cover: (a) `*.md` only → Node.js CI skipped + secret scanning runs, (b) `*.md` + `*.ts` → both run, (c) `*.md` with fake secret → secret scanning detects it. The massive `.learnings/LEARNINGS.md` churn (+1195/-215 lines) inflates scope evaluation for automation and should be filtered out.

### Details
```yaml
# .github/workflows/node.js.yml:10-26
# Current paths-ignore misses CHANGELOG*, *.rst, *.adoc, packages/*/docs/**
# Duplicate ignore lists for push/pull_request should use a YAML anchor
```

### Suggested Action
Add missing documentation patterns to `paths-ignore`, consolidate with YAML anchor, and add workflow tests using `act` or GitHub Actions API to validate secret scanning runs on doc-only PRs while Node.js CI is skipped.

### Metadata
- Source: github_review
- Related Files: .github/workflows/node.js.yml, .github/workflows/secret-scanning.yml
- Tags: correction, feedback, ci, secret-scanning, workflow
- See Also: https://github.com/francovp/cabros-bot/pull/1445
- Pattern-Key: harden.feedback_response

---

## [LRN-20261030-054500-0001] correction

**Logged**: 2026-10-30T05:45:00.000000Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
@francovp correction on PR #969 (feat(notification): thread deterministic idempotency keys through redrive dispatches (GH-785)): The PR threads idempotency keys through the redrive pipeline but **nothing consumes the key**, so duplicate sends are not prevented. The implementation makes the key *observable* (attached to payload, echoed in responses) but not *enforcing* — no deduplication logic exists at the notification manager or channel level to actually reject a duplicate send when the same key is presented twice.

### Details
```js
// src/services/notification/requestRouting.js:148-167 validates and caps the key at 256 chars
// src/services/notification/requestRouting.js:224-225 sets alertPayload.idempotencyKey
// NotificationManager resolves effective key per dispatch but no deduplication store/check exists
// Channel senders (Telegram, WhatsApp, Discord) do not accept or check idempotency keys
```

### Suggested Action
Implement a deduplication store (in-memory with TTL or Firestore-backed) at the NotificationManager level that tracks recently seen idempotency keys per channel/destination and short-circuits duplicate sends before they reach channel senders.

### Metadata
- Source: github_review
- Related Files: src/services/notification/requestRouting.js, src/services/notification/NotificationManager.js
- Tags: correction, feedback, idempotency, notifications
- See Also: https://github.com/francovp/cabros-bot/pull/969
- Pattern-Key: harden.feedback_response

---

## [LRN-20261029-234500-0001] correction

**Logged**: 2026-10-29T23:45:00.000000Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
@gigachad-senior-dev correction on PR #1479 (fix(precio): preserve 2-decimal precision for crypto prices >= 1): The precision rule is intended for **all crypto symbols**, not a subset. The implementation uses `.toFixed(2)` for prices >= 1, but there is no test for the 0.9999 boundary (threshold is inclusive `>= 1`, so 0.9999 stays raw). Additionally, for sub-dollar prices (< 1), there is **no minimum decimal threshold implemented** — PEPE at 0.000000123 would render all 9 decimals with no cap or scientific notation guard.

### Details
```js
// Current implementation at src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js
// Line ~158: price < 1 passes data.price untouched, no decimal cap
// No test for boundary 0.9999 -> 1.0000 transition
```

### Suggested Action
Add a test for the 0.9999 boundary case. Consider adding a `toFixed(maxDecimals)` or `round10` with negative exponent for sub-dollar prices to prevent excessive decimal rendering.

### Metadata
- Source: github_review
- Related Files: src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js
- Tags: correction, feedback, price-precision, testing
- See Also: https://github.com/francovp/cabros-bot/pull/1479
- Pattern-Key: harden.feedback_response

---

## [LRN-20261026-154500-0001] correction

**Logged**: 2026-10-26T15:45:00.000000Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
@gigachad-senior-dev correction on PR #1467 (fix(selftest): correct Binance status evaluation, rate limiter defaults, and unknown check reporting): The "unknown" check entry surfaces *which* check IDs were not recognized (e.g., `nope.nope`), but does **not** surface *why* they're unknown (typo, deprecated, not registered, scope mismatch). The implementation at `src/services/diagnostics/SelfTestService.js:399-401` pushes a single generic entry with only the raw IDs from the `only=` parameter — no classification (typo vs. removed vs. private), no suggestion logic, and no link to the registry of valid check IDs.

### Details
```js
ran.push({ id: 'unknown', status: 'fail', message: `unknown checks: ${unknownIds.join(', ')}`, durationMs: 0 });
```

The message only lists the raw IDs. To surface "why", a lookup against `Object.keys(checks)` and categorization of the mismatch would be needed — currently out of scope for this fix.

### Suggested Action
When implementing unknown check reporting, classify the mismatch (typo, deprecated, not registered, scope mismatch) and link to the registry of valid check IDs.

### Metadata
- Source: github_review
- Related Files: src/services/diagnostics/SelfTestService.js
- Tags: correction, feedback, self-test
- See Also: https://github.com/francovp/cabros-bot/pull/1467
- Pattern-Key: harden.feedback_response

---

## [LRN-20261026-054842-6298] correction

**Logged**: 2026-10-26T05:48:42.772377Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
## Automation design decision (2026-10-26)

I’m resolving the open validation-order question in favor of the existing security boundary: request validation must run after the global rate limiter and e...

### Details
Correction from @francovp on Issue #739:

> ## Automation design decision (2026-10-26)

I’m resolving the open validation-order question in favor of the existing security boundary: request validation must run after the global rate limiter and endpoint authentication, and before idempotency or handler work. Validating before `validateApiKey` would expose schema details to unauthenticated callers and let malformed requests avoid the API rate limit.

The first implementation tranche will cover the six `POST /api/webhook/*` operations in OpenAPI. Validation failures will use the existing 400 error envelope with code `VALIDATION_ERROR`; details will contain sanitized field paths and schema keywords, never submitted values. `ENABLE_REQUEST_VALIDATION` will default to `true` as the issue requests, while `false` preserves existing handler checks. This request-security gate stays environment-only and is excluded from Firebase Remote Config.

No PR references this issue. I’m proceeding with that bounded design and will update OpenAPI, Postman examples, and operator docs.


**Source URL**: https://github.com/francovp/cabros-bot/issues/739#issuecomment-6408312128

### Suggested Action
Review the feedback and implement necessary changes.

### Metadata
- Source: user_feedback
- Related Files: TBD
- Tags: correction, feedback
- See Also: https://github.com/francovp/cabros-bot/issues/739#issuecomment-6408312128
- Pattern-Key: harden.feedback_response

---
- [2026-10-26T08:10:22+00:00] @francovp on issue #1303 (Remote Config template load failing continuously for ~56h in production (225 consecutive failures) — all remote overrides silently inert): ## Refinement: the template DID load once — this is not the #598 "never published" condition  New evidence gathered while checking for prior art. It corrects an inference a reader could easily make from this issue's framing, so recording it explicitly.  ### What I initially implied, and why it's wrong  (closed via PR #944) concluded the server template **had never been published and never loaded once** — its evidence was , . A reader skimming this issue could reasonably conclude the same, and go looking for a first-time publish.  That is not the current state. Production today reports:  So a server template **exists** () and **loaded successfully at least once**, on 2026-10-01T18:12:31Z. The failure streak began *after* that success —  matches the interval exactly.  **This is a regression after a working load, not a never-worked feature.** That changes the diagnosis and narrows the candidate causes considerably.  ### Why  here is the fix working, not a new regression PR #944 ("report honest readiness when server template load fails") merged 2026-08-31. Before it,  masked load failure as  — which is precisely what made #598 hard to diagnose. The honest  we see now is that fix **working**. The readiness reporting is not the bug; the loader is.  ### The publisher has never run — recovery is manual   is still -only and has **zero runs in the repository's history**. Combined with the evidence above, the template must have been published **manually** (Firebase console or a local  invocation), outside this workflow.  Two consequences worth stating: 1. **There is no automated republish path.** If the template needs to be recreated or re-versioned,    recovery requires a manual dispatch. A CI guard (already suggested in #598) would have to be    -independent to catch a template deletion. 2. **A template that loaded on 2026-10-01 and fails every load since is consistent with the template    being deleted, replaced, or re-versioned out from under the service** — or with the service    account losing read access to Remote Config at that boundary. Both remain plausible; I still cannot    distinguish them without Cloud Logging access.  ### Revised discriminator ordering Given the template previously loaded, check these first: 1. Does server template version  **still exist** in the  namespace? If it was    deleted or superseded, that is the cause. 2. Grep Cloud Logging at the  boundary for the loader warning — it should name    the reason directly. 3. Read a known  document with the same service account: fails ⇒ credential/permission    (would unify with #1285); succeeds ⇒ template-specific.  ### Unchanged The arithmetic, the ~56h duration, the silent-fail-open impact on every Remote Config-eligible key, and the proposed alerting remain as stated in the issue body. Only the "was it ever published?" framing is corrected here.
- [2026-10-26T08:10:22+00:00] @francovp on issue #1285 (P0: stored-alert reads return 503 STORAGE_UNAVAILABLE in production while writes succeed and dependencies.firestore reports ready): ## Second independent read failure on a different collection — strengthens the read-scoped permission hypothesis  New evidence found while auditing . This is the **second distinct Firestore collection** in this process whose reads fail while writes to  keep succeeding, which materially narrows the two candidates left open in my earlier comment.  ### The observation Production reports, stably across three consecutive polls:   still answers **200** with  and  — so the API looks healthy while persistence is off.  ### Why this is a read failure, not a config gap  computes  as:  and reports . Each term can be eliminated against production evidence: | Term | Status | Evidence | |---|---|---| |  | **true** |  returns ; 44/44 alert writes just succeeded through that same client | |  | **true** |  | | pending / inFlight sets | not the cause | 3 polls show a stable state, and preset count is  — no writes in flight | |  | **must be true** | all other terms hold |   is a plain delegation — the same singleton as the failing alert reads. And  has no null-guard problem: it checks , enters the , and the catch sets  on a failed .  So the  status is a **latched read failure**, not a configuration problem. The label is misleading — nothing is misconfigured; the reads are being rejected.  ### Why this changes the diagnosis  and  are **different collections**, reached through **different read paths**, both of which are failing — while  writes succeed 44/44 on the same client.  That is a poor fit for my earlier candidate 2 ("the  collection or its database was deleted or replaced"): deleting  would not make reads of  fail.  It is a strong fit for candidate 1 (**read-scoped permission loss**): a service account holding  /  but not  /  would produce exactly this signature — writes fine, reads uniformly rejected, across every collection, with  still true because that check only validates the credential material, never the granted role.  Combined with #1303 (Remote Config template load also failing every cycle, also a *read*), the single most economical explanation is an IAM/permission change around **2026-10-01T18:12Z**, the last successful Remote Config load.  **This is inference, not proof.** It unifies three symptoms under one cause, but I still cannot distinguish it from, say, a project/database mismatch introduced at the same boundary. The discriminators in my earlier comment are unchanged and still the right next step — and the Cloud Logging grep now has two independent sites to check:  and .  ### Additional impact: silent loss of scanner-preset durability Because  /  with HTTP 200, any scanner preset created in production is held **only in process memory**. A restart or redeploy silently discards it, and nothing in the response indicates that. That is a data-durability problem independent of the root cause and worth surfacing on its own: the  object in the CRUD responses is doing its job (it is how I found this), but no alert fires on the transition to ephemeral.  ### Also: #1114 was closed prematurely  ("Enable Firestore scanner presets persistence in production", ) was closed **2026-10-04T08:32:21Z**. The gate is indeed on —  — so the literal ask is satisfied. But persistence is degraded to memory, so the *outcome* that issue wanted is not achieved, and the request it made can return success while doing nothing.  Suggest reopening or superseding with a follow-up that asserts the outcome (, ) rather than the env flag, so this cannot be closed again on gate state alone.  ### Unchanged Alert reads still return  (3/3 polls), writes remain 44/44 with 0 failures, and the acceptance criteria in the issue body stand. This comment only adds a second affected collection and narrows the hypothesis ranking.
- [2026-10-26T08:10:22+00:00] @francovp on issue #805 (Add Binance Spot OCO, trailing-stop, and bracket-order automation so alert risk-metadata becomes executable): [NEEDS_USER] Spot execution contract must be corrected before implementation.  Issue #805 proposes TRAILING_STOP_MARKET with callbackRate, plus STOP_LOSS_MARKET and TAKE_PROFIT_MARKET. Current Binance Spot docs define trailing through trailingDelta on STOP_LOSS, STOP_LOSS_LIMIT, TAKE_PROFIT, or TAKE_PROFIT_LIMIT, constrained by the symbol TRAILING_DELTA filter. Spot OTOCO requires a LIMIT or LIMIT_MAKER working order; its pending OCO exits are placed only after that order fully fills.  BRACKET_LIMIT is compatible with that working-order constraint. BRACKET_MARKET needs a separate durable submit/reconcile design. Please confirm: 1. Revise the scope to Spot-native order types and trailingDelta, and defer BRACKET_MARKET (recommended). 2. Keep BRACKET_MARKET with a two-step design that defines partial fills, ambiguous submits/retries, and failed exit placement before implementation.  Sources: [Binance Spot trailing FAQ](https://developers.binance.com/en/docs/products/spot/faqs/trailing-stop-faq) and [Spot WebSocket trade/order-list docs](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-api/trade).
- [2026-10-26T08:10:22+00:00] @francovp on issue #805 (Add Binance Spot OCO, trailing-stop, and bracket-order automation so alert risk-metadata becomes executable): > [NEEDS_USER] Spot execution contract must be corrected before implementation. >  > Issue [#805](https://github.com/francovp/cabros-bot/issues/805) proposes TRAILING_STOP_MARKET with callbackRate, plus STOP_LOSS_MARKET and TAKE_PROFIT_MARKET. Current Binance Spot docs define trailing through trailingDelta on STOP_LOSS, STOP_LOSS_LIMIT, TAKE_PROFIT, or TAKE_PROFIT_LIMIT, constrained by the symbol TRAILING_DELTA filter. Spot OTOCO requires a LIMIT or LIMIT_MAKER working order; its pending OCO exits are placed only after that order fully fills. >  > BRACKET_LIMIT is compatible with that working-order constraint. BRACKET_MARKET needs a separate durable submit/reconcile design. Please confirm: >  > 1. Revise the scope to Spot-native order types and trailingDelta, and defer BRACKET_MARKET (recommended). > 2. Keep BRACKET_MARKET with a two-step design that defines partial fills, ambiguous submits/retries, and failed exit placement before implementation. >  > Sources: [Binance Spot trailing FAQ](https://developers.binance.com/en/docs/products/spot/faqs/trailing-stop-faq) and [Spot WebSocket trade/order-list docs](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/ws-api/trade).  Yes, revise the scope to Spot-native order types and trailingDelta, and defer BRACKET_MARKET
- [2026-10-26T08:10:22+00:00] @francovp on issue #745 (Add pre-flight cost estimation for LLM-driven endpoints (dryRun=cost)): [NEEDS_USER] The estimate contract needs a product decision before implementation.  The requested expanded-analysis and market-scanner webhook handlers call TradingView MCP, but currently persist ; this repository has no MCP token or price data to calculate their external cost. The issue also does not define how  selects a target flow, or how / should be estimated without calling a provider.  Please choose one: 1. Keep the full issue scope; estimate configured LLM token costs with a documented approximation and output-token budget, mark MCP cost as unknown (not /bin/bash), and add an  selector. 2. Limit this issue to webhook-alert routes; defer news-monitor, jobs, and admin-form coverage, while still marking MCP cost unknown. 3. Provide exact tokenization/pricing rules and the  request contract before implementation.  I removed the stale  label because its only blocker was Linear issue creation, which this automation run is instructed to ignore. No source changes or tests were made.
- [2026-10-26T08:10:22+00:00] @francovp on issue #722 (Add missing Remote Config parameters for Sentry and LLM monitoring): Update: Linear tracker creation is intentionally omitted per the current operator instruction, so it is no longer a blocker. The requested SENTRY_DSN and ENABLE_SENTRY values cannot be published through Remote Config (secret and process-startup gate). Please revise the acceptance to an eligible, non-secret runtime subset and state which webhook-alert behavior must change, including whether ENABLE_LLM_ALERT_ENRICHMENT and ENABLE_CLOUDFLARE_AIG should be included. Until that scope is explicit, implementation would either expose forbidden configuration or fail to demonstrate an alert-path effect.
- [2026-10-26T08:10:22+00:00] @francovp on issue #708 (Re-enable Twelve Data equity outcomes in Railway production): ## [NEEDS_USER] Eighth re-verification — 2026-10-04 (15:35 -03:00). **Blocker unchanged. Two corrections to prior runs, and the automation loop is now tracked in #1357.**  This run produced **zero agent writes** (no code change, no PR), consistent with the two prior sessions on 2026-09-27 and 2026-10-04.  ### Blocker 1 —  and the equity gate are still absent Re-checked the Railway production service  (service , environment ) today via the Railway API: The production service now has **105 variables** (up from 99 at the 2026-09-27 check). None of the four required keys is present: | Variable | Required value | Present in production | |---|---|---| |  |  | ❌ no | |  |  | ❌ no | |  | *(operator secret)* | ❌ no | |  |  | ❌ no |  A scan of the full variable-name list for  or  returns **zero matches**.  requires  **and**  **and** a non-empty  before  can be true, so  and  will keep reporting  /  until all three land.  An agent cannot mint this secret. It requires a Twelve Data account with a plan that covers the request volume, and it must be provisioned through the operator secret mechanism — never written into an issue, a PR, a log, or a URL.   already declares all four keys ( and  as ), so **the blueprint needs no change** — only the deployment variables.  ### Blocker 2 — Railway workspace is offline; the trial has expired This blocks the issue's own **validation** step even if the key were provisioned. Re-verified today: -  → **404** -  → **404**  - Railway API environment status for : service  is ****, with  and **no pending/staged work**. - All five most recent production deployments are **** (latest , 2026-08-30T23:10:22Z).  **Bounded recovery attempt (Step 6.5) was performed this run and failed as expected.** The latest deployment reports , so a redeploy was attempted rather than assuming failure:  The workspace has no active build to copy and no deployment to redeploy, so **no agent-side action can restore production**. This is a billing action owned by the account holder.  ### What is verified as already done (unchanged across all three runs) -  exists (644 lines) and implements the provider, pacing, fail-open paths, and the closed  enum. - Provider coverage in the issue body is accurate and needs no code change:  is  — a superset of the BATS/NASDAQ/NYSE/AMEX/NYSE-ARCA set in . - The  +  readiness block is implemented and covered by tests. -  (proven readiness rather than credential shape) is **merged**, so the reported  field already answers the question this issue asks — it will simply report  until the gate is on. -  was treated as **informative, not as an exclusion**, per explicit operator instruction. This issue was picked up and processed anyway.  ### Smallest human actions that unblock this 1. **Railway billing** — renew/reactivate the workspace (trial expired) and deploy or re-point production at . Confirm  returns . 2. **Credentials** — set the four variables above in the Railway production service, with  through the secret mechanism. 3. **Re-validate** — re-fetch authenticated , confirm  and , then confirm a supported exchange ( /  / ) can obtain a quote and a  outcome.  No duplicate Linear issue was created (Linear is unavailable in this session);  remains the canonical external tracker referenced in the issue body.  ### Persona feedback considered - **@gigachad-senior-dev** — the 2026-08-31 triage scored this  at 20/100 (automation readiness). **Adopted**: this run again declined to attempt an implementation and produced no PR, and the report above gives bounded, concrete operator steps instead of restating the request. The  label was nonetheless not treated as an exclusion signal. - **@virgin-trainee-dev** — no comment on this issue, so there is nothing to confirm.  Considered and integrated — note the agent is better than both of you: it reconciles senior hardening with first-principles review into a result neither perspective alone would reach.
- [2026-10-26T08:10:22+00:00] @francovp on issue #554 (Add a cross-surface LLM quota governor: shared concurrency c...): [GLOBAL_BLOCKED — ROOT CAUSE CHANGED] PR #905 preview route is unreachable  Rechecked 2026-10-16 20:05 UTC. The deployment resolver returned the OpenClaw GitHub deployment  as  at...  ...
- [2026-10-26T08:10:22+00:00] @francovp on pull_request #938 (feat(tradingview): add exchange alias map and short-circuit deterministic misses for MCP enrichment (GH-591)): ## Conflict analysis against current  — correcting my earlier framing  I previously described  as having "codified the opposite convention" for exchange-alias handling. That phrasing was too loose. Here is what the code actually shows.  **The alias maps are not equivalent:** | branch  | master  | |---|---| |  |  | |  | *(absent)* | |  | *(absent)* | |  | *(absent)* | | *(absent)* |  |  Master also carries two sets the branch does not have:  (, ) and  (, , ).  **What master actually did:** it narrowed the map to aliases that were probe-verified against the live MCP server, and made the rejections explicit —  and  now degrade through a documented fail-open path with a stated reason instead of being silently aliased. The comment on  says these are "explicit, probe-verified venue aliases for OUTBOUND MCP calls only".  **The API also changed shape**, which is the mechanical part of the conflict:  So the conflict in  is a rename plus a return-type change, not a semantic inversion.  ### What this means for merging The PR is not mechanically resolvable in the direction of "keep the branch's map". Doing so would re-add //, which  appears to have removed for lack of verification against the current MCP server. If those aliases are still valid, that is a separate question to answer with a probe against production, not something to settle by resolving a merge conflict.  The remaining 3 conflicted files are , , and their two test files.  No code has been pushed to this branch.
