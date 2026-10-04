const fs = require('fs');
const path = require('path');

const collectionPath = path.join(__dirname, '../../CabrosBot.postman_collection.json');

function findItem(items, name) {
	for (const item of items) {
		if (item.name === name) return item;
		if (Array.isArray(item.item)) {
			const match = findItem(item.item, name);
			if (match) return match;
		}
	}
	return undefined;
}

function findHeader(item, key) {
	return item.request.header.find((header) => header.key === key);
}

function collectRequestItems(items, result = []) {
	for (const item of items) {
		if (item.request) result.push(item);
		if (Array.isArray(item.item)) collectRequestItems(item.item, result);
	}
	return result;
}

describe('Postman collection contract', () => {
	it('documents Firebase admin configuration and bearer-auth status access', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const config = findItem(collection.item, 'GET Firebase Admin Auth Config');
		const status = findItem(collection.item, 'GET Status (Firebase bearer)');

		expect(config).toBeDefined();
		expect(config.request.url.raw).toBe('{{baseUrl}}/admin/auth-config');
		expect(config.response[0].code).toBe(200);
		expect(status).toBeDefined();
		expect(status.request.header).toEqual(expect.arrayContaining([
			expect.objectContaining({ key: 'Authorization', value: 'Bearer {{firebaseIdToken}}' }),
		]));
		expect(status.response[0].body).toContain('"service"');
		expect(collection.variable).toEqual(expect.arrayContaining([
			expect.objectContaining({ key: 'firebaseIdToken' }),
		]));
	});

	it('documents groundingCoalescing dependency in the Get Status response example', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const status = findItem(collection.item, 'Get Status');

		expect(status).toBeDefined();
		const responseBody = JSON.parse(status.response[0].body);
		expect(responseBody.dependencies.groundingCoalescing).toEqual({
			enabled: false,
			windowMs: 0,
			activeEntries: 0,
			hits: 0,
			misses: 0,
			failures: 0,
		});
	});

	it('documents alertScheduler feature flag and dependency in the Get Status response example', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const status = findItem(collection.item, 'Get Status');

		expect(status).toBeDefined();
		const responseBody = JSON.parse(status.response[0].body);
		expect(responseBody.featureFlags.alertScheduler).toBe(false);
		expect(responseBody.dependencies.alertScheduler).toEqual(expect.objectContaining({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			role: 'web',
			running: false,
		}));
	});

	it('documents entry price source chains in status and capabilities examples', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const status = findItem(collection.item, 'Get Status');
		const capabilities = findItem(collection.item, 'Get Capabilities');

		expect(JSON.parse(status.response[0].body).dependencies.signalOutcomeWorker.entryPriceSources).toEqual({
			configured: false,
			crypto: ['mcp', 'binance', 'gemini'],
			equity: ['twelve-data'],
		});
		expect(JSON.parse(capabilities.response[0].body).dependencies.signalOutcomeWorker.entryPriceSources).toEqual({
			configured: true,
			crypto: ['mcp', 'binance', 'gemini'],
			equity: ['mcp', 'binance', 'gemini'],
		});
	});

	it('documents x-idempotency-key on the alert webhook request', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const sendAlert = findItem(collection.item, 'POST Send Alert');

		expect(sendAlert).toBeDefined();
		expect(sendAlert.request.header).toEqual(expect.arrayContaining([
			expect.objectContaining({
				key: 'x-idempotency-key',
				disabled: true,
			}),
		]));
	});

	it('documents valid and invalid per-symbol alert routing variants', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const valid = findItem(collection.item, 'POST Send Alert (per-symbol routing)');
		const invalid = findItem(collection.item, 'POST Send Alert (invalid symbol route)');

		expect(valid).toBeDefined();
		expect(JSON.parse(valid.request.body.raw).symbolRoutes).toEqual({
			BTCUSDT: { channels: ['telegram'] },
			NVDA: { channels: ['discord'] },
		});
		expect(valid.response[0].body).toContain('"symbol":"BTCUSDT"');
		expect(invalid).toBeDefined();
		expect(JSON.parse(invalid.request.body.raw).symbolRoutes.BTCUSDT.channels).toEqual(['slack']);
		expect(invalid.response[0].code).toBe(400);
		// The nested channel validation reports `field: "channels"` (plus the unknown
		// channel list), not the outer `symbolRoutes` field. This mirrors the real
		// NotificationRoutingValidationError raised by normalizeChannels.
		expect(JSON.parse(invalid.response[0].body).details).toEqual({
			field: 'channels',
			unknownChannels: ['slack'],
		});
	});

	it('makes the oversized webhook example generate padding in Postman', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const oversized = findItem(collection.item, 'POST Send Message (oversized body)');

		expect(oversized).toBeDefined();
		const preRequest = oversized.event?.find((event) => event.listen === 'prerequest');
		const script = preRequest?.script?.exec?.join('\n') || '';

		expect(preRequest).toBeDefined();
		expect(script).toContain('pm.variables.set(\'oversizedWebhookPadding\'');
		expect(oversized.request.body.raw).toContain('{{oversizedWebhookPadding}}');
		expect(oversized.request.body.raw).not.toContain('{{$padString}}');

	});

	it('uses distinct demo keys for middleware-backed scanner requests', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const expandedAnalysis = findItem(collection.item, 'POST Expanded Analysis Alert');
		const marketScanner = findItem(collection.item, 'POST Market Scanner Alert');

		expect(findHeader(expandedAnalysis, 'x-idempotency-key').value).toBe('expanded-analysis-key-1');
		expect(findHeader(marketScanner, 'x-idempotency-key').value).toBe('market-scanner-key-1');
	});

	it('uses distinct demo keys for async-job x-header requests', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const requestNames = [
			'POST Create TradingView Analysis Job',
			'POST Create Market Scanner Job',
			'POST Retry Job',
			'POST Retry Failed Job',
		];
		const values = requestNames.map((name) => findHeader(findItem(collection.item, name), 'x-idempotency-key').value);

		expect(values).toEqual([
			'job-create-key-1',
			'job-scanner-key-1',
			'job-retry-key-1',
			'job-retry-failed-key-1',
		]);
		expect(new Set(values).size).toBe(values.length);
	});

	it('includes the required type in every x-header job example', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const job = findItem(collection.item, 'POST Create TradingView Analysis Job (x-idempotency-key header)');
		const requests = [job.request, ...job.response.map((response) => response.originalRequest).filter(Boolean)];

		for (const request of requests) {
			expect(JSON.parse(request.body.raw).type).toBe('expanded-analysis');
		}
	});

	it('uses distinct keys for message and replay alternatives', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const message = findItem(collection.item, 'POST Send Message');
		const replay = findItem(collection.item, 'POST Replay Alert (telegram)');

		expect(findHeader(message, 'x-idempotency-key').value).toBe('generic-message-key-1');
		expect(findHeader(replay, 'x-idempotency-key').value).toBe('alert-replay-key-1');
	});

	it('defines the replay key used by hashed replay examples', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const replayKey = collection.variable.find((variable) => variable.key === 'replayIdempotencyKey');

		expect(replayKey).toEqual(expect.objectContaining({
			value: 'replay-key-1',
		}));
	});

	it('documents lastReplay in the stored alert detail response example', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const detail = findItem(collection.item, 'GET Get Alert by ID');

		expect(detail.response).toEqual(expect.arrayContaining([
			expect.objectContaining({
				code: 200,
				body: expect.stringContaining('"lastReplay"'),
			}),
		]));
	});

	it('includes runnable replay cursor and invalid-input variants', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const cursor = findItem(collection.item, 'GET List Replay Attempts (before cursor)');
		const invalid = findItem(collection.item, 'GET List Replay Attempts (invalid input)');

		expect(cursor.request.url.query).toEqual(expect.arrayContaining([
			expect.objectContaining({ key: 'before', value: '{{replayBefore}}' }),
		]));
		expect(invalid.request.url.raw).toContain('limit=999&before=not-a-cursor');
	});

	it('includes createdAt in both x-header job success examples', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const job = findItem(collection.item, 'POST Create TradingView Analysis Job (x-idempotency-key header)');
		const success = job.response.find((response) => response.name === 'Success (x-idempotency-key header)');
		const replay = job.response.find((response) => response.name === 'Success (idempotent replay)');

		expect(JSON.parse(success.body).createdAt).toBe('2026-06-19T12:00:00.000Z');
		expect(JSON.parse(replay.body).createdAt).toBe('2026-06-19T12:00:00.000Z');
	});

	it('keeps cached delivery metrics in the x-header replay example', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const sendMessage = findItem(collection.item, 'POST Send Message (x-idempotency-key header)');
		const replay = sendMessage.response.find((response) => response.name === 'Success (idempotent replay)');
		const replayBody = JSON.parse(replay.body);

		expect(replayBody.results[0]).toEqual(expect.objectContaining({
			attemptCount: 1,
			durationMs: 450,
		}));
	});

	it('documents current_price and price_data in the TradingView dry-run example', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const sendAlert = findItem(collection.item, 'POST Send Alert Dry Run (TradingView confluence)');
		const full = sendAlert.response.find((response) => response.name === 'Dry run - full TradingView enrichment');
		const enrichedData = JSON.parse(full.body).payload.enrichedData;

		expect(enrichedData.current_price).toBe(64863.03);
		expect(enrichedData.price_data).toEqual({ current_price: 64863.03, high: 65000, low: 64000 });
	});

	it('aligns Binance MARKET quantity dry-run example with request and runtime response', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const marketSell = findItem(collection.item, 'POST Binance order (valid MARKET quantity dry-run)');
		expect(marketSell).toBeDefined();

		const requestBody = JSON.parse(marketSell.request.body.raw);
		const responseBody = JSON.parse(marketSell.response[0].body);

		expect(requestBody.side).toBe('SELL');
		expect(requestBody.type).toBe('MARKET');
		expect(typeof requestBody.quantity).toBe('number');
		expect(requestBody.quantity).toBe(0.001);
		expect(requestBody.clientOrderId).toBeUndefined();
		expect(requestBody.dryRun).toBe(true);

		expect(responseBody.success).toBe(true);
		expect(responseBody.dryRun).toBe(true);
		expect(responseBody.order.symbol).toBe('BTCUSDT');
		expect(responseBody.order.side).toBe('SELL');
		expect(responseBody.order.type).toBe('MARKET');
		expect(responseBody.order.quantity).toBe(requestBody.quantity);
		expect(typeof responseBody.order.quantity).toBe('number');
		expect(responseBody.order.newClientOrderId).toBeUndefined();
		expect(responseBody.order.newOrderRespType).toBe('FULL');
	});

	it('aligns Binance dry-run response shapes across LIMIT and bounded MARKET BUY examples', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const limitDryRun = findItem(collection.item, 'POST Binance order (dry-run LIMIT)');
		const marketBuyDryRun = findItem(collection.item, 'POST Binance order (bounded MARKET BUY quantity dry-run)');

		expect(limitDryRun).toBeDefined();
		expect(marketBuyDryRun).toBeDefined();

		const limitResp = JSON.parse(limitDryRun.response[0].body);
		expect(limitResp.dryRun).toBe(true);
		expect(limitResp.order.quantity).toBe(0.001);
		expect(typeof limitResp.order.quantity).toBe('number');
		expect(limitResp.order.newOrderRespType).toBe('FULL');
		expect(limitResp.order.newClientOrderId).toBeUndefined();

		const marketBuyResp = JSON.parse(marketBuyDryRun.response[0].body);
		expect(marketBuyResp.dryRun).toBe(true);
		expect(marketBuyResp.order.quoteOrderQty).toBe('50');
		expect(marketBuyResp.order.newOrderRespType).toBe('FULL');
		expect(marketBuyResp.order.newClientOrderId).toBeUndefined();
	});

	it('documents Request Timeout (408) response examples with required fields', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const endpointsWithTimeout = [
			'POST Send Alert',
			'POST Send Message',
			'POST Create TradingView Analysis Job',
		];

		for (const name of endpointsWithTimeout) {
			const item = findItem(collection.item, name);
			expect(item).toBeDefined();
			const timeoutExample = item.response.find((res) => res.code === 408);
			expect(timeoutExample).toBeDefined();
			expect(timeoutExample.name).toBe('Request Timeout (408)');
			expect(timeoutExample.status).toBe('Request Timeout');
			expect(timeoutExample.header).toEqual(expect.arrayContaining([
				expect.objectContaining({ key: 'X-Request-Id' }),
			]));

			const parsed = JSON.parse(timeoutExample.body);
			expect(parsed).toEqual(expect.objectContaining({
				error: 'Request Timeout',
				code: 'REQUEST_TIMEOUT',
				requestId: expect.any(String),
				deadlineMs: expect.any(Number),
				durationMs: expect.any(Number),
			}));
		}
	});

	it('documents Request Timeout (408) on every affected admin request variant', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const affectedPaths = [
			'/api/admin/test-alert',
			'/api/alerts/batch/delete',
			'/api/alerts/batch/export',
			'/api/alerts/batch/replay',
			'/api/news-monitor/pause',
			'/api/news-monitor/resume',
			'/api/news-monitor/status',
			'/api/symbol-analyses',
			'/api/symbol-analyses/summary',
		];
		const requestItems = collectRequestItems(collection.item);

		for (const routePath of affectedPaths) {
			const variants = requestItems.filter((item) => {
				const rawUrl = item.request.url && item.request.url.raw;
				return typeof rawUrl === 'string' && rawUrl.split('?')[0] === `{{baseUrl}}${routePath}`;
			});
			expect(variants.length).toBeGreaterThan(0);
			for (const item of variants) {
				expect(item.response.some((response) => response.code === 408)).toBe(true);
			}
		}
	});

	it('documents include=enrichment_summary success and invalid 400 response in GET List Alerts', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const includeItem = findItem(collection.item, 'GET List Alerts (include=enrichment_summary)');
		const invalidIncludeItem = findItem(collection.item, 'GET List Alerts (invalid include - 400 Bad Request)');

		expect(includeItem).toBeDefined();
		expect(includeItem.request.url.raw).toContain('include=enrichment_summary');
		const successBody = JSON.parse(includeItem.response[0].body);
		expect(successBody.success).toBe(true);
		expect(successBody.alerts[0].enrichmentSummary).toBeDefined();
		expect(successBody.alerts[0].enrichmentSummary.sentiment).toBe('BULLISH');
		expect(successBody.alerts[0].enrichmentSummary.promptProvenance).toBeDefined();

		expect(invalidIncludeItem).toBeDefined();
		expect(invalidIncludeItem.request.url.raw).toContain('include=invalid_field');
		expect(invalidIncludeItem.response[0].code).toBe(400);
		const errorBody = JSON.parse(invalidIncludeItem.response[0].body);
		expect(errorBody.code).toBe('INVALID_REQUEST');
		expect(errorBody.error).toContain('enrichment_summary');
	});

	it('documents chat preferences endpoints with request and response examples', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const getItem = findItem(collection.item, 'GET Get Chat Preferences');
		const putItem = findItem(collection.item, 'PUT Update Chat Preferences');
		const deleteItem = findItem(collection.item, 'DELETE Reset Chat Preferences');

		expect(getItem).toBeDefined();
		expect(getItem.request.url.raw).toContain('/api/preferences/telegram/');
		expect(getItem.response).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 200 }),
			expect.objectContaining({ code: 400 }),
			expect.objectContaining({ code: 401 }),
		]));

		expect(putItem).toBeDefined();
		expect(putItem.request.method).toBe('PUT');
		const putBody = JSON.parse(putItem.request.body.raw);
		expect(putBody.symbolFilter).toContain('BTCUSDT');
		expect(putItem.response).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: 200 }),
			expect.objectContaining({ code: 400 }),
		]));

		expect(deleteItem).toBeDefined();
		expect(deleteItem.request.method).toBe('DELETE');
		expect(deleteItem.response[0].code).toBe(200);
	});

	it('documents symbol, exchange, and eventCategory query filters in GET List Alerts and GET Alert Analytics Summary', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const listFiltered = findItem(collection.item, 'GET List Alerts (symbol, exchange, eventCategory)');
		const listInvalid = findItem(collection.item, 'GET List Alerts (invalid symbol - 400 Bad Request)');
		const summaryFiltered = findItem(collection.item, 'GET Alert Analytics Summary (symbol, exchange, eventCategory)');
		const summaryInvalid = findItem(collection.item, 'GET Alert Analytics Summary (invalid symbol - 400 Bad Request)');

		expect(listFiltered).toBeDefined();
		expect(listFiltered.request.url.raw).toContain('symbol=BTCUSDT');
		expect(listFiltered.request.url.raw).toContain('exchange=BINANCE');
		expect(listFiltered.request.url.raw).toContain('eventCategory=price_surge');
		expect(listFiltered.response[0].code).toBe(200);

		expect(listInvalid).toBeDefined();
		expect(listInvalid.response[0].code).toBe(400);
		expect(JSON.parse(listInvalid.response[0].body).code).toBe('INVALID_REQUEST');

		expect(summaryFiltered).toBeDefined();
		expect(summaryFiltered.request.url.raw).toContain('symbol=BTCUSDT');
		expect(summaryFiltered.request.url.raw).toContain('exchange=BINANCE');
		expect(summaryFiltered.request.url.raw).toContain('eventCategory=price_surge');
		expect(summaryFiltered.response[0].code).toBe(200);

		expect(summaryInvalid).toBeDefined();
		expect(summaryInvalid.response[0].code).toBe(400);
		expect(JSON.parse(summaryInvalid.response[0].body).code).toBe('INVALID_REQUEST');
	});

	it('documents signalClass in alert webhook and alert query/summary examples', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const postAlert = findItem(collection.item, 'POST Send Alert');
		expect(postAlert).toBeDefined();
		const body = JSON.parse(postAlert.request.body.raw);
		expect(body.signalClass).toBe('breakout');

		const dryRunAlert = findItem(collection.item, 'POST Send Alert Dry Run (risk metadata)');
		expect(dryRunAlert).toBeDefined();
		const dryRunBody = JSON.parse(dryRunAlert.request.body.raw);
		expect(dryRunBody.signalClass).toBe('breakout');
		const dryRunResp = JSON.parse(dryRunAlert.response[0].body);
		expect(dryRunResp.signalClass).toBeUndefined();
		expect(dryRunResp.payload.signalClass).toBe('breakout');

		const listFiltered = findItem(collection.item, 'GET List Alerts (symbol, exchange, eventCategory)');
		const listAlert = JSON.parse(listFiltered.response[0].body).alerts[0];
		expect(listAlert.signalClass).toBe('breakout');

		const summaryFiltered = findItem(collection.item, 'GET Alert Analytics Summary (symbol, exchange, eventCategory)');
		const summary = JSON.parse(summaryFiltered.response[0].body).summary;
		expect(summary.signalClassCounts).toBeDefined();
		expect(summary.signalClassCounts.breakout).toBe(1);

		const postInvalid = findItem(collection.item, 'POST Send Alert (invalid signalClass - 400 Bad Request)');
		expect(postInvalid).toBeDefined();
		expect(postInvalid.response[0].code).toBe(400);
		expect(JSON.parse(postInvalid.response[0].body).code).toBe('INVALID_REQUEST');

		const listClassFiltered = findItem(collection.item, 'GET List Alerts (signalClass filter)');
		expect(listClassFiltered).toBeDefined();
		expect(listClassFiltered.request.url.raw).toContain('signalClass=breakout,reversal');
		expect(listClassFiltered.response[0].code).toBe(200);

		const listClassInvalid = findItem(collection.item, 'GET List Alerts (invalid signalClass - 400 Bad Request)');
		expect(listClassInvalid).toBeDefined();
		expect(listClassInvalid.response[0].code).toBe(400);

		const summaryClassFiltered = findItem(collection.item, 'GET Alert Analytics Summary (signalClass filter)');
		expect(summaryClassFiltered).toBeDefined();
		expect(summaryClassFiltered.request.url.raw).toContain('signalClass=breakout,reversal');
		expect(summaryClassFiltered.response[0].code).toBe(200);

		const summaryClassInvalid = findItem(collection.item, 'GET Alert Analytics Summary (invalid signalClass - 400 Bad Request)');
		expect(summaryClassInvalid).toBeDefined();
		expect(summaryClassInvalid.response[0].code).toBe(400);

		const exportClassFiltered = findItem(collection.item, 'GET Export Alerts (JSONL - signalClass filter)');
		expect(exportClassFiltered).toBeDefined();
		expect(exportClassFiltered.request.url.raw).toContain('signalClass=breakout,reversal');
		expect(exportClassFiltered.response[0].code).toBe(200);

		const exportClassInvalid = findItem(collection.item, 'GET Export Alerts (invalid signalClass - 400 Bad Request)');
		expect(exportClassInvalid).toBeDefined();
		expect(exportClassInvalid.response[0].code).toBe(400);
	});

	it('documents notificationRedrive and zeroChannelBroadcasts in status and capabilities examples with workerRole, lastSweepAt, and lastSweepResult', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const status = findItem(collection.item, 'Get Status');
		const capabilities = findItem(collection.item, 'Get Capabilities');

		const statusBody = JSON.parse(status.response[0].body);
		expect(statusBody.featureFlags.notificationRedrive).toBe(false);
		expect(statusBody.dependencies.notificationRedrive).toEqual(expect.objectContaining({
			enabled: false,
			role: 'web',
			workerRole: 'web',
			maxAgeMs: 3600000,
			zeroChannelBroadcasts: 0,
			lastSweepAt: null,
			lastSweepResult: null,
		}));

		const capabilitiesBody = JSON.parse(capabilities.response[0].body);
		expect(capabilitiesBody.featureFlags.notificationRedrive).toBe(false);
		expect(capabilitiesBody.dependencies.notificationRedrive).toEqual(expect.objectContaining({
			enabled: false,
			role: 'web',
			workerRole: 'web',
			maxAgeMs: 3600000,
			zeroChannelBroadcasts: 0,
			lastSweepAt: null,
			lastSweepResult: null,
		}));
	});

	it('documents both JSONL and CSV request variants and response examples for batch alert export', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const jsonlExport = findItem(collection.item, 'POST Batch Export Alerts (JSONL)') || findItem(collection.item, 'POST Batch Export Alerts');
		const csvExport = findItem(collection.item, 'POST Batch Export Alerts (CSV)');

		expect(jsonlExport).toBeDefined();
		expect(csvExport).toBeDefined();

		const jsonlBody = JSON.parse(jsonlExport.request.body.raw);
		expect(jsonlBody.format).toBe('jsonl');

		const csvBody = JSON.parse(csvExport.request.body.raw);
		expect(csvBody.format).toBe('csv');

		const csvSuccess = csvExport.response.find((r) => r.name.includes('CSV'));
		expect(csvSuccess).toBeDefined();
		expect(csvSuccess.code).toBe(200);
	});

	it('documents populated, omitted, and unauthorized response variants for firestore write metrics', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const item = findItem(collection.item, 'Get Status - firestore write metrics');

		expect(item).toBeDefined();
		const populated = item.response.find((res) => res.name.includes('populated'));
		const omitted = item.response.find((res) => res.name.includes('omitted'));
		const unauthorized = item.response.find((res) => res.code === 401);

		expect(populated).toBeDefined();
		expect(populated.code).toBe(200);
		expect(JSON.parse(populated.body).dependencies.firestoreWriteMetrics).toBeDefined();

		expect(omitted).toBeDefined();
		expect(omitted.code).toBe(200);
		expect(JSON.parse(omitted.body).dependencies.firestoreWriteMetrics).toBeUndefined();

		expect(unauthorized).toBeDefined();
		expect(unauthorized.code).toBe(401);
		expect(JSON.parse(unauthorized.body).error).toContain('Unauthorized');
	});

	it('documents degraded, healthy, and omitted firestore read-metric variants', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const item = findItem(collection.item, 'Get Status - firestore read metrics (degraded read path)');

		expect(item).toBeDefined();

		const degraded = item.response.find((res) => res.name.includes('degraded'));
		const healthy = item.response.find((res) => res.name.includes('healthy'));
		const omitted = item.response.find((res) => res.name.includes('omitted'));
		const unauthorized = item.response.find((res) => res.code === 401);

		// Issue #1285 acceptance: a broken read path must be visible on /api/status
		// as a non-ready dependency with a sanitized category.
		expect(degraded.code).toBe(200);
		expect(JSON.parse(degraded.body).dependencies.firestore).toMatchObject({
			ready: false,
			status: 'degraded',
			readHealth: 'degraded',
			lastReadErrorCategory: 'failed_precondition',
		});
		expect(JSON.parse(degraded.body).dependencies.firestoreReadMetrics.lastErrorCategory)
			.toBe('failed_precondition');

		expect(healthy.code).toBe(200);
		expect(JSON.parse(healthy.body).dependencies.firestore).toMatchObject({
			ready: true,
			status: 'ready',
			readHealth: 'healthy',
		});

		expect(omitted.code).toBe(200);
		expect(JSON.parse(omitted.body).dependencies.firestoreReadMetrics).toBeUndefined();
		expect(JSON.parse(omitted.body).dependencies.firestore).not.toHaveProperty('readHealth');

		expect(unauthorized.code).toBe(401);
	});

	it('documents proven equity market-data readiness states for GET Status', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const item = findItem(collection.item, 'Get Status - equity market data readiness (issue #1116)');

		expect(item).toBeDefined();

		const unverified = item.response.find((res) => res.name.includes('unverified'));
		const degraded = item.response.find((res) => res.name.includes('degraded'));
		const ready = item.response.find((res) => res.name.includes('ready'));

		// Issue #1116 acceptance: a shaped-but-unproven credential must never read as
		// ready, so the pre-call state is documented as unverified rather than ready.
		expect(unverified.code).toBe(200);
		expect(JSON.parse(unverified.body).dependencies.equityMarketData).toMatchObject({
			configured: true,
			ready: false,
			status: 'unverified',
			readiness: 'unverified',
			requestsSucceeded: 0,
			lastErrorReason: null,
		});

		expect(degraded.code).toBe(200);
		expect(JSON.parse(degraded.body).dependencies.equityMarketData).toMatchObject({
			configured: true,
			ready: false,
			status: 'degraded',
			readiness: 'degraded',
			consecutiveFailures: 1,
			lastErrorReason: 'twelve_data_misconfigured',
		});

		expect(ready.code).toBe(200);
		expect(JSON.parse(ready.body).dependencies.equityMarketData).toMatchObject({
			configured: true,
			ready: true,
			status: 'ready',
			readiness: 'verified',
			requestsSucceeded: 14,
		});

		for (const res of [unverified, degraded, ready]) {
			const raw = res.body;
			expect(raw).not.toMatch(/apikey/i);
			expect(raw).not.toMatch(/sk-[a-z0-9]/i);
		}
	});

	it('documents cloudflareAig routing states for GET Status', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const item = findItem(collection.item, 'Get Status - cloudflareAig routing (issue #1115)');

		expect(item).toBeDefined();

		const inactive = item.response.find((res) => res.name.includes('inactive'));
		const routed = item.response.find((res) => res.name.includes('ready - gateway is the routed'));
		const misconfigured = item.response.find((res) => res.name.includes('misconfigured'));

		// Issue #1115 acceptance: ENABLE_CLOUDFLARE_AIG alone does not route traffic, so
		// credentials present under another provider must document ready:false/inactive
		// rather than the ready:true the flag-plus-credentials steps used to produce.
		expect(inactive.code).toBe(200);
		expect(JSON.parse(inactive.body).dependencies.cloudflareAig).toMatchObject({
			enabled: true,
			configured: true,
			routed: false,
			provider: 'gemini',
			ready: false,
			status: 'inactive',
		});

		expect(routed.code).toBe(200);
		expect(JSON.parse(routed.body).dependencies.cloudflareAig).toMatchObject({
			enabled: true,
			configured: true,
			routed: true,
			provider: 'cloudflare',
			ready: true,
			status: 'ready',
		});

		expect(misconfigured.code).toBe(200);
		expect(JSON.parse(misconfigured.body).dependencies.cloudflareAig).toMatchObject({
			enabled: true,
			configured: false,
			routed: true,
			provider: 'cloudflare',
			ready: false,
			status: 'misconfigured',
		});

		for (const res of [inactive, routed, misconfigured]) {
			const cf = JSON.parse(res.body).dependencies.cloudflareAig;
			expect(cf.routed).toBe(cf.provider === 'cloudflare');
			if (cf.ready) {
				expect(cf.status).toBe('ready');
				expect(cf.routed).toBe(true);
			}
			expect(res.body).not.toMatch(/CF_AIG_TOKEN/);
			expect(res.body).not.toMatch(/CF_AIG_BASE_URL/);
		}
	});

	it('documents both STORAGE_UNAVAILABLE classifications for GET List Alerts', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const item = findItem(collection.item, 'GET List Alerts');

		const missingIndex = item.response.find((res) => res.name.includes('missing composite index'));
		const uninitialized = item.response.find((res) => res.name.includes('check credentials'));

		// The two variants must be mutually exclusive so an operator can tell a
		// rejected query from a credential/init failure without log access.
		expect(missingIndex.code).toBe(503);
		expect(JSON.parse(missingIndex.body)).toMatchObject({
			code: 'STORAGE_UNAVAILABLE',
			category: 'failed_precondition',
			missingIndex: true,
		});
		expect(uninitialized.code).toBe(503);
		expect(JSON.parse(uninitialized.body)).toMatchObject({
			code: 'STORAGE_UNAVAILABLE',
			category: 'uninitialized',
		});

		for (const res of [missingIndex, uninitialized]) {
			const body = JSON.parse(res.body);
			expect(body.error).not.toMatch(/projects\//);
			expect(body.error).not.toMatch(/console\.firebase\.google\.com/);
		}
	});

	it('documents distinct invalid query variants for GET Summarize Signal Outcomes', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const invalidLimit = findItem(collection.item, 'GET Summarize Signal Outcomes (invalid limit)');
		const invalidStatus = findItem(collection.item, 'GET Summarize Signal Outcomes (invalid status)');
		const invalidWindow = findItem(collection.item, 'GET Summarize Signal Outcomes (invalid window)');
		const malformedFrom = findItem(collection.item, 'GET Summarize Signal Outcomes (malformed from timestamp)');
		const malformedTo = findItem(collection.item, 'GET Summarize Signal Outcomes (malformed to timestamp)');
		const reversedRange = findItem(collection.item, 'GET Summarize Signal Outcomes (reversed time range)');

		expect(invalidLimit).toBeDefined();
		expect(invalidLimit.request.url.raw).toContain('limit=200');
		expect(invalidLimit.response[0].code).toBe(400);
		expect(JSON.parse(invalidLimit.response[0].body)).toEqual(
			expect.objectContaining({
				error: 'Invalid limit. Use an integer between 1 and 100.',
				code: 'INVALID_REQUEST',
			}),
		);

		expect(invalidStatus).toBeDefined();
		expect(invalidStatus.request.url.raw).toContain('status=invalid');
		expect(invalidStatus.response[0].code).toBe(400);
		expect(JSON.parse(invalidStatus.response[0].body)).toEqual(
			expect.objectContaining({
				error: 'Invalid status filter. Use pending, evaluated, or unavailable.',
				code: 'INVALID_REQUEST',
			}),
		);

		expect(invalidWindow).toBeDefined();
		expect(invalidWindow.request.url.raw).toContain('window=invalid');
		expect(invalidWindow.response[0].code).toBe(400);
		expect(JSON.parse(invalidWindow.response[0].body)).toEqual(
			expect.objectContaining({
				error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.',
				code: 'INVALID_REQUEST',
			}),
		);

		expect(malformedFrom).toBeDefined();
		expect(malformedFrom.request.url.raw).toContain('from=not-a-date');
		expect(malformedFrom.response[0].code).toBe(400);
		expect(JSON.parse(malformedFrom.response[0].body)).toEqual(
			expect.objectContaining({
				error: 'Invalid from timestamp. Use an ISO-8601 timestamp.',
				code: 'INVALID_REQUEST',
			}),
		);

		expect(malformedTo).toBeDefined();
		expect(malformedTo.request.url.raw).toContain('to=not-a-date');
		expect(malformedTo.response[0].code).toBe(400);
		expect(JSON.parse(malformedTo.response[0].body)).toEqual(
			expect.objectContaining({
				error: 'Invalid to timestamp. Use an ISO-8601 timestamp.',
				code: 'INVALID_REQUEST',
			}),
		);

		expect(reversedRange).toBeDefined();
		expect(reversedRange.request.url.raw).toContain('from=2026-08-30T00:00:00.000Z&to=2026-08-01T00:00:00.000Z');
		expect(reversedRange.response[0].code).toBe(400);
		expect(JSON.parse(reversedRange.response[0].body)).toEqual(
			expect.objectContaining({
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			}),
		);

		[invalidLimit, invalidStatus, invalidWindow, malformedFrom, malformedTo, reversedRange].forEach((item) => {
			expect(item.event).toBeDefined();
			const testEvent = item.event.find((e) => e.listen === 'test');
			expect(testEvent).toBeDefined();
			const scriptText = testEvent.script.exec.join('\n');
			expect(scriptText).toContain('pm.response.to.have.status(400)');
			expect(scriptText).toContain('INVALID_REQUEST');
		});
	});
	it('documents idempotency headers and replay examples for volume confirmation and symbol analysis', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const volumeConfirm = findItem(collection.item, 'POST Volume Confirmation');
		const symbolAnalysis = findItem(collection.item, 'POST Single Symbol Analysis');

		expect(volumeConfirm).toBeDefined();
		expect(findHeader(volumeConfirm, 'idempotency-key')).toEqual(expect.objectContaining({
			value: 'volume-confirm-demo-1',
		}));
		expect(findHeader(volumeConfirm, 'x-idempotency-key')).toEqual(expect.objectContaining({
			value: 'volume-confirm-key-1',
			disabled: true,
		}));
		expect(volumeConfirm.response.map((r) => r.name)).toEqual(expect.arrayContaining([
			'Success - volume confirmed (idempotent replay)',
			'409 Idempotency conflict',
			'400 Invalid idempotency key',
		]));

		expect(symbolAnalysis).toBeDefined();
		expect(findHeader(symbolAnalysis, 'idempotency-key')).toEqual(expect.objectContaining({
			value: 'symbol-analysis-demo-1',
		}));
		expect(findHeader(symbolAnalysis, 'x-idempotency-key')).toEqual(expect.objectContaining({
			value: 'symbol-analysis-key-1',
			disabled: true,
		}));
		expect(symbolAnalysis.response.map((r) => r.name)).toEqual(expect.arrayContaining([
			'Success - decision-ready analysis (idempotent replay)',
			'409 Idempotency conflict',
			'400 Invalid idempotency key',
		]));
	});
});

describe('news-monitor stop/target example (GH-712)', () => {
	it('POST News Monitor success example includes a populated stop/target alert', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const postItem = findItem(collection.item, 'POST News Monitor');
		expect(postItem).toBeDefined();

		const successExample = postItem.response.find(
			(response) => response.name === '200 OK - Analysis summary',
		);
		expect(successExample).toBeDefined();

		const body = JSON.parse(successExample.body);
		const resultsWithBarriers = body.results.filter(
			(result) => result.alert && typeof result.alert.stop === 'number' && typeof result.alert.target === 'number',
		);
		expect(resultsWithBarriers.length).toBeGreaterThanOrEqual(1);

		resultsWithBarriers.forEach((result) => {
			expect(result.alert.stop).toBeGreaterThan(0);
			expect(result.alert.target).toBeGreaterThan(result.alert.stop);
		});

		const resultsWithoutBarriers = body.results.filter(
			(result) => result.alert && (result.alert.stop === undefined || result.alert.target === undefined),
		);
		expect(resultsWithoutBarriers.length).toBeGreaterThanOrEqual(1);
	});

	it('POST News Monitor (dry run) example includes a populated stop/target alert', () => {
		const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
		const dryRunItem = findItem(collection.item, 'POST News Monitor (dry run)');
		expect(dryRunItem).toBeDefined();

		const body = JSON.parse(dryRunItem.response[0].body);
		const alert = body.results[0].alert;
		expect(typeof alert.stop).toBe('number');
		expect(typeof alert.target).toBe('number');
		expect(alert.stop).toBeGreaterThan(0);
		expect(alert.target).toBeGreaterThan(alert.stop);
	});
});
