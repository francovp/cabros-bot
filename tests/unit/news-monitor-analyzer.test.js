const {
	calculateVolumeRatio,
	calculateRSI,
	calculateAdjustedConfidence,
	NewsAnalyzer,
	getCachedRoutingMetadata,
	hashDiscordWebhook,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');

describe('News Monitor Analyzer - Volume & RSI Filtering', () => {
	describe('cached routing identities', () => {
		it('stores effective defaults and only a hash for Discord webhook destinations', () => {
			const discordWebhookUrl = 'https://discord.com/api/webhooks/123/secret-token';
			const notificationManager = {
				channels: new Map([
					['telegram', { chatId: 'telegram-default' }],
					['whatsapp', { chatId: 'whatsapp-default' }],
					['discord', { webhookUrl: discordWebhookUrl }],
				]),
			};

			const metadata = getCachedRoutingMetadata({}, {}, notificationManager);

			expect(metadata.telegramChatId).toBe('telegram-default');
			expect(metadata.whatsappChatId).toBe('whatsapp-default');
			expect(metadata.discordWebhookFingerprint).toBe(hashDiscordWebhook(discordWebhookUrl));
			expect(metadata.discordWebhookUrl).toBeUndefined();
		});

		it('uses a new effective default as a different cached destination', () => {
			const notificationManager = {
				channels: new Map([
					['telegram', { chatId: 'telegram-new' }],
				]),
			};

			const metadata = getCachedRoutingMetadata({}, { telegramChatId: 'telegram-old' }, notificationManager);

			expect(metadata.telegramChatId).toBe('telegram-new');
		});

		it('omits unavailable routing identities from cached metadata', () => {
			const notificationManager = {
				channels: new Map([
					['telegram', { chatId: 'telegram-default' }],
				]),
			};

			const metadata = getCachedRoutingMetadata({}, {}, notificationManager);

			expect(metadata.telegramChatId).toBe('telegram-default');
			expect(metadata).not.toHaveProperty('discordWebhookFingerprint');
			expect(Object.values(metadata)).not.toContain(undefined);
		});

		it('preserves telegramThreadId in cached routing metadata and includes in destination identity', () => {
			const notificationManager = {
				channels: new Map([
					['telegram', { chatId: 'telegram-default' }],
				]),
			};

			const metadata = getCachedRoutingMetadata({ telegramThreadId: 42 }, {}, notificationManager);
			expect(metadata.telegramChatId).toBe('telegram-default:42');
			expect(metadata.telegramThreadId).toBe(42);
		});
	});

	describe('calculateVolumeRatio', () => {
		it('should calculate volume ratio accurately when volume expands', () => {
			// 10 candles with volume 100, latest candle volume 180 -> 180 / 100 = 1.80
			const klines = Array.from({ length: 10 }, () => ({ volume: '100' }));
			klines.push({ volume: '180' });

			const ratio = calculateVolumeRatio(klines);
			expect(ratio).toBe(1.8);
		});

		it('should calculate volume ratio when volume contracts', () => {
			// 10 candles with volume 100, latest candle volume 70 -> 70 / 100 = 0.70
			const klines = Array.from({ length: 10 }, () => ({ volume: '100' }));
			klines.push({ volume: '70' });

			const ratio = calculateVolumeRatio(klines);
			expect(ratio).toBe(0.7);
		});

		it('should handle array format klines [openTime, open, high, low, close, volume]', () => {
			const klines = Array.from({ length: 10 }, () => [0, '10', '12', '9', '11', '100']);
			klines.push([0, '10', '12', '9', '11', '200']);

			const ratio = calculateVolumeRatio(klines);
			expect(ratio).toBe(2.0);
		});

		it('should return null for insufficient kline data or zero average volume', () => {
			expect(calculateVolumeRatio([])).toBeNull();
			expect(calculateVolumeRatio([{ volume: '100' }])).toBeNull();
			expect(calculateVolumeRatio(null)).toBeNull();

			const zeroKlines = [{ volume: '0' }, { volume: '0' }];
			expect(calculateVolumeRatio(zeroKlines)).toBeNull();
		});

		it('should exclude currently open candle when calculating volume ratio', () => {
			const now = 1722000000000;
			const completedKlines = Array.from({ length: 10 }, (_, i) => ({
				openTime: now - (11 - i) * 3600000,
				closeTime: now - (10 - i) * 3600000 - 1,
				volume: '100',
			}));
			// Partial open candle with low volume '10' currently forming
			const openKline = {
				openTime: now - 1800000,
				closeTime: now + 1800000,
				volume: '10',
			};
			const klines = [...completedKlines, openKline];

			const ratio = calculateVolumeRatio(klines, { now });
			expect(ratio).toBe(1.0);
		});

		it('should exclude open candle in array format klines [openTime, open, high, low, close, volume, closeTime]', () => {
			const now = 1722000000000;
			const completedKlines = Array.from({ length: 10 }, (_, i) => [
				now - (11 - i) * 3600000,
				'10',
				'12',
				'9',
				'11',
				'100',
				now - (10 - i) * 3600000 - 1,
			]);
			const openKline = [
				now - 1800000,
				'10',
				'12',
				'9',
				'11',
				'15',
				now + 1800000,
			];
			const klines = [...completedKlines, openKline];

			const ratio = calculateVolumeRatio(klines, { now });
			expect(ratio).toBe(1.0);
		});

		it('should return null if excluding open candle leaves fewer than 2 completed candles', () => {
			const now = 1722000000000;
			const singleCompleted = [
				{
					openTime: now - 3600000,
					closeTime: now - 1,
					volume: '100',
				},
				{
					openTime: now - 1800000,
					closeTime: now + 1800000,
					volume: '10',
				},
			];
			expect(calculateVolumeRatio(singleCompleted, { now })).toBeNull();
		});
	});

	describe('calculateRSI', () => {
		it('should return null when price data has 14 or fewer candles', () => {
			const shortPrices = Array.from({ length: 14 }, (_, i) => 100 + i);
			expect(calculateRSI(shortPrices)).toBeNull();
		});

		it('should calculate 14-period RSI correctly for a price series', () => {
			// 20 price points with alternating up/down movements
			const prices = [
				44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
				45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 46.25,
			];
			const rsi = calculateRSI(prices);
			expect(typeof rsi).toBe('number');
			expect(rsi).toBeGreaterThan(0);
			expect(rsi).toBeLessThan(100);
		});

		it('should return 100 for monotonically increasing prices', () => {
			const prices = Array.from({ length: 20 }, (_, i) => 100 + i * 2);
			expect(calculateRSI(prices)).toBe(100);
		});
	});

	describe('calculateAdjustedConfidence', () => {
		it('should return unchanged confidence when marketContext or indicators are missing', () => {
			const analyzer = new NewsAnalyzer();

			expect(analyzer.calculateAdjustedConfidence(0.8, null)).toBe(0.8);
			expect(analyzer.calculateAdjustedConfidence(0.8, {})).toBe(0.8);
			expect(analyzer.calculateAdjustedConfidence(0.8, { price: 100 })).toBe(0.8);
		});

		it('should boost confidence when volume ratio > 1.5 and RSI is in healthy range (40-65)', () => {
			const analyzer = new NewsAnalyzer();
			const context = { volumeRatio: 1.8, rsi: 52 };

			// Base 0.75 + 0.10 (volume boost) + 0.05 (RSI boost) = 0.90
			const adjusted = analyzer.calculateAdjustedConfidence(0.75, context);
			expect(adjusted).toBe(0.9);
		});

		it('should reduce confidence when volume ratio < 1.0 or RSI > 75 (overbought trap)', () => {
			const analyzer = new NewsAnalyzer();

			// Volume penalty (-0.10)
			expect(analyzer.calculateAdjustedConfidence(0.8, { volumeRatio: 0.8 })).toBe(0.7);

			// Overbought RSI penalty (-0.15)
			expect(analyzer.calculateAdjustedConfidence(0.8, { rsi: 80 })).toBe(0.65);

			// Combined penalty: 0.8 - 0.10 - 0.15 = 0.55
			expect(analyzer.calculateAdjustedConfidence(0.8, { volumeRatio: 0.7, rsi: 82 })).toBe(0.55);
		});

		it('should clamp confidence within [0.0, 1.0] bounds', () => {
			const analyzer = new NewsAnalyzer();

			expect(analyzer.calculateAdjustedConfidence(0.95, { volumeRatio: 2.0, rsi: 50 })).toBe(1.0);
			expect(analyzer.calculateAdjustedConfidence(0.1, { volumeRatio: 0.5, rsi: 85 })).toBe(0.0);
		});
	});

	describe('Alert formatting with Volume & RSI', () => {
		it('should include Volume Ratio and RSI in buildAlert and formatAlertMessage', () => {
			const analyzer = new NewsAnalyzer();
			const geminiAnalysis = {
				headline: 'Partnership Announcement',
				event_category: 'price_surge',
				sentiment_score: 0.8,
				confidence: 0.85,
			};
			const marketContext = {
				price: 150.5,
				change24h: 3.2,
				volumeRatio: 1.75,
				rsi: 58.4,
				source: 'binance',
			};

			const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, marketContext);
			expect(alert.marketContext.volumeRatio).toBe(1.75);
			expect(alert.marketContext.rsi).toBe(58.4);
			expect(alert.volumeRatio).toBe(1.75);
			expect(alert.rsi).toBe(58.4);
			expect(alert.enriched.summary).toContain('Volume Ratio:* 1.75x');
			expect(alert.enriched.summary).toContain('RSI (14):* 58.4');

			const message = analyzer.formatAlertMessage('BTCUSDT', geminiAnalysis, marketContext);
			expect(message).toContain('Volume Ratio: 1.75x');
			expect(message).toContain('RSI (14): 58.4');
		});
	});

	describe('deriveBarriers', () => {
		const analyzer = new NewsAnalyzer();

		it('should derive valid BUY stop and target with short_term horizon (2% stop, 1.5R target)', () => {
			const barriers = analyzer.deriveBarriers(100, 0.8, 'short_term');
			expect(barriers).toEqual({
				stop: 98,
				target: 103,
				side: 'BUY',
				stopPct: 0.02,
				rewardMultiplier: 1.5,
			});
		});

		it('should derive valid SELL stop and target with short_term horizon', () => {
			const barriers = analyzer.deriveBarriers(100, -0.6, 'short_term');
			expect(barriers).toEqual({
				stop: 102,
				target: 97,
				side: 'SELL',
				stopPct: 0.02,
				rewardMultiplier: 1.5,
			});
		});

		it('should scale stop percentage based on time_horizon', () => {
			// very_short_term -> 1%
			const vst = analyzer.deriveBarriers(100, 0.5, 'very_short_term');
			expect(vst.stop).toBe(99);
			expect(vst.target).toBe(101.5);

			// medium_term -> 3.5%
			const mt = analyzer.deriveBarriers(100, 0.5, 'medium_term');
			expect(mt.stop).toBe(96.5);
			expect(mt.target).toBe(105.25);

			// long_term -> 5%
			const lt = analyzer.deriveBarriers(100, 0.5, 'long_term');
			expect(lt.stop).toBe(95);
			expect(lt.target).toBe(107.5);
		});

		it('should return null when price is invalid or non-positive', () => {
			expect(analyzer.deriveBarriers(null, 0.8, 'short_term')).toBeNull();
			expect(analyzer.deriveBarriers(0, 0.8, 'short_term')).toBeNull();
			expect(analyzer.deriveBarriers(-100, 0.8, 'short_term')).toBeNull();
			expect(analyzer.deriveBarriers('invalid', 0.8, 'short_term')).toBeNull();
		});

		it('should return null when sentiment score is below minimum conviction threshold', () => {
			expect(analyzer.deriveBarriers(100, 0.10, 'short_term')).toBeNull();
			expect(analyzer.deriveBarriers(100, -0.05, 'short_term')).toBeNull();
			expect(analyzer.deriveBarriers(100, 0, 'short_term')).toBeNull();
		});
	});

	describe('buildAlert with invalidation, horizon, and outcome barriers', () => {
		const analyzer = new NewsAnalyzer();

		it('should attach stop and target to alert when marketContext has a valid price', () => {
			const geminiAnalysis = {
				headline: 'Major breaking news',
				event_category: 'price_surge',
				sentiment_score: 0.8,
				confidence: 0.9,
				time_horizon: 'short_term',
				invalidation_hint: 'Reversal below 95k',
			};
			const marketContext = {
				price: 100000,
				source: 'binance',
			};

			const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, marketContext);
			expect(alert.stop).toBe(98000);
			expect(alert.target).toBe(103000);
			expect(alert.time_horizon).toBe('short_term');
			expect(alert.invalidation_hint).toBe('Reversal below 95k');
			expect(alert.enriched.summary).toContain('*Horizonte:* Corto plazo');
			expect(alert.enriched.summary).toContain('*Invalidación:* Reversal below 95k');
		});

		it('should leave stop and target undefined when marketContext is absent', () => {
			const geminiAnalysis = {
				headline: 'Major breaking news',
				event_category: 'price_surge',
				sentiment_score: 0.8,
				confidence: 0.9,
				time_horizon: 'short_term',
			};

			const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, null);
			expect(alert.stop).toBeUndefined();
			expect(alert.target).toBeUndefined();
		});
	});

	describe('barriers provenance (issue #809 / CB-???)', () => {
		const analyzer = new NewsAnalyzer();

		it('preserves the full derived-barrier payload on the alert and enriched object', () => {
			const geminiAnalysis = {
				headline: 'Bullish breakout',
				event_category: 'price_surge',
				sentiment_score: 0.8,
				confidence: 0.9,
				time_horizon: 'short_term',
			};
			const marketContext = { price: 100, source: 'binance' };

			const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, marketContext);

			expect(alert.barriers).toEqual({
				stop: 98,
				target: 103,
				side: 'BUY',
				stopPct: 0.02,
				rewardMultiplier: 1.5,
				source: 'derived',
				timeHorizon: 'short_term',
			});
			expect(alert.enriched.barriers).toEqual(alert.barriers);
		});

		it('records SELL-derived barriers with stop>price, target<price, side=SELL', () => {
			const geminiAnalysis = {
				headline: 'Bearish drop',
				event_category: 'price_decline',
				sentiment_score: -0.8,
				confidence: 0.9,
				time_horizon: 'short_term',
			};
			const marketContext = { price: 100, source: 'binance' };

			const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, marketContext);

			expect(alert.barriers.side).toBe('SELL');
			expect(alert.barriers.stop).toBeGreaterThan(100);
			expect(alert.barriers.target).toBeLessThan(100);
			expect(alert.barriers.stopPct).toBeCloseTo(0.02, 5);
			expect(alert.barriers.rewardMultiplier).toBe(1.5);
			expect(alert.barriers.source).toBe('derived');
		});

		it('uses marketContext provenance when deriveBarriers is null', () => {
			const geminiAnalysis = {
				headline: 'Major news',
				event_category: 'public_figure',
				sentiment_score: 0.05, // below conviction threshold so deriveBarriers returns null
				confidence: 0.9,
				time_horizon: 'short_term',
			};
			const marketContext = {
				price: 100,
				source: 'binance',
				stop: 95,
				target: 110,
			};

			const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, marketContext);

			expect(alert.barriers).toEqual({ source: 'marketContext' });
			expect(alert.stop).toBe(95);
			expect(alert.target).toBe(110);
		});

		it('returns barriers=null when no price, no derived, no marketContext levels', () => {
			const geminiAnalysis = {
				headline: 'Low conviction event',
				event_category: 'public_figure',
				sentiment_score: 0.05,
				confidence: 0.6,
				time_horizon: 'short_term',
			};

			const alert = analyzer.buildAlert('BTCUSDT', geminiAnalysis, null);

			expect(alert.barriers).toBeNull();
			expect(alert.stop).toBeUndefined();
			expect(alert.target).toBeUndefined();
		});
	});
});



