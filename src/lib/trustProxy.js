// src/lib/trustProxy.js

/**
 * Parses TRUST_PROXY and RENDER environment configuration into an Express-compatible 'trust proxy' setting.
 *
 * @param {string|undefined} trustProxyEnv Value of process.env.TRUST_PROXY
 * @param {string|undefined} renderEnv Value of process.env.RENDER
 * @returns {boolean|number|string|Array<string>} Express trust proxy setting
 */
function parseTrustProxy(trustProxyEnv, renderEnv) {
	if (trustProxyEnv !== undefined && trustProxyEnv !== null && trustProxyEnv.trim() !== '') {
		const val = trustProxyEnv.trim();
		const lower = val.toLowerCase();
		if (lower === 'true') return true;
		if (lower === 'false') return false;
		if (/^\d+$/.test(val)) return parseInt(val, 10);
		if (val.includes(',')) {
			return val.split(',').map((s) => s.trim()).filter(Boolean);
		}
		return val;
	}

	// Default for Render reverse proxy deployments when TRUST_PROXY is not explicitly configured
	if (renderEnv === 'true') {
		return 1;
	}

	// Default for direct, unproxied deployments
	return false;
}

/**
 * Configures Express app trust proxy setting based on environment options.
 *
 * @param {import('express').Express} app Express application instance
 * @param {object} [env=process.env] Environment variables map
 */
function setupTrustProxy(app, env = process.env) {
	const setting = parseTrustProxy(env.TRUST_PROXY, env.RENDER);
	app.set('trust proxy', setting);
}

module.exports = {
	parseTrustProxy,
	setupTrustProxy,
};
