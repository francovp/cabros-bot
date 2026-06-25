const fs = require('fs');
const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { getRoutes } = require('../../src/routes');

const contractPath = path.join(__dirname, '../../src/openapi/openapi.json');

function normalizeExpressPath(routePath) {
	return `/api${routePath}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function getMountedApiOperations() {
	return getRoutes(null).stack
		.filter((layer) => layer.route)
		.flatMap((layer) => Object.keys(layer.route.methods)
			.filter((method) => layer.route.methods[method])
			.map((method) => `${method.toUpperCase()} ${normalizeExpressPath(layer.route.path)}`))
		.sort();
}

function getDocumentedApiOperations(contract) {
	return Object.entries(contract.paths)
		.flatMap(([routePath, pathItem]) => Object.keys(pathItem)
			.filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
			.map((method) => `${method.toUpperCase()} ${routePath}`))
		.filter((operation) => operation.includes(' /api/'))
		.sort();
}

describe('OpenAPI contract', () => {
	it('exists as the canonical JSON source', () => {
		expect(fs.existsSync(contractPath)).toBe(true);
	});

	it('documents every mounted API operation without stale operations', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

		expect(getDocumentedApiOperations(contract)).toEqual(getMountedApiOperations());
	});

	it('is a valid OpenAPI document', async () => {
		if (!fs.existsSync(contractPath)) return;

		await expect(SwaggerParser.validate(contractPath)).resolves.toBeDefined();
	});

	it('requires the documented API-key schemes on every protected operation', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const operations = Object.entries(contract.paths)
			.filter(([routePath]) => routePath.startsWith('/api/'))
			.flatMap(([, pathItem]) => Object.values(pathItem))
			.filter((operation) => operation && operation.responses);

		for (const operation of operations) {
			expect(operation.security).toEqual([
				{ ApiKeyHeader: [] },
				{ ApiKeyQuery: [] },
			]);
		}
	});

	it('keeps the shared analysis response generic outside news-monitor', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

		expect(contract.components.responses.AnalysisResult.content['application/json'].schema).toEqual({
			$ref: '#/components/schemas/JsonObject',
		});
		expect(contract.paths['/api/news-monitor'].get.responses['200']).toEqual({
			$ref: '#/components/responses/NewsMonitorAnalysisResult',
		});
		expect(contract.paths['/api/news-monitor'].post.responses['200']).toEqual({
			$ref: '#/components/responses/NewsMonitorAnalysisResult',
		});
	});
});
