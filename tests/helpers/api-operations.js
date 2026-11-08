const { getRoutes } = require('../../src/routes');

function normalizeExpressPath(routePath) {
	return `/api${routePath}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function getMountedApiOperations() {
	const routerOperations = getRoutes(null).stack
		.filter((layer) => layer.route)
		.flatMap((layer) => Object.keys(layer.route.methods)
			.filter((method) => layer.route.methods[method])
			.map((method) => `${method.toUpperCase()} ${normalizeExpressPath(layer.route.path)}`));

	const app = require('../../app');
	const appOperations = [];
	for (const layer of app._router.stack) {
		if (!layer.route) continue;
		for (const method of Object.keys(layer.route.methods)) {
			if (!layer.route.methods[method]) continue;
			const routePath = layer.route.path;
			if (!routePath.startsWith('/api/')) continue;
			appOperations.push(`${method.toUpperCase()} ${routePath}`);
		}
	}

	return [...routerOperations, ...appOperations].sort();
}

module.exports = { getMountedApiOperations };
