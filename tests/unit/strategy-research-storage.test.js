'use strict';

const {
	StrategyResearchStorageService,
	sanitizeFirestoreData,
} = require('../../src/services/storage/StrategyResearchStorageService');

describe('StrategyResearchStorageService', () => {
	describe('sanitizeFirestoreData', () => {
		it('removes undefined values from nested objects', () => {
			const input = {
				a: 1,
				b: undefined,
				c: {
					d: 'hello',
					e: undefined,
					f: [1, undefined, 2, { g: undefined, h: 'world' }],
				},
			};

			const cleaned = sanitizeFirestoreData(input);
			expect(cleaned).toEqual({
				a: 1,
				c: {
					d: 'hello',
					f: [1, null, 2, { h: 'world' }],
				},
			});
		});
	});

	describe('service operations', () => {
		let service;
		let mockFirestore;
		let mockCollection;
		let mockDoc;

		beforeEach(() => {
			mockDoc = {
				set: jest.fn().mockResolvedValue(true),
			};
			mockCollection = {
				doc: jest.fn().mockReturnValue(mockDoc),
			};
			mockFirestore = {
				collection: jest.fn().mockReturnValue(mockCollection),
			};
			service = new StrategyResearchStorageService({
				firestore: mockFirestore,
				enabled: true,
			});
		});

		it('skips saving when disabled', async () => {
			const disabledService = new StrategyResearchStorageService({
				firestore: mockFirestore,
				enabled: false,
			});

			const result = await disabledService.saveResearchRun({
				tool: 'compare_strategies',
				symbol: 'BTCUSDT',
			});

			expect(result).toEqual({ saved: false, reason: 'disabled' });
			expect(mockFirestore.collection).not.toHaveBeenCalled();
		});

		it('saves research run with sanitized payload when enabled', async () => {
			const result = await service.saveResearchRun({
				tool: 'compare_strategies',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				strategy: undefined,
				interval: '1h',
				period: '1y',
				params: { test: undefined, val: 123 },
				result: { win_rate: 0.75 },
				cached: false,
			});

			expect(result.saved).toBe(true);
			expect(mockFirestore.collection).toHaveBeenCalledWith('strategyResearch');
			expect(mockDoc.set).toHaveBeenCalledTimes(1);

			const savedPayload = mockDoc.set.mock.calls[0][0];
			expect(savedPayload.tool).toBe('compare_strategies');
			expect(savedPayload.symbol).toBe('BTCUSDT');
			expect(savedPayload.exchange).toBe('BINANCE');
			expect(savedPayload.params).toEqual({ val: 123 });
			expect(savedPayload.cached).toBe(false);
			expect(savedPayload).not.toHaveProperty('strategy');
		});

		it('fails open when firestore write throws', async () => {
			mockDoc.set.mockRejectedValue(new Error('Firestore connection timeout'));

			const result = await service.saveResearchRun({
				tool: 'walk_forward_backtest_strategy',
				symbol: 'ETHUSDT',
			});

			expect(result.saved).toBe(false);
			expect(result.error).toContain('Firestore connection timeout');
		});
	});
});
