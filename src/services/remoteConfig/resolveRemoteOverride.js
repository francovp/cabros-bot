/**
 * Issue #721 — safe resolution of a *published* Firebase Remote Config value.
 *
 * Feature gates that may be set either by the deployment or by a published
 * Remote Config template need `remote ?? env` semantics: a published value must
 * win even when it is `false`, and the absence of a published value must fall
 * through to the environment rather than coerce to a default.
 *
 * `RemoteConfigService.getRuntimeConfig()` cannot express that. It returns a
 * value for *every* schema key, environment-derived when the Remote Config gate
 * is off, so "Remote Config said false" is indistinguishable from "the
 * environment says false". `getRemoteOverride()` answers the narrower question
 * and returns `undefined` when there is no evidence.
 *
 * Two properties this wrapper guarantees, both load-bearing:
 *
 * 1. **Fail-open.** A missing module, a build without `getRemoteOverride`, or a
 *    throwing loader all resolve to `undefined`, so the caller keeps using the
 *    deployment's own value. Remote Config is an enhancement; it must never be
 *    able to turn a configured gate off by failing.
 * 2. **No repeated module resolution.** The module reference is cached on first
 *    use. Storage predicates run on request and async-continuation paths, and a
 *    `require()` per call both costs a registry lookup and can fire after the
 *    Jest environment has been torn down — which surfaces as an unhandled
 *    `ReferenceError` from a completed test rather than as a failed assertion.
 *    The cache is deliberately never invalidated: the module is a singleton for
 *    the process lifetime, and caching preserves `jest.resetModules()` isolation
 *    for suites that re-`require` this file.
 */
let cachedGetRemoteOverride = null;
let resolved = false;

function resolveGetter() {
	if (resolved) {
		return cachedGetRemoteOverride;
	}
	resolved = true;
	try {
		// Required lazily to avoid a module-load cycle: RemoteConfigService reaches
		// Firestore initialization, which reaches these storage services.
		// eslint-disable-next-line global-require
		const remoteConfigService = require('./RemoteConfigService');
		cachedGetRemoteOverride =
			typeof remoteConfigService.getRemoteOverride === 'function'
				? remoteConfigService.getRemoteOverride
				: null;
	} catch {
		cachedGetRemoteOverride = null;
	}
	return cachedGetRemoteOverride;
}

/**
 * @param {string} key A key declared in `PARAMETER_SCHEMA`.
 * @returns {boolean|number|string|undefined} The published value, or `undefined`
 *   when Remote Config supplies none — which is not evidence about the gate.
 */
function resolveRemoteOverride(key) {
	const getter = resolveGetter();
	if (typeof getter !== 'function') {
		return undefined;
	}
	try {
		return getter(key);
	} catch {
		return undefined;
	}
}

/** Reset the cached module reference. Test-only. */
function resetRemoteOverrideCacheForTesting() {
	cachedGetRemoteOverride = null;
	resolved = false;
}

module.exports = {
	resolveRemoteOverride,
	resetRemoteOverrideCacheForTesting,
};