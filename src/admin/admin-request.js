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
					requiredRole: operation['x-admin-role'] || (upperMethod === 'GET' ? 'admin.viewer' : 'admin.operator'),
				};
			}))
		.sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method));

	const confirmRequest = (definition, confirm) => !definition.confirm || confirm(definition.confirm);

	const createRequest = ({ path, method, query, body, apiKey, authToken, baseUrl }) => {
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
		if (authToken) headers.Authorization = `Bearer ${authToken}`;

		const search = params.toString();
		const prefix = baseUrl ? String(baseUrl).replace(/\/+$/, '') : '';
		const fullPath = `${prefix}${path}`;
		return { url: search ? `${fullPath}?${search}` : fullPath, options };
	};

	const getAdminRole = (claims = {}) => {
		const roles = Array.isArray(claims.roles) ? claims.roles : [];
		if (claims['admin.operator'] === true || claims.adminRole === 'admin.operator'
			|| claims.role === 'admin.operator' || roles.includes('admin.operator')
			|| claims.admin && claims.admin.operator === true) return 'admin.operator';
		if (claims['admin.viewer'] === true || claims.adminRole === 'admin.viewer'
			|| claims.role === 'admin.viewer' || roles.includes('admin.viewer')
			|| claims.admin && claims.admin.viewer === true) return 'admin.viewer';
		return null;
	};

	const CONTRACT_TIMEOUT_MS = 8000;
	const AUTH_CONFIG_TIMEOUT_MS = 8000;
	const API_REQUEST_TIMEOUT_MS = 30000;

	// Volume confirmation budget breakdown:
	// - 3 sequential TradingView MCP JSON-RPC requests (initialize, notifications/initialized, tools/call)
	// - Max TRADINGVIEW_MCP_TIMEOUT_MS: 120,000 ms per RPC
	// - Ingress, route handling, Firestore claim, and network transport overhead: 30,000 ms
	const VOLUME_CONFIRMATION_MCP_CALLS = 3;
	const TRADINGVIEW_MCP_MAX_TIMEOUT_MS = 120000;
	const VOLUME_CONFIRMATION_OVERHEAD_MS = 30000;
	const VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS = (VOLUME_CONFIRMATION_MCP_CALLS * TRADINGVIEW_MCP_MAX_TIMEOUT_MS) + VOLUME_CONFIRMATION_OVERHEAD_MS; // 390000 ms

	// Long-running alert and analysis pipeline budget breakdown:
	// - TradingView MCP enrichment maximum budget: 120,000 ms (TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS max)
	// - Gemini Grounding analysis maximum timeout: 120,000 ms (GROUNDING_TIMEOUT_MS max)
	// - Total enrichment stage: 240,000 ms
	// - Notification delivery (Discord multi-chunk delivery with retries):
	//   - Max 3 message chunks (2,000 chars per chunk)
	//   - Per chunk: initial attempt (10,000 ms) + up to 10 retries (10 * 10,000 ms = 100,000 ms) + max retry backoff wait (120,000 ms) = 230,000 ms
	//   - 3 chunks * 230,000 ms = 690,000 ms
	// - Combined backend worst-case budget: 240,000 ms + 690,000 ms = 930,000 ms
	// - Network transport, parsing, and execution overhead: 60,000 ms
	const TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS = 120000;
	const GROUNDING_MAX_TIMEOUT_MS = 120000;
	const DISCORD_MAX_CHUNKS = 3;
	const DISCORD_REQUEST_TIMEOUT_MS = 10000;
	const DISCORD_MAX_RETRIES = 10;
	const DISCORD_MAX_TOTAL_RETRY_WAIT_MS = 120000;
	const DISCORD_MAX_CHUNK_BUDGET_MS = DISCORD_REQUEST_TIMEOUT_MS + (DISCORD_MAX_RETRIES * DISCORD_REQUEST_TIMEOUT_MS) + DISCORD_MAX_TOTAL_RETRY_WAIT_MS; // 230000 ms
	const DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS = DISCORD_MAX_CHUNKS * DISCORD_MAX_CHUNK_BUDGET_MS; // 690000 ms
	const LONG_RUNNING_BACKEND_BUDGET_MS = TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS + GROUNDING_MAX_TIMEOUT_MS + DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS; // 930000 ms
	const LONG_RUNNING_OVERHEAD_MS = 60000;
	const LONG_RUNNING_API_REQUEST_TIMEOUT_MS = LONG_RUNNING_BACKEND_BUDGET_MS + LONG_RUNNING_OVERHEAD_MS; // 990000 ms

	const LONG_RUNNING_REQUEST_PATHS = new Set([
		'/api/webhook/expanded-analysis-alert',
		'/api/webhook/market-scanner-alert',
		'/api/news-monitor',
		'/api/scanner-presets/{id}/run',
		'/api/webhook/alert',
		'/api/webhook/message',
		'/api/alerts/{alertId}/replay',
	]);

	const getApiRequestTimeout = (definition) => {
		if (!definition || !definition.path) return API_REQUEST_TIMEOUT_MS;
		if (definition.path === '/api/webhook/volume-confirmation') return VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS;
		return LONG_RUNNING_REQUEST_PATHS.has(definition.path)
			? LONG_RUNNING_API_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS;
	};

	const canAccess = (definition, role) => !definition.requiredRole
		|| role === 'admin.operator'
		|| role === definition.requiredRole;

	return {
		API_REQUEST_TIMEOUT_MS,
		AUTH_CONFIG_TIMEOUT_MS,
		CONTRACT_TIMEOUT_MS,
		DISCORD_MAX_CHUNK_BUDGET_MS,
		DISCORD_MAX_CHUNKS,
		DISCORD_MAX_RETRIES,
		DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS,
		DISCORD_MAX_TOTAL_RETRY_WAIT_MS,
		DISCORD_REQUEST_TIMEOUT_MS,
		GROUNDING_MAX_TIMEOUT_MS,
		LONG_RUNNING_API_REQUEST_TIMEOUT_MS,
		LONG_RUNNING_BACKEND_BUDGET_MS,
		LONG_RUNNING_OVERHEAD_MS,
		LONG_RUNNING_REQUEST_PATHS,
		TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS,
		TRADINGVIEW_MCP_MAX_TIMEOUT_MS,
		VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS,
		VOLUME_CONFIRMATION_MCP_CALLS,
		VOLUME_CONFIRMATION_OVERHEAD_MS,
		canAccess,
		confirmRequest,
		createRequest,
		getAdminRole,
		getApiRequestTimeout,
		operationDefinitions,
		redactSecret,
		validateQuery,
	};
}));
