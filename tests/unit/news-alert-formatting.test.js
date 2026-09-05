/**
 * News Alert Formatting Tests
 * Verifies that news alert sources are formatted as markdown links with titles
 * instead of raw URLs
 */

const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
const MarkdownV2Formatter = require('../../src/services/notification/formatters/markdownV2Formatter');

describe('News Alert Source Formatting', () => {
	let analyzer;
	let formatter;

	beforeEach(() => {
		analyzer = new NewsAnalyzer();
		formatter = new MarkdownV2Formatter();
	});

	describe('MarkdownV2Formatter.formatEnriched', () => {
		const mockEnrichedAlert = {
			original_text: 'Bitcoin breaks 83k',
			sentiment: 'BULLISH',
			sentiment_score: 0.9,
			insights: [
				'Bitcoin price surged past $83k.',
				'Volume indicates strong momentum.',
			],
			technical_levels: {
				supports: ['$80,000', '$81,500'],
				resistances: ['$85,000'],
			},
			sources: [
				{
					title: 'CoinDesk',
					url: 'https://coindesk.com/btc',
				},
				{
					title: 'Bloomberg',
					url: 'https://bloomberg.com/crypto',
				},
			],
		};

		it('should format enriched alert with all sections', () => {
			const message = formatter.formatEnriched(mockEnrichedAlert);

			// Check Sentiment
			expect(message).toContain('Sentiment: BULLISH 🚀 \\(0\\.90\\)');

			// Check Insights
			expect(message).toContain('*Key Insights*');
			expect(message).toContain('• Bitcoin price surged past $83k\\.');
			expect(message).toContain('• Volume indicates strong momentum\\.');

			// Check Technical Levels
			expect(message).toContain('*Technical Levels*');
			expect(message).toContain('Supports: $80,000, $81,500');
			expect(message).toContain('Resistances: $85,000');

			// Check Sources
			expect(message).toContain('*Sources*');
			expect(message).toContain('[CoinDesk](https://coindesk.com/btc)');
			expect(message).toContain('[Bloomberg](https://bloomberg.com/crypto)');
		});

		it('should handle missing technical levels', () => {
			const alert = { ...mockEnrichedAlert, technical_levels: { supports: [], resistances: [] } };
			const message = formatter.formatEnriched(alert);
			expect(message).not.toContain('*Technical Levels*');
		});

		it('escapes raw markdown delimiters in untrusted level strings', () => {
			const alert = {
				...mockEnrichedAlert,
				technical_levels: { supports: ['80_000', '79*500'], resistances: [] },
			};
			const message = formatter.formatEnriched(alert);

			expect(message).toContain('Supports: 80\\_000, 79\\*500');
			expect(message).not.toContain('80_000,');
		});

		it('should handle missing sources', () => {
			const alert = { ...mockEnrichedAlert, sources: [] };
			const message = formatter.formatEnriched(alert);
			expect(message).not.toContain('*Sources*');
		});

		it('should handle degraded/short alert (minimal fields)', () => {
			const degradedAlert = {
				original_text: 'Short alert',
				sentiment: 'NEUTRAL',
				sentiment_score: 0,
				insights: [],
				technical_levels: { supports: [], resistances: [] },
				sources: [],
			};
			const message = formatter.formatEnriched(degradedAlert);

			expect(message).toContain('*Short alert*');
			expect(message).toContain('Sentiment: NEUTRAL 😐 \\(0\\.00\\)');
			expect(message).not.toContain('*Key Insights*');
			expect(message).not.toContain('*Technical Levels*');
			expect(message).not.toContain('*Sources*');
		});

		it('should handle undefined optional fields', () => {
			const minimalAlert = {
				original_text: 'Minimal alert',
				sentiment: 'BULLISH',
				sentiment_score: 0.8,
				// insights undefined
				// technical_levels undefined
				// sources undefined
			};
			const message = formatter.formatEnriched(minimalAlert);

			expect(message).toContain('*Minimal alert*');
			expect(message).toContain('Sentiment: BULLISH 🚀 \\(0\\.80\\)');
			expect(message).not.toContain('*Key Insights*');
			expect(message).not.toContain('*Technical Levels*');
			expect(message).not.toContain('*Sources*');
		});

		it('should format optional risk parameters when present', () => {
			const message = formatter.formatEnriched({
				original_text: 'Bitcoin breaks 83k',
				sentiment: 'BULLISH',
				sentiment_score: 0.9,
				insights: [],
				invalidation_level: '$80,000',
				target_level: 90000,
				setup_type: 'breakout',
				risk_reward_ratio: '2.5:1',
			});

			expect(message).toContain('*Risk Parameters*');
			expect(message).toContain('Setup: breakout');
			expect(message).toContain('Invalidation: $80,000');
			expect(message).toContain('Target: 90000');
			expect(message).toContain('Risk/Reward: 2\\.5:1');
		});

		it('should escape underscores in setup_type values for Telegram MarkdownV2', () => {
			const messageReversion = formatter.formatEnriched({
				original_text: 'ETH pullback',
				sentiment: 'BEARISH',
				sentiment_score: -0.5,
				insights: [],
				setup_type: 'mean_reversion',
				risk_reward_ratio: 3,
			});

			// mean_reversion must not contain bare underscores — Telegram would treat them as italic markers
			expect(messageReversion).toContain('Setup: mean\\_reversion');
			expect(messageReversion).not.toMatch(/Setup: mean_reversion(?!\\)/);

			const messageContinuation = formatter.formatEnriched({
				original_text: 'BTC rally',
				sentiment: 'BULLISH',
				sentiment_score: 0.7,
				insights: [],
				setup_type: 'trend_continuation',
			});

			expect(messageContinuation).toContain('Setup: trend\\_continuation');
			expect(messageContinuation).not.toMatch(/Setup: trend_continuation(?!\\)/);
		});

		it('should escape asterisks in raw risk field values for Telegram MarkdownV2', () => {
			const message = formatter.formatEnriched({
				original_text: 'BTC invalidation',
				sentiment: 'NEUTRAL',
				sentiment_score: 0,
				insights: [],
				risk_reward_ratio: '1.5*ATR below entry',
			});

			expect(message).toContain('Risk/Reward: 1\\.5\\*ATR below entry');
			expect(message).not.toMatch(/Risk\/Reward: 1\\.5\*ATR below entry/);
		});
	});

	describe('MarkdownV2Formatter.formatNewsAlert (Backward Compatibility)', () => {
		const mockNewsAlert = {
			originalText: 'Bitcoin surges',
			summary: '*Sentiment:* Bullish 🚀 (0.85)\n*Price:* $83000',
			citations: [
				{ title: 'Source 1', url: 'https://example.com/1' },
				{ title: 'Source 2', url: 'https://example.com/2' },
			],
			extraText: '_Model Confidence: 90%_',
		};

		it('should format news alert correctly', () => {
			const message = formatter.formatEnriched(mockNewsAlert);

			expect(message).toContain('*Bitcoin surges*');
			expect(message).toContain('*Sentiment:* Bullish 🚀 (0.85)');
			expect(message).toContain('*Price:* $83000');
			expect(message).toContain('Sources: [Source 1](https://example.com/1) \\| [Source 2](https://example.com/2)');
			expect(message).toContain('_Model Confidence: 90%_');
		});
	});

	describe('MarkdownV2Formatter.formatNewsAlert derived barriers (issue #809 / CB-???)', () => {
		it('renders the Niveles derivados line when barriers.source is derived', () => {
			const message = formatter.formatNewsAlert({
				originalText: 'BTCUSDT: breakout',
				summary: '*Sentiment:* Bullish 🚀 (0.8)',
				extraText: '_Model Confidence: 90%_',
				barriers: {
					stop: 98,
					target: 103,
					side: 'BUY',
					stopPct: 0.02,
					rewardMultiplier: 1.5,
					source: 'derived',
					timeHorizon: 'short_term',
				},
			});

			expect(message).toContain('Niveles derivados');
			expect(message).toContain('Corto plazo');
			expect(message).toContain('2% stop');
			expect(message).toContain('R\\:R 1\\.5');
		});

		it('omits the Niveles derivados line when barriers.source is marketContext', () => {
			const message = formatter.formatNewsAlert({
				originalText: 'BTCUSDT: marketContext',
				summary: '*Sentiment:* Bullish 🚀 (0.8)',
				extraText: '_Model Confidence: 90%_',
				barriers: { source: 'marketContext' },
			});

			expect(message).not.toContain('Niveles derivados');
		});

		it('omits the Niveles derivados line when barriers is missing', () => {
			const message = formatter.formatNewsAlert({
				originalText: 'BTCUSDT: no barriers',
				summary: '*Sentiment:* Bullish 🚀 (0.8)',
				extraText: '_Model Confidence: 90%_',
			});

			expect(message).not.toContain('Niveles derivados');
		});
	});

	describe('formatAlertMessage with SearchResult objects', () => {
		it('should format sources as markdown links with titles', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Meta stock surges on strong earnings',
				sentiment_score: 0.8,
				confidence: 0.85,
				sources: [
					{
						title: 'Bloomberg - Meta Stock Soars',
						url: 'https://bloomberg.com/meta-stock',
					},
					{
						title: 'Reuters Markets',
						url: 'https://reuters.com/markets/meta',
					},
					{
						title: 'CNBC Tech News',
						url: 'https://cnbc.com/tech/meta',
					},
				],
			};

			const message = analyzer.formatAlertMessage('META', analysis, {
				price: 350.5,
				change24h: 5.2,
			});

			// Verify markdown link format (with escaped special characters for MarkdownV2)
			expect(message).toContain('[Bloomberg \\- Meta Stock Soars](https://bloomberg.com/meta-stock)');
			expect(message).toContain('[Reuters Markets](https://reuters.com/markets/meta)');
			expect(message).toContain('[CNBC Tech News](https://cnbc.com/tech/meta)');

			// Verify no raw URLs are shown without markdown link format
			expect(message).not.toContain('https://bloomberg.com/meta-stock |');
			expect(message).not.toContain('| https://reuters.com/markets/meta');

			// Verify proper formatting
			expect(message).toContain('Sources:');
			expect(message).toContain(' | ');

			console.log('Formatted message:\n', message);
		});

		it('should handle backward compatibility with plain URLs', () => {
			const analysis = {
				event_category: 'regulatory',
				headline: 'Regulatory announcement',
				sentiment_score: 0.0,
				confidence: 0.6,
				sources: [
					'https://example.com/source1',
					'https://example.com/source2',
				],
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Should handle plain URLs gracefully
			expect(message).toContain('https://example.com/source1');
			expect(message).toContain('https://example.com/source2');
		});

		it('should limit displayed sources to 3', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Big move',
				sentiment_score: 0.5,
				confidence: 0.7,
				sources: [
					{ title: 'Source 1', url: 'https://example.com/1' },
					{ title: 'Source 2', url: 'https://example.com/2' },
					{ title: 'Source 3', url: 'https://example.com/3' },
					{ title: 'Source 4', url: 'https://example.com/4' },
					{ title: 'Source 5', url: 'https://example.com/5' },
				],
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Verify only first 3 sources are shown (note: numbers are escaped for MarkdownV2)
			expect(message).toContain('[Source \\1]');
			expect(message).toContain('[Source \\2]');
			expect(message).toContain('[Source \\3]');
			expect(message).not.toContain('[Source \\4]');
			expect(message).not.toContain('[Source \\5]');
		});

		it('should format complete alert message with all components', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Major bullish news drives market surge',
				sentiment_score: 0.85,
				confidence: 0.9,
				sources: [
					{
						title: 'Financial Times',
						url: 'https://ft.com/markets/article',
					},
				],
			};

			const marketContext = {
				price: 150.75,
				change24h: 8.5,
			};

			const message = analyzer.formatAlertMessage('AAPL', analysis, marketContext);

			// Verify all components are present
			expect(message).toContain('*AAPL Alert*');
			expect(message).toContain('Event: Major bullish news drives market surge');
			expect(message).toContain('Sentiment: Bullish 🚀 (0.85)');
			expect(message).toContain('Confidence: 90%');
			expect(message).toContain('Price: $150.75 (+8.5%)');
			expect(message).toContain('[Financial Times](https://ft.com/markets/article)');
		});

		it('should handle missing sources gracefully', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Price move detected',
				sentiment_score: 0.6,
				confidence: 0.7,
				sources: [], // Empty array
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Should not have Sources line if empty
			expect(message).not.toContain('Sources:');
		});

		it('should handle undefined sources gracefully', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Price move detected',
				sentiment_score: 0.6,
				confidence: 0.7,
				// No sources property
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Should not error and should not have Sources line
			expect(message).toBeTruthy();
			expect(message).not.toContain('Sources:');
		});

		it('should escape special characters in source titles for MarkdownV2', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Important news',
				sentiment_score: 0.5,
				confidence: 0.7,
				sources: [
					{
						title: 'Market News (Updated)',
						url: 'https://example.com/news',
					},
				],
			};

			const message = analyzer.formatAlertMessage('TEST', analysis, null);

			// Title should have special characters escaped for MarkdownV2
			expect(message).toContain('Market News \\(Updated\\)');
			expect(message).toContain('https://example.com/news');
		});

		it('should include Horizonte and Invalidación lines when time_horizon and invalidation_hint are present', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'BTC breaks major resistance',
				sentiment_score: 0.75,
				confidence: 0.85,
				time_horizon: 'short_term',
				invalidation_hint: 'Reversal below 80,000 support',
			};

			const message = analyzer.formatAlertMessage('BTCUSDT', analysis, { price: 83500 });
			expect(message).toContain('Horizonte: Corto plazo');
			expect(message).toContain('Invalidación: Reversal below 80,000 support');
		});

		it('should omit Horizonte and Invalidación lines when empty or absent', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'BTC breaks major resistance',
				sentiment_score: 0.75,
				confidence: 0.85,
				time_horizon: '',
				invalidation_hint: '',
			};

			const message = analyzer.formatAlertMessage('BTCUSDT', analysis, null);
			expect(message).not.toContain('Horizonte:');
			expect(message).not.toContain('Invalidación:');
		});
	});

	describe('WhatsApp and MarkdownV2 news alert formatting with invalidation and horizon', () => {
		const WhatsAppMarkdownFormatter = require('../../src/services/notification/formatters/whatsappMarkdownFormatter');
		const whatsappFormatter = new WhatsAppMarkdownFormatter();

		it('should render Horizonte and Invalidación in MarkdownV2Formatter when provided in enriched summary or fields', () => {
			const enrichedAlert = {
				originalText: 'BTCUSDT: Big surge',
				summary: '*Sentiment:* Bullish 🚀 (0.80)\n*Price:* $85000\n*Horizonte:* Corto plazo\n*Invalidación:* Reversal below $82,000',
				citations: [],
			};

			const formatted = formatter.formatEnriched(enrichedAlert);
			expect(formatted).toContain('*Horizonte:* Corto plazo');
			expect(formatted).toContain('*Invalidación:* Reversal below $82,000');
		});

		it('should render Horizonte and Invalidación in WhatsAppMarkdownFormatter when provided', async () => {
			const enrichedAlert = {
				originalText: 'BTCUSDT: Big surge',
				summary: '*Sentiment:* Bullish 🚀 (0.80)\n*Price:* $85000\n*Horizonte:* Corto plazo\n*Invalidación:* Reversal below $82,000',
				citations: [],
			};

			const formatted = await whatsappFormatter.formatEnriched(enrichedAlert);
			expect(formatted).toContain('*Horizonte:* Corto plazo');
			expect(formatted).toContain('*Invalidación:* Reversal below $82,000');
		});

		it('should render Entry, Invalidation, Target, and Risk/Reward in webhook alert for MarkdownV2Formatter', () => {
			const enrichedAlert = {
				original_text: 'BTCUSDT(60) pasó a señal de COMPRA',
				sentiment: 'BULLISH',
				sentiment_score: 0.75,
				insights: ['Breakout confirmation'],
				current_price: 85200.5,
				setup_type: 'breakout',
				invalidation_level: 83070.49,
				target_level: 89460.52,
				risk_reward_ratio: 2,
			};

			const formatted = formatter.formatWebhookAlert(enrichedAlert);
			expect(formatted).toContain('*Risk Parameters*');
			expect(formatted).toContain('Setup: breakout');
			expect(formatted).toContain('Entry: 85200\\.5');
			expect(formatted).toContain('Invalidation: 83070\\.49');
			expect(formatted).toContain('Target: 89460\\.52');
			expect(formatted).toContain('Risk/Reward: 2');
		});

		it('should render Entry, Invalidation, Target, and Risk/Reward in webhook alert for WhatsAppMarkdownFormatter', async () => {
			const enrichedAlert = {
				original_text: 'BTCUSDT(60) pasó a señal de COMPRA',
				sentiment: 'BULLISH',
				sentiment_score: 0.75,
				insights: ['Breakout confirmation'],
				current_price: 85200.5,
				setup_type: 'breakout',
				invalidation_level: 83070.49,
				target_level: 89460.52,
				risk_reward_ratio: 2,
			};

			const formatted = await whatsappFormatter.formatWebhookAlert(enrichedAlert);
			expect(formatted).toContain('*Risk Parameters*');
			expect(formatted).toContain('Setup: breakout');
			expect(formatted).toContain('Entry: 85200.5');
			expect(formatted).toContain('Invalidation: 83070.49');
			expect(formatted).toContain('Target: 89460.52');
			expect(formatted).toContain('Risk/Reward: 2');
		});
	});
});

