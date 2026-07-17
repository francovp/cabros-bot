'use strict';

(function exposeRequestHelper(root, factory) {
	const api = factory();

	if (typeof module === 'object' && module.exports) {
		module.exports = api;
		return;
	}

	root.CabrosAdminRequest = api;
}(typeof window === 'undefined' ? globalThis : window, () => {
	const confirmations = {
		'POST /api/alerts/{alertId}/replay': 'Replay this alert?',
		'POST /api/scanner-presets/{id}/run': 'Run this scanner preset?',
		'DELETE /api/scanner-presets/{id}': 'Delete this scanner preset?',
		'POST /api/jobs/{jobId}/cancel': 'Cancel this job?',
		'POST /api/jobs/{jobId}/retry': 'Retry this job?',
		'POST /api/jobs/{jobId}/retry-failed': 'Retry failed items for this job?',
	};

	const hasJsonBody = (body) => body !== undefined && body !== null
		&& (!Array.isArray(body) || body.length > 0)
		&& (typeof body !== 'object' || Object.keys(body).length > 0);

	const validateQuery = (query) => {
		if (query === undefined) return query;
		if (query === null || typeof query !== 'object' || Array.isArray(query)) {
			throw new Error('Query must be a JSON object.');
		}
		if (Object.keys(query).some((key) => ['api-key', 'x-api-key'].includes(key.toLowerCase()))) {
			throw new Error('Query credentials are not allowed; use the API key field.');
		}
		return query;
	};

	const redactSecret = (value, secret) => {
		if (!secret) return String(value);
		const raw = String(secret);
		const escaped = JSON.stringify(raw).slice(1, -1);
		return [...new Set([raw, escaped])]
			.sort((left, right) => right.length - left.length)
			.reduce((redacted, variant) => redacted.split(variant).join('[REDACTED]'), String(value));
	};

	const operationDefinitions = (contract) => Object.entries(contract.paths)
		.flatMap(([path, methods]) => Object.entries(methods)
			.filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
			.map(([method, operation]) => {
				const upperMethod = method.toUpperCase();
				return {
					method: upperMethod,
					path,
					label: operation.summary || `${upperMethod} ${path}`,
					confirm: confirmations[`${upperMethod} ${path}`],
				};
			}))
		.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));

	const confirmRequest = (definition, confirm) => !definition.confirm || confirm(definition.confirm);

	const createRequest = ({ path, method, query, body, apiKey }) => {
		if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('?') || path.includes('#')) {
			throw new Error('API path must start with /api/');
		}
		validateQuery(query);

		const params = new URLSearchParams();
		Object.entries(query || {}).forEach(([key, value]) => {
			if (value !== undefined) params.set(key, value);
		});

		const headers = {};
		const options = { method, headers };
		if (hasJsonBody(body)) {
			headers['Content-Type'] = 'application/json';
			options.body = JSON.stringify(body);
		}
		if (apiKey) headers['x-api-key'] = apiKey;

		const search = params.toString();
		return { url: search ? `${path}?${search}` : path, options };
	};

	return {
		confirmRequest,
		createRequest,
		operationDefinitions,
		redactSecret,
		validateQuery,
	};
}));
