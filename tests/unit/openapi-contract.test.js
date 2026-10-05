const fs = require('fs');
const path = require('path');
const SwaggerParser = require('@apidevtools/swagger-parser');
const MarkdownV2Formatter = require('../../src/services/notification/formatters/markdownV2Formatter');
const { getRoutes } = require('../../src/routes');

const contractPath = path.join(__dirname, '../../src/openapi/openapi.json');

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

	it('documents per-symbol alert routing and symbol-scoped results', () => {
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const alertRequest = contract.components.schemas.AlertRequest;
		const symbolRoutes = alertRequest.properties.symbolRoutes;

		expect(symbolRoutes).toEqual(expect.objectContaining({
			type: 'object',
			minProperties: 1,
			propertyNames: expect.objectContaining({ type: 'string' }),
		}));
		expect(symbolRoutes.additionalProperties.required).toEqual(['channels']);
		expect(symbolRoutes.additionalProperties.properties.channels.items.enum)
			.toEqual(['telegram', 'whatsapp', 'discord']);
		expect(contract.components.schemas.DeliveryResult.properties.results.items.properties.symbol.type).toBe('string');
	});

	it('documents every mounted API operation without stale operations', () => {
		if (!fs.existsSync(contractPath)) return;
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

		expect(getDocumentedApiOperations(contract)).toEqual(getMountedApiOperations());
	});

	it('documents the request-timeout response on every API operation', () => {
		const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const missingTimeoutResponses = Object.entries(contract.paths)
			.filter(([routePath]) => routePath.startsWith('/api/'))
			.flatMap(([routePath, pathItem]) => Object.entries(pathItem)
				.filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
				.filter(([, operation]) => !operation.responses || !operation.responses['408'])
				.map(([method]) => `${method.toUpperCase()} ${routePath}`));

		expect(missingTimeoutResponses).toEqual([]);
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
			'POST /api/alerts/feedback', 'GET /api/alerts/feedback/summary',
			'POST /api/alerts/batch/replay', 'POST /api/alerts/batch/export', 'POST /api/alerts/batch/delete',
			'GET /api/scanner-presets', 'POST /api/scanner-presets',
			'GET /api/scanner-presets/{id}', 'PUT /api/scanner-presets/{id}',
			'DELETE /api/scanner-presets/{id}', 'POST /api/scanner-presets/{id}/run',
			'POST /api/jobs/tradingview-analysis', 'GET /api/jobs', 'GET /api/jobs/{jobId}',
			'POST /api/jobs/{jobId}/cancel', 'POST /api/jobs/{jobId}/retry',
			'POST /api/jobs/{jobId}/retry-failed', 'GET /api/outcomes', 'GET /api/outcomes/summary', 'GET /api/outcomes/calibration',
			'GET /api/symbol-analyses', 'GET /api/symbol-analyses/summary',
			'GET /api/trading/binance/orders', 'GET /api/trading/binance/orders/audit', 'POST /api/trading/binance/orders', 'DELETE /api/trading/binance/orders', 'GET /api/status', 'GET /api/capabilities',
			'POST /api/trading/binance/orders/preview',
			'POST /api/news-monitor/pause', 'POST /api/news-monitor/resume', 'GET /api/news-monitor/status',
			'GET /api/news-monitor/summary', 'GET /api/news-monitor/analyses',
			'POST /api/admin/test-alert', 'GET /api/admin/events',
			'GET /api/preferences/{channel}/{chatId}', 'PUT /api/preferences/{channel}/{chatId}', 'DELETE /api/preferences/{channel}/{chatId}',
			'GET /api/selftest', 'POST /api/selftest/run',
		]);

		const unauthenticatedOperations = new Set([
			'GET /api/public/status',
		]);

		for (const operation of operations) {
			const operationKey = `${operation.method || 'UNKNOWN'} ${operation.path || ''}`;
			if (unauthenticatedOperations.has(operationKey)) {
				expect(operation.security).toBeUndefined();
				continue;
			}
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
			'GET /api/outcomes/calibration': 'admin.viewer',
			'GET /api/symbol-analyses': 'admin.viewer',
			'GET /api/symbol-analyses/summary': 'admin.viewer',
			'GET /api/trading/binance/orders': 'admin.viewer',
			'GET /api/trading/binance/orders/audit': 'admin.viewer',
			'POST /api/trading/binance/orders/preview': 'admin.viewer',
			'POST /api/trading/binance/orders': 'admin.operator',
			'DELETE /api/trading/binance/orders': 'admin.operator',
			'GET /api/alerts': 'admin.viewer',
			'GET /api/jobs': 'admin.viewer',
			'POST /api/alerts/{alertId}/replay': 'admin.operator',
			'POST /api/alerts/batch/replay': 'admin.operator',
			'POST /api/alerts/batch/export': 'admin.viewer',
			'POST /api/alerts/batch/delete': 'admin.operator',
			'POST /api/scanner-presets': 'admin.operator',
			'POST /api/jobs/{jobId}/cancel': 'admin.operator',
			'POST /api/news-monitor/pause': 'admin.operator',
			'POST /api/news-monitor/resume': 'admin.operator',
			'GET /api/news-monitor/status': 'admin.viewer',
			'GET /api/news-monitor/summary': 'admin.viewer',
			'GET /api/news-monitor/analyses': 'admin.viewer',
			'POST /api/admin/test-alert': 'admin.operator',
			'GET /api/admin/events': 'admin.viewer',
			'GET /api/preferences/{channel}/{chatId}': 'admin.viewer',
			'PUT /api/preferences/{channel}/{chatId}': 'admin.operator',
			'DELETE /api/preferences/{channel}/{chatId}': 'admin.operator',
			'GET /api/selftest': 'admin.viewer',
			'POST /api/selftest/run': 'admin.operator',
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
			{ $ref: '#/components/parameters/XRequestIdHeader' },
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
		expect(contract.components.responses.MessageDeliveryResult.content['application/json'].examples.replay.value.requestId)
			.toEqual(expect.any(String));
		expect(contract.components.responses.MessageDeliveryResult.content['application/json'].examples.success.value.requestId)
			.toEqual(expect.any(String));
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

		it('documents NotificationRedriveDependency schema and references it under Status dependencies', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const redriveRef = contract.components.schemas.Status.properties.dependencies.properties.notificationRedrive;
			expect(redriveRef).toEqual({
				$ref: '#/components/schemas/NotificationRedriveDependency',
			});

			const redriveSchema = contract.components.schemas.NotificationRedriveDependency;
			expect(redriveSchema).toBeDefined();
			expect(redriveSchema.type).toBe('object');
			expect(redriveSchema.required).toEqual(
				expect.arrayContaining([
					'enabled',
					'configured',
					'ready',
					'status',
					'role',
					'workerRole',
					'running',
					'lastSweepResult',
				]),
			);

			const statusExample = contract.components.responses.StatusResult.content['application/json'].example;
			expect(statusExample.dependencies.notificationRedrive.maxAgeMs).toBe(3600000);
			expect(redriveSchema.properties.zeroChannelBroadcasts.description)
				.toContain('dropped because no notification channels were enabled');
		});

		it('documents NewsMonitorDedupDependency and NewsMonitorCacheSize under Status dependencies', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const dedupRef = contract.components.schemas.Status.properties.dependencies.properties.newsMonitorDedup;
			expect(dedupRef).toEqual({
				$ref: '#/components/schemas/NewsMonitorDedupDependency',
			});

			const dedupSchema = contract.components.schemas.NewsMonitorDedupDependency;
			expect(dedupSchema).toBeDefined();
			expect(dedupSchema.type).toBe('object');
			expect(dedupSchema.required).toEqual(
				expect.arrayContaining([
					'enabled',
					'configured',
					'ready',
					'status',
					'mode',
					'backend',
					'cacheSize',
				]),
			);

			const cacheSizeSchema = contract.components.schemas.NewsMonitorCacheSize;
			expect(cacheSizeSchema).toBeDefined();
			expect(cacheSizeSchema.type).toBe('object');
			expect(cacheSizeSchema.required).toEqual(
				expect.arrayContaining([
					'entries',
					'maxEntries',
					'evictionCount',
					'deliveryLocks',
					'deliveryLockMaxEntries',
					'deliveryLockEvictionCount',
					'urlShortenerCache',
					'urlShortenerServiceFailures',
				]),
			);

			const statusExample = contract.components.responses.StatusResult.content['application/json'].example;
			expect(statusExample.dependencies.newsMonitorDedup).toBeDefined();
			expect(statusExample.dependencies.newsMonitorDedup.cacheSize.maxEntries).toBe(5000);
			expect(statusExample.dependencies.newsMonitorDedup.cacheSize.deliveryLockMaxEntries).toBe(1000);
			expect(contract.components.schemas.Status.description).toContain('dependencies.newsMonitorDedup reports');
		});

		it('documents TokenCostBudgetDependency schema and references it under Status dependencies', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const budgetRef = contract.components.schemas.Status.properties.dependencies.properties.tokenCostBudget;
			expect(budgetRef).toEqual({
				$ref: '#/components/schemas/TokenCostBudgetDependency',
			});

			const budgetSchema = contract.components.schemas.TokenCostBudgetDependency;
			expect(budgetSchema).toBeDefined();
			expect(budgetSchema.type).toBe('object');
			expect(budgetSchema.required).toEqual(
				expect.arrayContaining([
					'enabled',
					'configured',
					'ready',
					'status',
					'dailySpendUsd',
					'budgetUsd',
					'utilizationPct',
					'alertsSent',
					'lastResetAt',
				]),
			);

			const statusExample = contract.components.responses.StatusResult.content['application/json'].example;
			expect(statusExample.dependencies.tokenCostBudget).toBeDefined();
			expect(statusExample.dependencies.tokenCostBudget.budgetUsd).toBe(5);
			expect(statusExample.featureFlags.tokenCostBudget).toBe(false);
		});
	});

	describe('news-monitor alert barrier fields (GH-712)', () => {
		it('types results[].alert as a structured NewsAlert schema with optional stop/target', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const newsMonitorResponse = contract.components.schemas.NewsMonitorResponse;
			const resultItemSchema = newsMonitorResponse.properties.results.items;
			expect(resultItemSchema.$ref).toBe('#/components/schemas/NewsMonitorResult');

			const resultSchema = contract.components.schemas.NewsMonitorResult;
			expect(resultSchema.properties.alert.$ref).toBe('#/components/schemas/NewsAlert');

			const newsAlert = contract.components.schemas.NewsAlert;
			expect(newsAlert.properties.stop).toEqual(expect.objectContaining({ type: 'number' }));
			expect(newsAlert.properties.target).toEqual(expect.objectContaining({ type: 'number' }));
			expect(newsAlert.required).not.toEqual(expect.arrayContaining(['stop', 'target']));
		});

		it('includes a populated stop/target example and a no-barrier example for the news-monitor response', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

			const response = contract.components.responses.NewsMonitorAnalysisResult;
			const examples = response.content['application/json'].examples;
			expect(examples.dryRun).toBeDefined();
			expect(examples.analyzedNoBarriers).toBeDefined();

			const dryRunAlert = examples.dryRun.value.results[0].alert;
			expect(typeof dryRunAlert.stop).toBe('number');
			expect(typeof dryRunAlert.target).toBe('number');
			expect(dryRunAlert.stop).toBeGreaterThan(0);
			expect(dryRunAlert.target).toBeGreaterThan(dryRunAlert.stop);

			const noBarriersAlert = examples.analyzedNoBarriers.value.results[0].alert;
			expect(noBarriersAlert.stop).toBeUndefined();
			expect(noBarriersAlert.target).toBeUndefined();
		});
	});

	describe('TestAlertRequest.text non-empty contract (GH-1157)', () => {
		// postTestAlert() forwards a caller-supplied body.text straight to
		// validateAlert(), which throws for any falsy or blank string and the handler
		// maps to 400 INVALID_REQUEST. A schema that still accepts "" lets a validator
		// or generated client build a request the endpoint always rejects.
		it('rejects an empty string on the test-alert probe text', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
			const text = contract.components.schemas.TestAlertRequest.properties.text;

			expect(text.type).toBe('string');
			expect(text.minLength).toBe(1);
			expect(text.description).toContain('non-empty');
		});

		it('keeps the probe text optional so omitting it still uses the default marker', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
			const schema = contract.components.schemas.TestAlertRequest;

			// The handler only substitutes its own smoke-probe marker when text is
			// absent, so requiring the field would break the documented minimal
			// `{}` request body.
			expect(schema.required).toBeUndefined();
			expect(contract.components.requestBodies.TestAlert.required).toBe(false);
			expect(contract.components.requestBodies.TestAlert.content['application/json'].examples.minimal.value)
				.toEqual({});
		});

		it('bounds every optional string field the runtime validates for emptiness', () => {
			// Generalises GH-1157: an optional string with neither `pattern` nor
			// `minLength` is unbounded below, so it accepts "" while the handler
			// rejects it. telegramChatId/whatsappChatId already carried minLength 1;
			// text did not.
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
			const properties = contract.components.schemas.TestAlertRequest.properties;

			const unbounded = Object.entries(properties)
				.filter(([, schema]) => schema.type === 'string' && !schema.pattern)
				.filter(([, schema]) => schema.minLength !== 1)
				.map(([name]) => name);

			expect(unbounded).toEqual([]);
		});
	});

	describe('TestAlertResult dry-run preview contract (GH-1158)', () => {
		// The dryRun example documents the default-marker path: body {} -> the
		// handler substitutes `[TEST-ALERT] cabros-bot smoke probe <ISO timestamp>`.
		// For the telegram channel the preview is MarkdownV2Formatter#format() of that
		// text, echoed verbatim as `text` with length: preview.length, so the example
		// is pinned to the formatter instead of a hand-copied excerpt.
		it('derives the default-marker telegram preview from the formatter', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
			const example = contract.components.responses.TestAlertResult
				.content['application/json'].examples.dryRun.value;
			const telegram = example.formatted.telegram;

			// The documented response carries the channel-formatted string, so the raw
			// marker is recovered by reversing MarkdownV2 escaping before it is matched
			// against the marker the handler substitutes for an empty body.
			const marker = telegram.text.replace(/\\(.)/g, '$1');
			expect(marker).toMatch(
				/^\[TEST-ALERT\] cabros-bot smoke probe \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			);
			expect(telegram.preview).toBe(new MarkdownV2Formatter().format(marker));
			expect(telegram.text).toBe(telegram.preview);
			expect(telegram.length).toBe(telegram.preview.length);
		});

		it('keeps the dry-run side-effect-free envelope the handler returns', () => {
			if (!fs.existsSync(contractPath)) return;
			const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
			const example = contract.components.responses.TestAlertResult
				.content['application/json'].examples.dryRun.value;

			// postTestAlert() answers 200 with ok/dryRun true, persisted false and an
			// empty results array on the dry-run branch, and never writes to Firestore.
			expect(example).toEqual(expect.objectContaining({
				ok: true,
				dryRun: true,
				persisted: false,
				results: [],
			}));
			expect(Object.keys(example.formatted)).toEqual(['telegram']);
			const properties = contract.components.schemas.TestAlertResult.properties;
			expect(properties.formatted.nullable).toBe(true);
			expect(properties.formatted.description).toContain('dryRun');
		});
	});
});

describe('status dependency contract drift', () => {
	const postmanPath = path.join(__dirname, '../../CabrosBot.postman_collection.json');
	const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

	function collectRequestLeaves(node, acc = []) {
		if (Array.isArray(node)) {
			for (const child of node) collectRequestLeaves(child, acc);
		} else if (node && typeof node === 'object') {
			if (Array.isArray(node.item)) {
				collectRequestLeaves(node.item, acc);
			} else {
				acc.push(node);
			}
		}
		return acc;
	}

	function getStatusExamples() {
		const collection = JSON.parse(fs.readFileSync(postmanPath, 'utf8'));
		return collectRequestLeaves(collection.item)
			.filter((request) => typeof request.name === 'string' && request.name.startsWith('Get Status'))
			.flatMap((request) => (request.response || [])
				.filter((response) => response.name === 'Success' || /^(200 OK|200)/.test(String(response.name)))
				.map((response) => {
					try {
						return JSON.parse(response.body);
					} catch {
						return null;
					}
				})
				.filter(Boolean));
	}

	function documentedDependencyKeys() {
		const dependencies = contract.components.schemas.Status.properties.dependencies;
		return Object.entries(dependencies.properties)
			.filter(([, schema]) => schema && schema.$ref)
			.map(([key]) => key);
	}

	it('documents at least one named dependency schema to guard against', () => {
		expect(documentedDependencyKeys().length).toBeGreaterThan(0);
	});

	// `requestDeadline` stamps `X-Request-Id` on every non-exempt route, so every
	// documented response should surface it. A response component that omits it
	// hides the correlation ID from generated clients precisely when an operator
	// needs it — on a provider 502. `MarketScannerBadGateway` was the one gap.
	it('declares X-Request-Id on every documented response of a request-id operation', () => {
		const spec = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
		const hasHeader = (node) => Boolean(node && node.headers && node.headers['X-Request-Id']);

		const missing = [];
		for (const [routePath, operations] of Object.entries(spec.paths || {})) {
			for (const [method, operation] of Object.entries(operations)) {
				if (!operation || typeof operation !== 'object' || !operation.responses) continue;
				const documentsRequestId = (operation.parameters || []).some((parameter) => {
					const ref = parameter && parameter.$ref;
					return ref === '#/components/parameters/XRequestIdHeader'
						|| (parameter && parameter.in === 'header' && parameter.name === 'x-request-id');
				});
				if (!documentsRequestId) continue;

				for (const [status, response] of Object.entries(operation.responses)) {
					const component = response.$ref
						? spec.components.responses[response.$ref.split('/').pop()]
						: response;
					if (!hasHeader(component) && !hasHeader(response)) {
						missing.push(`${method.toUpperCase()} ${routePath} ${status}`);
					}
				}
			}
		}

		expect(missing).toEqual([]);
	});

	it('exposes every named Status dependency in some Postman status example', () => {
		const examples = getStatusExamples();
		expect(examples.length).toBeGreaterThan(0);
		const seen = new Set();
		for (const example of examples) {
			for (const key of Object.keys(example.dependencies || {})) seen.add(key);
		}
		const missing = documentedDependencyKeys().filter((key) => !seen.has(key));
		expect(missing).toEqual([]);
	});
	it('documents every lastErrorCategory the remote-config service can emit', () => {
		// The service emits `invalid_value` on a SUCCESSFUL load whose values failed
		// schema validation. A client validating responses against the published spec
		// must not reject that value, so the enum has to list it.
		const spec = require('../../src/openapi/openapi.json');
		const enumValues = spec.components.schemas.FirebaseRemoteConfigDependency
			.properties.lastErrorCategory.enum;

		for (const category of ['load_failed', 'template_not_published', 'invalid_value', 'stale', 'timeout']) {
			expect(enumValues).toContain(category);
		}
	});
});
