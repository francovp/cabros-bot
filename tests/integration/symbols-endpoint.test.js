'use strict';

const request = require('supertest');
const express = require('express');

describe('Symbol alias resolver endpoints', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.WEBHOOK_API_KEY = 'legacy-key';
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	function buildApp() {
		const app = express();
		app.use(express.json());
		const { getRoutes } = require('../../src/routes');
		app.use('/api', getRoutes(() => null));
		return app;
	}

	describe('POST /api/symbols/resolve', () => {
		it('resolves GOLD to TVC:GOLD with operator auth', async () => {
			const response = await request(buildApp())
				.post('/api/symbols/resolve')
				.set('x-api-key', 'legacy-key')
				.send({ query: 'GOLD' });

			expect(response.status).toBe(200);
			expect(response.body.matches[0]).toEqual(expect.objectContaining({
				exchange: 'TVC',
				symbol: 'GOLD',
				matchType: 'exact',
				assetClass: 'commodity',
			}));
			expect(response.body.matches[0].aliases).toEqual(expect.arrayContaining(['XAUUSD', 'XAU/USD']));
			expect(response.body.totalEntries).toBeGreaterThan(0);
		});

		it('returns empty matches for nonsense input', async () => {
			const response = await request(buildApp())
				.post('/api/symbols/resolve')
				.set('x-api-key', 'legacy-key')
				.send({ query: 'ZZZ_COMPLETELY_FAKE' });

			expect(response.status).toBe(200);
			expect(response.body.matches).toEqual([]);
		});

		it('returns 400 for missing query', async () => {
			const response = await request(buildApp())
				.post('/api/symbols/resolve')
				.set('x-api-key', 'legacy-key')
				.send({});

			expect(response.status).toBe(400);
			expect(response.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 401 without API key', async () => {
			process.env.WEBHOOK_API_KEY = 'required-key';
			const response = await request(buildApp())
				.post('/api/symbols/resolve')
				.send({ query: 'GOLD' });

			expect(response.status).toBe(401);
		});
	});

	describe('GET /api/symbols/aliases', () => {
		it('returns the alias table with operator auth', async () => {
			const response = await request(buildApp())
				.get('/api/symbols/aliases')
				.set('x-api-key', 'legacy-key');

			expect(response.status).toBe(200);
			expect(response.body.aliases.length).toBeGreaterThan(0);
			expect(response.body.totalEntries).toBe(response.body.aliases.length);

			// Sanity check: GOLD entry must be present and well-formed.
			const gold = response.body.aliases.find((entry) => entry.symbol === 'GOLD');
			expect(gold).toBeDefined();
			expect(gold.exchange).toBe('TVC');
			expect(gold.aliases).toEqual(expect.arrayContaining(['GOLD', 'XAUUSD']));
		});
	});
});