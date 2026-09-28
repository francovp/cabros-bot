'use strict';

const {
	StrategyResearchCache,
	strategyResearchCache,
} = require('../../src/services/tradingview/strategyResearchCache');

describe('StrategyResearchCache', () => {
	let cache;

	beforeEach(() => {
		cache = new StrategyResearchCache();
	});

	it('returns null on cache miss', () => {
		expect(cache.get('non_existent_key')).toBeNull();
	});

	it('stores and retrieves cached data before expiration', () => {
		const key = cache.buildKey('compare_strategies', { symbol: 'BTCUSDT', exchange: 'BINANCE' });
		const payload = { best_strategy: 'rsi', win_rate: 0.65 };

		cache.set(key, payload, 10000);

		const retrieved = cache.get(key);
		expect(retrieved).toEqual(payload);
	});

	it('returns null when cached data expires', () => {
		const key = 'test_expired_key';
		cache.set(key, { foo: 'bar' }, -10); // Expired immediately

		expect(cache.get(key)).toBeNull();
	});

	it('generates consistent deterministic keys regardless of object key order', () => {
		const key1 = cache.buildKey('compare_strategies', {
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			interval: '1h',
			period: '1y',
		});

		const key2 = cache.buildKey('compare_strategies', {
			period: '1y',
			interval: '1h',
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
		});

		expect(key1).toBe(key2);
	});

	it('clears all cached entries', () => {
		cache.set('key1', { a: 1 }, 10000);
		cache.set('key2', { b: 2 }, 10000);
		expect(cache.size()).toBe(2);

		cache.clear();
		expect(cache.size()).toBe(0);
		expect(cache.get('key1')).toBeNull();
	});

	it('exports a default singleton instance', () => {
		expect(strategyResearchCache).toBeInstanceOf(StrategyResearchCache);
	});
});
