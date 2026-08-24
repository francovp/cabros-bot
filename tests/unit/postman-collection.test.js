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
});

