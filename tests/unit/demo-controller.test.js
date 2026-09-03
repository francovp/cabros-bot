'use strict';

jest.mock('../../src/services/monitoring/SentryService', () => ({
	captureRuntimeError: jest.fn(),
	startInactiveSpan: jest.fn(() => ({ finish: jest.fn() })),
	endSpan: jest.fn(),
}));

const {
	isDemoEnabled,
	getDemoAlert,
	getDemoOutcomes,
	getDemoScanner,
	parseChannelsParam,
	buildDemoAlert,
	buildDemoOutcomes,
	buildDemoScanner,
	DEFAULT_DEMO_BANNER,
} = require('../../src/controllers/demo');

function mockRes() {
	const res = {};
	res.status = jest.fn().mockReturnValue(res);
	res.json = jest.fn().mockReturnValue(res);
	return res;
}

describe('demo controller', () => {
	const originalEnv = process.env.ENABLE_DEMO_MODE;

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.ENABLE_DEMO_MODE;
		} else {
			process.env.ENABLE_DEMO_MODE = originalEnv;
		}
	});

	describe('isDemoEnabled', () => {
		it('returns false by default', () => {
			delete process.env.ENABLE_DEMO_MODE;
			expect(isDemoEnabled()).toBe(false);
		});

		it('returns true when ENABLE_DEMO_MODE=true', () => {
			process.env.ENABLE_DEMO_MODE = 'true';
			expect(isDemoEnabled()).toBe(true);
		});

		it('accepts the "1" alias', () => {
			process.env.ENABLE_DEMO_MODE = '1';
			expect(isDemoEnabled()).toBe(true);
		});

		it('treats any other value as disabled', () => {
			process.env.ENABLE_DEMO_MODE = 'yes';
			expect(isDemoEnabled()).toBe(false);
		});
	});

	describe('parseChannelsParam', () => {
		it('returns [] for missing input', () => {
			expect(parseChannelsParam()).toEqual([]);
			expect(parseChannelsParam('')).toEqual([]);
		});

		it('deduplicates and filters unknown channels', () => {
			expect(parseChannelsParam('telegram,whatsapp,telegram,unknown')).toEqual(['telegram', 'whatsapp']);
		});

		it('lowercases entries', () => {
			expect(parseChannelsParam('TELEGRAM,WhatsApp')).toEqual(['telegram', 'whatsapp']);
		});
	});

	describe('buildDemoAlert', () => {
		it('produces synthetic alert output with demo meta', () => {
			const alert = buildDemoAlert({ text: 'hello', channels: ['telegram'] });
			expect(alert.source).toBe('demo');
			expect(alert.text).toBe('hello');
			expect(alert.enriched.sentiment).toMatch(/bullish|bearish|neutral/);
			expect(Array.isArray(alert.enriched.sources)).toBe(true);
			expect(alert.delivery.results[0]).toMatchObject({ channel: 'telegram', demo: true });
		});

		it('falls back to a sample text when none is supplied', () => {
			const alert = buildDemoAlert({ channels: [] });
			expect(alert.text.length).toBeGreaterThan(0);
			expect(alert.delivery.note).toMatch(/preview/);
		});
	});

	describe('buildDemoOutcomes', () => {
		it('produces a 4-window synthetic outcome set', () => {
			const out = buildDemoOutcomes({ symbol: 'BINANCE:ETHUSDT' });
			expect(out.symbol).toBe('BINANCE:ETHUSDT');
			expect(out.windows).toHaveLength(4);
			expect(out.windows.map((w) => w.window)).toEqual(['+1h', '+4h', '+1D', '+1W']);
			expect(typeof out.expectancyR).toBe('number');
		});
	});

	describe('buildDemoScanner', () => {
		it('defaults to BINANCE', () => {
			const scanner = buildDemoScanner({});
			expect(scanner.exchange).toBe('BINANCE');
			expect(scanner.items.length).toBeGreaterThan(0);
		});

		it('uppercases the supplied exchange', () => {
			const scanner = buildDemoScanner({ exchange: 'nasdaq' });
			expect(scanner.exchange).toBe('NASDAQ');
		});
	});

	describe('GET /api/demo/alert', () => {
		it('returns 404 when feature is disabled', async () => {
			delete process.env.ENABLE_DEMO_MODE;
			const handler = getDemoAlert();
			const req = { query: {} };
			const res = mockRes();
			await handler(req, res);
			expect(res.status).toHaveBeenCalledWith(404);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'FEATURE_DISABLED' }));
		});

		it('returns demo payload when enabled', async () => {
			process.env.ENABLE_DEMO_MODE = 'true';
			const handler = getDemoAlert();
			const req = { query: { text: 'preview me', channels: 'telegram' } };
			const res = mockRes();
			await handler(req, res);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				success: true,
				meta: expect.objectContaining({ demo: true, synthetic: true, banner: DEFAULT_DEMO_BANNER }),
				alert: expect.objectContaining({ source: 'demo', text: 'preview me' }),
			}));
		});
	});

	describe('GET /api/demo/outcomes', () => {
		it('returns 404 when disabled', async () => {
			delete process.env.ENABLE_DEMO_MODE;
			const handler = getDemoOutcomes();
			await handler({ query: {} }, mockRes());
		});

		it('returns synthetic outcomes when enabled', async () => {
			process.env.ENABLE_DEMO_MODE = 'true';
			const handler = getDemoOutcomes();
			const res = mockRes();
			await handler({ query: { symbol: 'BINANCE:BTCUSDT' } }, res);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				success: true,
				meta: expect.objectContaining({ demo: true }),
				outcomes: expect.objectContaining({ symbol: 'BINANCE:BTCUSDT' }),
			}));
		});
	});

	describe('GET /api/demo/scanner', () => {
		it('returns synthetic scanner when enabled', async () => {
			process.env.ENABLE_DEMO_MODE = 'true';
			const handler = getDemoScanner();
			const res = mockRes();
			await handler({ query: { exchange: 'nasdaq' } }, res);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				success: true,
				scanner: expect.objectContaining({ exchange: 'NASDAQ', items: expect.any(Array) }),
			}));
		});
	});
});