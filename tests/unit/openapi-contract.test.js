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

	describe('Job schema alignment with JobService runtime', () => {
		// The runtime terminal statuses are defined in JobService as:
		// TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out'])
		// The full status lifecycle also includes 'pending' and 'processing'.
		const RUNTIME_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out'];
		const RUNTIME_ALL_STATUSES = ['pending', 'processing', ...RUNTIME_TERMINAL_STATUSES];

		// The valid callbackEvents accepted by JobService runtime validation:
		// validEvents = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'processing'])
		const RUNTIME_CALLBACK_EVENTS = ['completed', 'failed', 'cancelled', 'timed_out', 'processing'];

		it('Job.status enum matches the runtime status set exactly (no missing or extra values)', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const jobStatusEnum = contract.components.schemas.Job.properties.status.enum;
			expect([...jobStatusEnum].sort()).toEqual([...RUNTIME_ALL_STATUSES].sort());
		});

		it('Job.status enum does not contain stale "canceled" (American spelling)', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const jobStatusEnum = contract.components.schemas.Job.properties.status.enum;
			expect(jobStatusEnum).not.toContain('canceled');
		});

		it('Job.status enum contains "cancelled" (British spelling) and "timed_out"', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const jobStatusEnum = contract.components.schemas.Job.properties.status.enum;
			expect(jobStatusEnum).toContain('cancelled');
			expect(jobStatusEnum).toContain('timed_out');
		});

		it('CallbackFields schema documents callbackUrl, callbackSecret, callbackEvents, and timeoutMs', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const callbackFields = contract.components.schemas.CallbackFields;
			expect(callbackFields).toBeDefined();
			expect(callbackFields.properties).toHaveProperty('callbackUrl');
			expect(callbackFields.properties).toHaveProperty('callbackSecret');
			expect(callbackFields.properties).toHaveProperty('callbackEvents');
			expect(callbackFields.properties).toHaveProperty('timeoutMs');
		});

		it('callbackEvents enum in CallbackFields matches runtime validEvents exactly', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const callbackEventsEnum = contract.components.schemas.CallbackFields.properties.callbackEvents.items.enum;
			expect([...callbackEventsEnum].sort()).toEqual([...RUNTIME_CALLBACK_EVENTS].sort());
		});

		it('TradingViewJobRequest references CallbackFields for both expanded-analysis and market-scanner variants', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const jobRequestSchema = contract.components.schemas.TradingViewJobRequest;

			// Both oneOf variants must include the CallbackFields allOf reference
			for (const variant of jobRequestSchema.oneOf) {
				const hasCallbackRef = variant.allOf.some(
					(entry) => entry.$ref === '#/components/schemas/CallbackFields',
				);
				expect(hasCallbackRef).toBe(true);
			}
		});

		it('timeoutMs in CallbackFields has correct minimum, maximum, and default', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const timeoutMs = contract.components.schemas.CallbackFields.properties.timeoutMs;
			expect(timeoutMs.minimum).toBe(1);
			expect(timeoutMs.maximum).toBe(600000); // 10 minutes hard cap
			expect(timeoutMs.default).toBe(300000); // 5 minutes default
		});
	});
});
