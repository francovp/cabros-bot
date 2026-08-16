# fix: enforce Gemini quota cooldown across request paths (CB-152)

## Summary

Enforce the process-level Gemini quota cooldown consistently across search, LLM, and news-monitor analysis retry paths, recheck extended cooldown deadlines during waiting, and recompute provider timeout budgets post-cooldown.

## Key Changes

- **Grounding Search Cooldown Enforcement**: Updated `GenaiClient.search` to throw a `GEMINI_QUOTA_EXHAUSTED` (status 429) error when cooldown is active and `rethrowQuotaErrors` is `true`, preventing calls to `_executeGoogleSearch` while cooldown is active. Also forwarded `signal` to Brave search fallback.
- **LLM Cooldown Enforcement**: Updated `GenaiClient.llmCall` to throw a `GEMINI_QUOTA_EXHAUSTED` error when cooldown is active, preventing invocations of `generateContent` during active cooldowns.
- **Dynamic Cooldown Recheck**: Updated `GeminiQuotaManager.waitForCooldownIfNeeded` to loop and recheck the shared cooldown deadline, accurately evaluating whether concurrent 429 extensions push the remaining wait past the allowable `maxWaitMs` budget.
- **Post-Wait Timeout Budgeting**: Updated `NewsAnalyzer.runSymbolAnalysisWithRetry` to recompute the remaining timeout budget (`this.timeout - elapsedMs`) after waiting for cooldown, ensuring analysis execution does not exceed configured time budgets.
- **Comprehensive Unit Tests**: Added unit tests in `gemini-quota-manager.test.js`, `genaiClient.test.js`, and `analyzer.test.js` covering search cooldown enforcement, LLM cooldown skips, concurrent 429 extension loops, budget overruns, and post-wait timeout derivation.

## Technical Implementation

- `src/services/grounding/geminiQuotaManager.js`: Loop in `waitForCooldownIfNeeded` continually checks `isCooldownActive()`, calculates elapsed wait time against `maxWaitMs`, and handles extensions or throws `GEMINI_QUOTA_EXHAUSTED` when `maxWaitMs` is exceeded.
- `src/services/grounding/genaiClient.js`: Check `geminiQuotaManager.isCooldownActive()` in `search` (rethrowing 429 when `rethrowQuotaErrors=true`) and in `llmCall` (throwing 429 before `generateContent`).
- `src/controllers/webhooks/handlers/newsMonitor/analyzer.js`: Recompute `remainingAfterWaitMs = this.timeout - (Date.now() - startedAt)` and derive `timeoutPromise` from it.

## Testing

- Ran focused unit tests: `pnpm test -- tests/unit/gemini-quota-manager.test.js tests/unit/genaiClient.test.js tests/unit/analyzer.test.js` (100% pass).
- Ran full test suite: `pnpm test` (76 test suites, 887 tests passed, 0 failures, 0 regressions).

## References

- **Linear**: [CB-152](https://linear.app/knil/issue/CB-152/enforce-gemini-quota-cooldown-across-request-paths-gh-372)
- **GitHub Issue**: Fixes #372
