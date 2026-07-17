'use strict';

(function exposeRequestHelper(root, factory) {
	const api = factory();

	if (typeof module === 'object' && module.exports) {
		module.exports = api;
		return;
	}

	root.CabrosAdminRequest = api;
}(typeof window === 'undefined' ? globalThis : window, () => {
	const hasJsonBody = (body) => body !== undefined && body !== null
		&& (!Array.isArray(body) || body.length > 0)
		&& (typeof body !== 'object' || Object.keys(body).length > 0);

	const createRequest = ({ path, method, query, body, apiKey }) => {
		if (!path.startsWith('/api/')) {
			throw new Error('API path must start with /api/');
		}

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

	return { createRequest };
}));
