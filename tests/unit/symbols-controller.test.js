'use strict';

const {
	postResolveSymbol,
	getAliases,
	DEFAULT_MAX_RESULTS,
	MAX_MAX_RESULTS,
} = require('../../src/controllers/webhooks/handlers/symbols/symbols');

function createRes() {
	return {
		statusCode: null,
		body: null,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.body = payload;
			return this;
		},
	};
}

describe('symbols controller', () => {
	describe('POST /api/symbols/resolve', () => {
		it('resolves GOLD → TVC:GOLD', async () => {
			const req = { body: { query: 'GOLD' } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(200);
			expect(res.body.matches[0]).toEqual(expect.objectContaining({
				exchange: 'TVC',
				symbol: 'GOLD',
				assetClass: 'commodity',
				matchType: 'exact',
			}));
			expect(res.body.matches[0].aliases).toEqual(expect.arrayContaining(['GOLD', 'XAUUSD']));
			expect(res.body.totalEntries).toBeGreaterThan(0);
		});

		it('returns 400 when query is missing', async () => {
			const req = { body: {} };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when query is not a string', async () => {
			const req = { body: { query: 42 } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 when query is empty', async () => {
			const req = { body: { query: '   ' } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns empty matches for nonsense input (no 500)', async () => {
			const req = { body: { query: 'ZZZNONSENSE' } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(200);
			expect(res.body.matches).toEqual([]);
		});

		it('honors defaultExchange for tie-breaking', async () => {
			const req = { body: { query: 'BTC', defaultExchange: 'BINANCE' } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(200);
			expect(res.body.matches[0].exchange).toBe('BINANCE');
		});

		it('rejects non-finite maxResults with 400', async () => {
			const req = { body: { query: 'GOLD', maxResults: 'lots' } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('rejects negative or zero maxResults with 400', async () => {
			const req = { body: { query: 'GOLD', maxResults: 0 } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(400);
		});

		it('rejects maxResults above the cap with 400', async () => {
			const req = { body: { query: 'GOLD', maxResults: MAX_MAX_RESULTS + 1 } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(400);
		});

		it('caps results to the requested maxResults', async () => {
			const req = { body: { query: 'XAUUSD', maxResults: 1 } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(200);
			expect(res.body.matches.length).toBeLessThanOrEqual(1);
		});

		it('uses the default maxResults when none is provided', async () => {
			expect(DEFAULT_MAX_RESULTS).toBeGreaterThan(0);
			const req = { body: { query: 'XAUUSD' } };
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(200);
			expect(res.body.matches.length).toBeLessThanOrEqual(DEFAULT_MAX_RESULTS);
		});

		it('tolerates non-object bodies', async () => {
			const req = {};
			const res = createRes();
			await postResolveSymbol()(req, res);
			expect(res.statusCode).toBe(400);
		});
	});

	describe('GET /api/symbols/aliases', () => {
		it('returns the full alias table', async () => {
			const req = {};
			const res = createRes();
			await getAliases()(req, res);
			expect(res.statusCode).toBe(200);
			expect(res.body.aliases.length).toBeGreaterThan(0);
			expect(res.body.totalEntries).toBe(res.body.aliases.length);
		});
	});
});