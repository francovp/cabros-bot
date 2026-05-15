const {
	buildReminderKey,
	isReminderEligible,
	normalizeActionableAlert,
} = require('../../src/services/alerts/actionableAlert');

describe('actionableAlert helpers', () => {
	it('normalizes bearish scores to a signed value and builds fallback scenarios', () => {
		const result = normalizeActionableAlert({
			original_text: 'BTC pierde fuerza en 4H',
			sentiment: 'BEARISH',
			sentiment_score: 0.8,
			technical_levels: {
				supports: ['79.3k', '78.1k'],
				resistances: ['82.8k', '85k'],
			},
		});

		expect(result.sentiment_score).toBe(-0.8);
		expect(result.signal_side).toBe('SELL');
		expect(result.scenarios.bull).toEqual({
			trigger: 'Si rompe 82.8k',
			outcome: 'objetivo 85k',
		});
		expect(result.scenarios.bear).toEqual({
			trigger: 'Si pierde 79.3k',
			outcome: 'caida probable a 78.1k',
		});
	});

	it('marks strong sell setups as reminder eligible and creates a stable key', () => {
		const enriched = normalizeActionableAlert({
			original_text: 'BTCUSDT(240) paso a senal de VENTA',
			asset_symbol: 'BTCUSDT',
			timeframe: '4h',
			signal_side: 'SELL',
			urgency_level: 'HIGH',
			sentiment: 'BEARISH',
			sentiment_score: -0.9,
		});

		expect(isReminderEligible(enriched)).toBe(true);
		expect(buildReminderKey(enriched)).toBe('BTCUSDT|SELL|4h');
	});
});
