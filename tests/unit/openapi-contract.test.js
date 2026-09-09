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
	it('documents the concrete alert detail response including lastReplay', () => {
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const operation = contract.paths['/api/alerts/{alertId}'].get;

		expect(operation.responses['200'].$ref).toBe('#/components/responses/AlertDetailResult');
		expect(contract.components.responses.AlertDetailResult.content['application/json'].schema.$ref)
			.toBe('#/components/schemas/AlertDetail');
		expect(contract.components.schemas.AlertDetail.required).toEqual(
			expect.arrayContaining(['success', 'alert', 'lastReplay']),
		);
		expect(contract.components.schemas.AlertDetail.properties.alert.$ref).toBe('#/components/schemas/StoredAlert');
		expect(contract.components.schemas.AlertDetail.properties.lastReplay.oneOf).toEqual(expect.arrayContaining([
			{ $ref: '#/components/schemas/ReplayAttempt' },
			{ type: 'null' },
		]));
	});

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
			.flatMap(([path, pathItem]) => Object.entries(pathItem)
				.filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
				.map(([method, operation]) => ({ ...operation, method: method.toUpperCase(), path })))
			.filter((operation) => operation && operation.responses);

		const firebaseAdminOperations = new Set([
			'GET /api/alerts', 'GET /api/alerts/replays', 'GET /api/alerts/summary', 'GET /api/alerts/export',
			'GET /api/alerts/{alertId}', 'POST /api/alerts/{alertId}/replay',
			'GET /api/scanner-presets', 'POST /api/scanner-presets',
			'GET /api/scanner-presets/{id}', 'PUT /api/scanner-presets/{id}',
			'DELETE /api/scanner-presets/{id}', 'POST /api/scanner-presets/{id}/run',
			'POST /api/jobs/tradingview-analysis', 'GET /api/jobs', 'GET /api/jobs/{jobId}',
			'POST /api/jobs/{jobId}/cancel', 'POST /api/jobs/{jobId}/retry',
			'POST /api/jobs/{jobId}/retry-failed', 'GET /api/outcomes', 'GET /api/outcomes/summary', 'GET /api/trading/binance/orders', 'POST /api/trading/binance/orders', 'DELETE /api/trading/binance/orders', 'GET /api/status', 'GET /api/capabilities',
			'POST /api/news-monitor/pause', 'POST /api/news-monitor/resume', 'GET /api/news-monitor/status',
		]);

		for (const operation of operations) {
			const operationKey = `${operation.method || 'UNKNOWN'} ${operation.path || ''}`;
			const expected = [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }];
			if (firebaseAdminOperations.has(operationKey)) expected.push({ FirebaseBearerAuth: [] });
			expect(operation.security).toEqual(expected);
		}
	});

	it('marks Firebase-backed admin operations with viewer or operator roles', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const expectedRoles = {
			'GET /api/status': 'admin.viewer',
			'GET /api/outcomes': 'admin.viewer',
			'GET /api/outcomes/summary': 'admin.viewer',
			'GET /api/trading/binance/orders': 'admin.viewer',
			'POST /api/trading/binance/orders': 'admin.operator',
			'DELETE /api/trading/binance/orders': 'admin.operator',
			'GET /api/alerts': 'admin.viewer',
			'GET /api/jobs': 'admin.viewer',
			'POST /api/alerts/{alertId}/replay': 'admin.operator',
			'POST /api/scanner-presets': 'admin.operator',
			'POST /api/jobs/{jobId}/cancel': 'admin.operator',
			'POST /api/news-monitor/pause': 'admin.operator',
			'POST /api/news-monitor/resume': 'admin.operator',
			'GET /api/news-monitor/status': 'admin.viewer',
		};

		for (const [key, role] of Object.entries(expectedRoles)) {
			const [method, path] = key.split(' ');
			expect(contract.paths[path][method.toLowerCase()]['x-admin-role']).toBe(role);
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

	it('documents the summary shadow metrics object and no-measurements string forms', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const shadowModeMetrics = contract.components.schemas.AlertSummary.properties.shadowModeMetrics;

		expect(shadowModeMetrics.$ref).toBe('#/components/schemas/ShadowModeMetrics');
		expect(shadowModeMetrics.description).toContain('hitRatePercent');
		expect(shadowModeMetrics.description).toContain('targetHitRatePercent');
		expect(shadowModeMetrics.description).toContain('expectancyR');

		const shadowModeMetricsSchema = contract.components.schemas.ShadowModeMetrics;
		expect(shadowModeMetricsSchema.oneOf).toEqual(expect.arrayContaining([
			{
				type: 'string',
				enum: ['No measurements found'],
			},
			{ $ref: '#/components/schemas/OutcomesSummary' },
		]));
	});

	it('documents the X-Shadow-Mode-Metrics header on GET /api/alerts/export', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const exportResponse = contract.paths['/api/alerts/export'].get.responses['200'];

		expect(exportResponse.headers).toBeDefined();
		expect(exportResponse.headers['X-Shadow-Mode-Metrics']).toEqual({
			description: expect.stringContaining('SignalOutcomeService.getMetricsSummary'),
			schema: { type: 'string' },
		});
	});

	it('documents generic-message idempotency key locations and replay conflicts', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const operation = contract.paths['/api/webhook/message'].post;

		expect(operation.parameters).toEqual(expect.arrayContaining([
			{ $ref: '#/components/parameters/IdempotencyKeyHeader' },
			{ $ref: '#/components/parameters/IdempotencyKeyQueryCamel' },
			{ $ref: '#/components/parameters/IdempotencyKeyQuerySnake' },
		]));
		expect(operation.responses['200']).toEqual({
			$ref: '#/components/responses/MessageDeliveryResult',
		});
		expect(operation.responses['409']).toEqual({
			$ref: '#/components/responses/MessageIdempotencyConflict',
		});
		expect(contract.components.schemas.MessageRequest.properties.idempotencyKey).toBeDefined();
		expect(contract.components.schemas.MessageRequest.properties.idempotency_key).toBeDefined();
		expect(contract.components.responses.MessageDeliveryResult.content['application/json'].examples.replay.value)
			.toMatchObject({ success: true, idempotencyReplayed: true });
		expect(contract.components.responses.IdempotencyConflict.description)
			.toBe('The idempotency key was reused with a different request fingerprint');
		expect(contract.components.responses.MessageIdempotencyConflict.content['application/json'].example).toEqual({
			error: 'Idempotency key was reused with a different payload',
			code: 'IDEMPOTENCY_CONFLICT',
		});
	});

	it('aligns symbol analysis schema with runtime normalization', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const schema = contract.components.schemas.SymbolAnalysisRequest;

		expect(schema.properties.symbol.pattern).toBe('^[A-Za-z0-9_]+:[A-Za-z0-9._-]+$');
		expect(schema.properties.timeframe).not.toHaveProperty('default');
		expect(schema.description).toContain('TRADINGVIEW_MCP_DEFAULT_TIMEFRAME');
		expect(schema.properties.timeframe.enum).toEqual(expect.arrayContaining(['60', '240', 'D', 'W', 'M']));
		expect(schema.properties).toHaveProperty('analysis_mode');
		expect(schema.properties).toHaveProperty('include_multi_timeframe');
	});

	it('documents idempotency conflicts for header-backed alert operations', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const expectedResponses = {
			'/api/webhook/alert': 'IdempotencyConflict',
			'/api/webhook/expanded-analysis-alert': 'IdempotencyConflict',
			'/api/webhook/market-scanner-alert': 'IdempotencyConflict',
			'/api/alerts/{alertId}/replay': 'IdempotencyConflict',
		};

		for (const [routePath, responseName] of Object.entries(expectedResponses)) {
			expect(contract.paths[routePath].post.responses['409']).toEqual({
				$ref: `#/components/responses/${responseName}`,
			});
		}
	});

	it('documents current_price and price_data in the enrichedData schema', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const enrichedData = contract.components.schemas.DeliveryResult.properties.payload.properties.enrichedData;

		expect(enrichedData.properties.current_price.type).toEqual(['number', 'null']);
		expect(enrichedData.properties.price_data).toMatchObject({
			type: ['object', 'null'],
			additionalProperties: true,
		});
	});

	it('declares suppressedRepeat in the alert delivery response schema', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		expect(contract.components.schemas.DeliveryResult.properties.suppressedRepeat).toEqual({
			type: 'boolean',
			description: 'True when this alert was persisted without channel delivery because it repeated a recent signal.',
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
			expect(callbackFields.description).toContain('x-callback-delivery-id');
			expect(callbackFields.description).toContain('raw JSON body');
		});

		it('CallbackFields and callbackSecret schema document HMAC signature header and state raw secret is not transmitted', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const callbackFields = contract.components.schemas.CallbackFields;
			expect(callbackFields.description).toContain('x-callback-signature');
			expect(callbackFields.description).toContain('HMAC-SHA256');
			expect(callbackFields.description).toContain('The secret itself is never transmitted');
			expect(callbackFields.properties.callbackSecret.description).toContain('x-callback-signature');
			expect(callbackFields.properties.callbackSecret.description).toContain('never transmitted');
		});

		it('CallbackFields description header names match JobService runtime callback headers without stale X-Callback-Secret claims', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const desc = contract.components.schemas.CallbackFields.description;
			const requiredHeaders = [
				'x-callback-timestamp',
				'x-callback-event',
				'x-callback-delivery-id',
				'x-callback-signature',
			];
			for (const header of requiredHeaders) {
				expect(desc).toContain(header);
			}
			expect(desc).not.toContain('X-Callback-Secret');
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
