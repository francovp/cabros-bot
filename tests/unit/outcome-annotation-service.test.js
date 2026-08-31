'use strict';

const path = require('path');

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	summarizeOutcomes: jest.fn(),
}));

jest.mock('../../src/services/remoteConfig/RemoteConfigService', () => ({
	getRuntimeConfig: jest.fn(() => ({})),
}));

describe('outcomeAnnotationService', () => {
	let service;
	let summarizeOutcomes;
	let getRuntimeConfig;

	beforeEach(() => {
		jest.resetModules();
		const outcomeModule = require('../../src/services/alerts/outcomeAnnotationService');
		const signalService = require('../../src/services/storage/SignalOutcomeService');
		const remoteConfig = require('../../src/services/remoteConfig/RemoteConfigService');
		summarizeOutcomes = signalService.summarizeOutcomes;
		getRuntimeConfig = remoteConfig.getRuntimeConfig;
		summarizeOutcomes.mockReset();
		getRuntimeConfig.mockReset();
		getRuntimeConfig.mockReturnValue({});
		service = outcomeModule.createOutcomeAnnotationService();
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	test('returns null when feature flag is disabled', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: false });
		const annotation = await service.annotate({
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			side: 'BUY',
		});
		expect(annotation).toBeNull();
		expect(summarizeOutcomes).not.toHaveBeenCalled();
	});

	test('returns null when symbol is missing', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		const annotation = await service.annotate({
			exchange: 'BINANCE',
			side: 'BUY',
		});
		expect(annotation).toBeNull();
		expect(summarizeOutcomes).not.toHaveBeenCalled();
	});

	test('returns null when side is missing or unparseable', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		expect(await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT' })).toBeNull();
		expect(await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'FLAT' })).toBeNull();
		expect(summarizeOutcomes).not.toHaveBeenCalled();
	});

	test('builds a BUY annotation from bySide aggregate when sample meets the threshold (totalSignals field)', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockResolvedValueOnce({
			available: true,
			windows: {
				'30d': {
					ALL: { totalSignals: 12, hitRatePercent: 30, expectancyR: -0.4 },
					bySide: {
						BUY: { totalSignals: 10, hitRatePercent: 40, expectancyR: 0.2, totalWins: 4, totalLosses: 6 },
					},
				},
			},
		});

		const annotation = await service.annotate({
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			side: 'BUY',
		});

		expect(annotation).not.toBeNull();
		expect(annotation.sampleSize).toBe(10);
		expect(annotation.hitRatePercent).toBe(40);
		expect(annotation.expectancyR).toBe(0.2);
		expect(annotation.side).toBe('BUY');
		expect(annotation.setupType).toBeNull();
		expect(annotation.summary).toContain('hitRate 40%');
		expect(annotation.summary).toContain('+0.20R');
		expect(annotation.summary).toContain('W4/L6');
	});

	test('uses bySetupType aggregate when available and matches requested setup', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockResolvedValueOnce({
			available: true,
			windows: {
				'30d': {
					bySide: {
						BUY: { totalSignals: 20, hitRatePercent: 45, expectancyR: 0.1 },
					},
					bySetupType: {
						breakout: { totalSignals: 8, hitRatePercent: 75, expectancyR: 1.5, totalWins: 6, totalLosses: 2 },
					},
				},
			},
		});

		const annotation = await service.annotate({
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			side: 'BUY',
			setupType: 'breakout',
		});

		expect(annotation).not.toBeNull();
		expect(annotation.sampleSize).toBe(8);
		expect(annotation.hitRatePercent).toBe(75);
		expect(annotation.expectancyR).toBe(1.5);
		expect(annotation.setupType).toBe('breakout');
		expect(annotation.summary).toContain('· breakout');
		expect(annotation.summary).toContain('hitRate 75%');
	});

	test('falls back to bySide when setupType is not found in bySetupType without falsely labeling summary', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockResolvedValueOnce({
			available: true,
			windows: {
				'30d': {
					bySide: {
						BUY: { totalSignals: 15, hitRatePercent: 50, expectancyR: 0.3 },
					},
					bySetupType: {
						reversal: { totalSignals: 6, hitRatePercent: 60, expectancyR: 0.8 },
					},
				},
			},
		});

		const annotation = await service.annotate({
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			side: 'BUY',
			setupType: 'breakout',
		});

		expect(annotation).not.toBeNull();
		expect(annotation.sampleSize).toBe(15);
		expect(annotation.hitRatePercent).toBe(50);
		expect(annotation.setupType).toBeNull();
		expect(annotation.summary).not.toContain('· breakout');
	});

	test('falls back to the ALL aggregate when the side bucket is missing', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockResolvedValueOnce({
			available: true,
			windows: {
				'30d': {
					ALL: { sampleSize: 7, hitRatePercent: 50, expectancyR: 0.1 },
				},
			},
		});

		const annotation = await service.annotate({
			exchange: 'NASDAQ',
			symbol: 'NVDA',
			side: 'SELL',
		});

		expect(annotation).not.toBeNull();
		expect(annotation.sampleSize).toBe(7);
		expect(annotation.side).toBe('SELL');
		expect(annotation.expectancyR).toBe(0.1);
	});

	test('returns null when the aggregate sample is below the configured threshold', async () => {
		getRuntimeConfig.mockReturnValue({
			ENABLE_OUTCOME_INFORMED_DELIVERY: true,
			OUTCOME_ANNOTATION_MIN_SAMPLE: 8,
		});
		summarizeOutcomes.mockResolvedValueOnce({
			available: true,
			windows: {
				'30d': {
					bySide: {
						BUY: { totalSignals: 4, hitRatePercent: 60, expectancyR: 0.5 },
					},
				},
			},
		});

		const annotation = await service.annotate({
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			side: 'BUY',
		});

		expect(annotation).toBeNull();
	});

	test('returns null when summary is unavailable', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockResolvedValueOnce({ available: false });
		expect(await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'BUY' })).toBeNull();
	});

	test('fails open on lookup error', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockRejectedValueOnce(new Error('boom'));
		const annotation = await service.annotate({
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			side: 'BUY',
		});
		expect(annotation).toBeNull();
	});

	test('fails open on lookup timeout via awaitWithTimeout race', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		const never = new Promise(() => {});
		summarizeOutcomes.mockImplementationOnce(() => never);
		const annotation = await service.annotate(
			{ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'BUY' },
			{ timeoutMs: 1 },
		);
		expect(annotation).toBeNull();
	});

	test('normalizes alternate side spellings (LONG/SHORT/COMPRA/VENTA)', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockResolvedValue({
			available: true,
			windows: {
				'30d': {
					bySide: {
						BUY: { sampleSize: 10, hitRatePercent: 40 },
						SELL: { sampleSize: 10, hitRatePercent: 35 },
					},
				},
			},
		});

		const longAnnotation = await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'LONG' });
		expect(longAnnotation.side).toBe('BUY');

		const shortAnnotation = await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'SHORT' });
		expect(shortAnnotation.side).toBe('SELL');

		const compraAnnotation = await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'COMPRA' });
		expect(compraAnnotation.side).toBe('BUY');

		const ventaAnnotation = await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'VENTA' });
		expect(ventaAnnotation.side).toBe('SELL');
	});

	test('passes symbol/exchange/lookback into summarizeOutcomes', async () => {
		getRuntimeConfig.mockReturnValue({
			ENABLE_OUTCOME_INFORMED_DELIVERY: true,
			OUTCOME_ANNOTATION_LOOKBACK_DAYS: 7,
		});
		summarizeOutcomes.mockResolvedValueOnce({
			available: true,
			windows: { '7d': { bySide: { BUY: { sampleSize: 9, hitRatePercent: 44 } } } },
		});

		await service.annotate({
			exchange: 'BINANCE',
			symbol: 'ETHUSDT',
			side: 'BUY',
		});

		expect(summarizeOutcomes).toHaveBeenCalledTimes(1);
		const args = summarizeOutcomes.mock.calls[0][0];
		expect(args.exchange).toBe('BINANCE');
		expect(args.symbol).toBe('ETHUSDT');
		expect(args.limit).toBe(1000);
		expect(args.signal).toBeDefined();
		expect(typeof args.signal.aborted).toBe('boolean');

		const fromMs = new Date(args.from).getTime();
		const toMs = new Date(args.to).getTime();
		const windowMs = toMs - fromMs;
		expect(windowMs).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 5000);
		expect(windowMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 5000);
		expect(toMs).toBeGreaterThanOrEqual(fromMs);
		expect(toMs - fromMs).toBe(7 * 24 * 60 * 60 * 1000);
	});

	test('stats counters track lookups, annotations, disabled (errors are fail-open inside the helper)', async () => {
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		summarizeOutcomes.mockResolvedValueOnce({
			available: true,
			windows: { '30d': { bySide: { BUY: { sampleSize: 5, hitRatePercent: 50 } } } },
		});
		await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'BUY' });

		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: false });
		await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'BUY' });

		summarizeOutcomes.mockRejectedValueOnce(new Error('boom'));
		getRuntimeConfig.mockReturnValue({ ENABLE_OUTCOME_INFORMED_DELIVERY: true });
		await service.annotate({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'BUY' });

		const stats = service.getStats();
		expect(stats.lookups).toBe(3);
		expect(stats.annotated).toBe(1);
		expect(stats.disabled).toBe(1);
		expect(stats.errors).toBe(0);
		expect(typeof stats.lastAnnotatedAt).toBe('string');
	});

	test('singleton is exposed for reuse across the alert path', () => {
		const mod = require('../../src/services/alerts/outcomeAnnotationService');
		expect(typeof mod.outcomeAnnotationService.annotate).toBe('function');
		expect(typeof mod.outcomeAnnotationService.getStats).toBe('function');
		expect(typeof mod.renderAnnotationLine).toBe('function');
	});
});

describe('awaitWithTimeout helper', () => {
	const { awaitWithTimeout } = require('../../src/lib/asyncTimeout');

	test('resolves with the upstream value when it settles before the timeout', async () => {
		const result = await awaitWithTimeout(Promise.resolve('ok'), 100, 'too late');
		expect(result).toBe('ok');
	});

	test('rejects with the supplied message when the timeout fires first', async () => {
		let resolveFn;
		const pending = new Promise((resolve) => { resolveFn = resolve; });
		const awaited = awaitWithTimeout(pending, 5, 'waited too long');
		await expect(awaited).rejects.toThrow('waited too long');
		resolveFn();
		await pending.catch(() => {});
	});

	test('propagates upstream errors', async () => {
		await expect(
			awaitWithTimeout(Promise.reject(new Error('upstream blew up')), 100, 'timeout'),
		).rejects.toThrow('upstream blew up');
	});

	test('clears its timer on upstream settlement', async () => {
		const clearSpy = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
		await awaitWithTimeout(Promise.resolve('done'), 100, 'never');
		expect(clearSpy).toHaveBeenCalled();
		clearSpy.mockRestore();
	});
});
