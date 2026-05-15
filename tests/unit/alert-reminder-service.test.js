const { AlertReminderService } = require('../../src/services/alerts/AlertReminderService');

describe('AlertReminderService', () => {
	it('adds a reminder only on the second repeated strong sell alert', () => {
		const service = new AlertReminderService({ ttlMs: 60000, maxEntries: 10 });
		const baseAlert = {
			original_text: 'BTCUSDT(240) paso a senal de VENTA',
			asset_symbol: 'BTCUSDT',
			timeframe: '4h',
			signal_side: 'SELL',
			urgency_level: 'HIGH',
			urgency_reason: 'Venta fuerte alineada.',
			sentiment: 'BEARISH',
			sentiment_score: -0.9,
			recommended_action: 'Cerrar o reducir posicion ya.',
		};

		const first = service.annotate(baseAlert);
		const second = service.annotate(baseAlert);
		const third = service.annotate(baseAlert);

		expect(first.reminder).toBeNull();
		expect(second.reminder).toEqual(expect.objectContaining({
			triggered: true,
			text: expect.stringContaining('venta fuerte'),
		}));
		expect(third.reminder).toBeNull();
	});
});
