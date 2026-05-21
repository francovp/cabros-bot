# Codebase Review & Quality-of-Life Improvements

## 1. Summary of findings
The Cabros Bot codebase is a robust Node.js/Express application with advanced features like multi-channel notifications, AI grounding (Gemini/Azure), and rate limiting. It uses a good modular structure separating `controllers`, `services`, and `lib`.
However, the codebase suffers from several technical debt issues, particularly in tooling, developer experience, and test environment reliability. The `eslint` configuration is outdated and throws errors due to inline comments and duplicate global variable declarations in tests. The global test setup for `@sentry/node` causes failures due to missing dependencies unless manually installed, and some `let` declarations are placed far from their usage. Package management is migrating to `pnpm`, but there are several deprecated packages and a mismatch between the configured Node.js engine and the current development environment.

## 2. High-impact improvements
*   **Modernize Linter and Formatting Tools:** The current ESLint setup uses the deprecated version 7.32.0 (or version 8 unsupported) and an old `.eslintrc.json`. It strictly forbids inline comments, which causes extensive linting errors and degrades developer experience when documenting complex logic.
    *   **Recommendation:** Migrate to the modern flat config (`eslint.config.js`), upgrade to ESLint v9+, and configure Prettier for formatting. Disable rules like `no-inline-comments` and correctly specify `jest` in the environment so global variables (`describe`, `it`, `jest`) do not trigger `no-redeclare` errors.
*   **Refactor Global Test Mocks:** The test suite uses a global `jest.mock('@sentry/node')` in `tests/setup.js`. This is fragile because if a test does not transitively depend on the mocked package, or if the package isn't properly installed in the testing environment, Jest throws a `Cannot find module` error and fails the suite.
    *   **Recommendation:** Move Sentry mocking into a centralized helper or explicitly mock it only in the integration tests that require it. Alternatively, abstract the Sentry service completely behind an interface so tests only mock the internal `sentryService` without intercepting the `node_modules` package directly.
*   **Upgrade Deprecated Dependencies:** The project relies on deprecated packages (`request`, `uuid@3`, `har-validator`, `glob@7`).
    *   **Recommendation:** Audit and replace these dependencies. Use the native `fetch` API (available in Node 20+) instead of `request`, upgrade `uuid` to v9/v10, and update `glob` to v10+ to fix security vulnerabilities and ensure long-term maintainability.

## 3. Low-effort quick wins
*   **Fix ESLint Errors:** Run a global search-and-replace to fix `no-trailing-spaces`, remove or reformat inline comments if the rule is kept, and clean up unused variables (`no-unused-vars`) highlighted by the linter.
*   **Localize Variables in Handlers:** In `src/controllers/webhooks/handlers/alert/alert.js`, `alertText`, `alert`, and `enriched` are declared with `let` at the top of the `try` block but mutated deeply inside.
    *   **Recommendation:** Declare variables closer to where they are first used or returned.
*   **Package Manager Consistency:** The repo has both `package-lock.json` and `pnpm-lock.yaml`.
    *   **Recommendation:** Delete `package-lock.json` and enforce `pnpm` exclusively by adding a `preinstall` script (`"preinstall": "npx only-allow pnpm"`).
*   **Update Node Engine:** `package.json` specifies `"node": "20.x"`, but `pnpm` warns that v22 is used. Update the engine requirement to `">=20.x"` to support modern LTS versions without throwing warnings.

## 4. Risky or fragile areas
*   **Notification Error Handling (Graceful Degradation):** The notification loop uses `Promise.allSettled` to catch failures per channel. While this prevents a failing channel from blocking another, the error reporting to Sentry in `NotificationManager.js` accesses `r.reason.message` without fully validating the shape of `r.reason`. If `r.reason` is a string or `undefined`, this could throw an error mid-flight.
*   **Complex Conditional Enrichment Flow:** `alert.js` handles multiple providers (Gemini, TradingView). The logic for conditionally appending results deeply mutates the `alert` object. This makes the code harder to test in isolation.
*   **Deduplication Cache TTL:** The in-memory deduplication cache is a potential source of memory leaks if event categories grow unbounded, as it stores keys with a TTL but relies on manual pruning or application restarts. Redis should be considered for production.

## 5. Suggested roadmap
1.  **Phase 1 (Immediate):** Clean up tooling. Remove `package-lock.json`, configure Prettier, upgrade to ESLint v9, and fix the Jest `no-redeclare` errors by adding `jest: true` to the linter environment configuration.
2.  **Phase 2 (Short-term):** Fix the test environment. Refactor `tests/setup.js` to handle Sentry mocking safely. Update deprecated dependencies (`uuid`, `request`) and verify tests pass.
3.  **Phase 3 (Medium-term):** Refactor the `alert.js` handler. Extract the enrichment logic into a dedicated service method to keep the controller lean and focused solely on HTTP request/response handling.
4.  **Phase 4 (Long-term):** Migrate in-memory caches (Rate Limiter, News Monitor Deduplication) to Redis to support horizontal scaling, as the current state prevents running multiple instances of the bot. Add structured JSON logging (e.g., Pino) for better observability.

## 6. Example code snippets where relevant

**Refactoring `alert.js` Controller for clarity:**
*Before:*
```javascript
let alertText = '';
let alert = null;
let enriched = false;
// ... long try/catch block with deep mutation
```

*After:*
```javascript
function postAlert(bot) {
	return async (req, res) => {
		try {
			const alertText = typeof req.body === 'object' && req.body.text ? req.body.text : req.body;
			const { text } = validateAlert(alertText);
			const baseAlert = { text };

			const enrichedAlert = await processEnrichment(baseAlert, req.query);

			const results = await notificationManager.sendToAll(enrichedAlert);

			res.json({
				success: true,
				results,
				enriched: !!enrichedAlert.enriched,
				tokenUsage: enrichedAlert.tokenUsage
			});
		} catch (error) {
			handleAlertError(error, req, res);
		}
	};
}
```

**Fixing Jest Global Mocks in `eslint.config.js`:**
```javascript
import jest from "eslint-plugin-jest";

export default [
  {
    files: ["tests/**/*.js"],
    plugins: { jest },
    languageOptions: {
      globals: {
        ...jest.environments.globals.globals,
      },
    },
  },
];
```
