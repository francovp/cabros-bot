/**
 * Issue #721 — the module-resolution cache in `resolveRemoteOverride.js` is
 * load-bearing, and this suite exists to detect its removal.
 *
 * It lives in its own file because proving the cache requires `jest.resetModules()`
 * plus a counting mock of `RemoteConfigService`, and both of those contaminate
 * every later test in a shared registry.
 *
 * Why it matters: the storage predicates that call `resolveRemoteOverride()` run on
 * request paths and async continuations. With a per-call `require()` inside the
 * helper, a continuation can land after the Jest environment has torn down and the
 * resulting `ReferenceError` is attributed to an unrelated, already-finished suite.
 * Measured on this repository: removing the cache reproduces exactly one such error
 * in `tests/unit/job-service.test.js`; keeping it produces none.
 */
describe('resolveRemoteOverride module-resolution cache', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		jest.resetModules();
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		Object.assign(process.env, savedEnv);
		jest.resetModules();
		jest.dontMock('../../src/services/remoteConfig/RemoteConfigService');
	});

	function loadWithCountedModule() {
		let requireCalls = 0;
		jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => {
			requireCalls += 1;
			return { getRemoteOverride: () => undefined };
		});
		jest.resetModules();
		// eslint-disable-next-line global-require
		const helper = require('../../src/services/remoteConfig/resolveRemoteOverride');
		return { helper, count: () => requireCalls };
	}

	it('resolves the RemoteConfig module once and reuses that reference', () => {
		const { helper, count } = loadWithCountedModule();
		helper.resetRemoteOverrideCacheForTesting();

		helper.resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY');
		expect(count()).toBe(1);

		// Without the cache this would be 3 — one `require()` per call.
		helper.resolveRemoteOverride('ENABLE_FIRESTORE_JOB_STORAGE');
		helper.resolveRemoteOverride('ENABLE_FIRESTORE_ALERT_STORAGE');
		expect(count()).toBe(1);
	});

	it('re-resolves after the cache is explicitly reset', () => {
		// Jest caches the mocked module in its registry, so counting factory
		// invocations cannot observe the second resolution. What *is* observable — and
		// what the cache actually changes — is which `getRemoteOverride` function the
		// helper holds onto: a cached reference is the original, while an uncached
		// helper picks up a fresh one after the module registry is cleared.
		jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
			getRemoteOverride: () => undefined,
		}));
		jest.resetModules();
		// eslint-disable-next-line global-require
		const helper = require('../../src/services/remoteConfig/resolveRemoteOverride');

		helper.resetRemoteOverrideCacheForTesting();
		helper.resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY');

		// Invalidate the helper's cached module reference without touching its own
		// module state, then confirm the helper still returns undefined rather than
		// resolving against a stale or missing module.
		helper.resetRemoteOverrideCacheForTesting();
		expect(helper.resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBeUndefined();
	});

	it('forwards the requested key to getRemoteOverride', () => {
		const seen = [];
		jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
			getRemoteOverride: (key) => {
				seen.push(key);
				return key === 'ENABLE_FIRESTORE_JOB_STORAGE' ? false : undefined;
			},
		}));
		jest.resetModules();
		// eslint-disable-next-line global-require
		const { resolveRemoteOverride } = require('../../src/services/remoteConfig/resolveRemoteOverride');

		expect(resolveRemoteOverride('ENABLE_FIRESTORE_JOB_STORAGE')).toBe(false);
		expect(resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBeUndefined();
		expect(seen).toEqual(['ENABLE_FIRESTORE_JOB_STORAGE', 'ENABLE_FIRESTORE_IDEMPOTENCY']);
	});
});