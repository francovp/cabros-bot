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
});
