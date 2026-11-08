/**
 * Issue #721 — the module-resolution cache in `resolveRemoteOverride.js` is
 * load-bearing, and this suite exists to detect its removal.
 *
 * It lives in its own file because proving the cache requires `jest.resetModules()`
 * plus a swappable export from `RemoteConfigService`, and both of those contaminate
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

	function loadWithGetter(getRemoteOverride) {
		jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({ getRemoteOverride }));
		jest.resetModules();
		// eslint-disable-next-line global-require
		const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
		// eslint-disable-next-line global-require
		const helper = require('../../src/services/remoteConfig/resolveRemoteOverride');
		return { helper, remoteConfigService };
	}

	it('resolves the RemoteConfig module once and reuses that reference', () => {
		const originalGetter = jest.fn(() => true);
		const replacementGetter = jest.fn(() => false);
		const { helper, remoteConfigService } = loadWithGetter(originalGetter);
		helper.resetRemoteOverrideCacheForTesting();

		expect(helper.resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBe(true);
		remoteConfigService.getRemoteOverride = replacementGetter;

		// A fresh property lookup would now return false. The cached function
		// reference continues to use the getter captured by the first resolution.
		expect(helper.resolveRemoteOverride('ENABLE_FIRESTORE_JOB_STORAGE')).toBe(true);
		expect(originalGetter).toHaveBeenCalledTimes(2);
		expect(replacementGetter).not.toHaveBeenCalled();
	});

	it('re-resolves after the cache is explicitly reset', () => {
		const originalGetter = jest.fn(() => true);
		const replacementGetter = jest.fn(() => false);
		const { helper, remoteConfigService } = loadWithGetter(originalGetter);
		helper.resetRemoteOverrideCacheForTesting();
		expect(helper.resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBe(true);

		remoteConfigService.getRemoteOverride = replacementGetter;
		expect(helper.resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBe(true);
		helper.resetRemoteOverrideCacheForTesting();
		expect(helper.resolveRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBe(false);
		expect(originalGetter).toHaveBeenCalledTimes(2);
		expect(replacementGetter).toHaveBeenCalledTimes(1);
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
