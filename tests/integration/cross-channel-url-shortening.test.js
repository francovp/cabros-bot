/* global jest, describe, it, expect, beforeEach, afterEach */

const WhatsAppService = require('../../src/services/notification/WhatsAppService');
const DiscordService = require('../../src/services/notification/DiscordService');
const WhatsAppMarkdownFormatter = require('../../src/services/notification/formatters/whatsappMarkdownFormatter');

describe('Cross-Channel URL Shortening Parity (WhatsApp & Discord)', () => {
	let mockUrlShortener;
	let originalFetch;
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		originalFetch = global.fetch;

		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.ENABLE_DISCORD_ALERTS = 'true';
		process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123/token';
		process.env.GREEN_API_INSTANCE_ID = '1101234567';
		process.env.GREEN_API_API_TOKEN_INSTANCE = 'mock-greenapi-token';
		process.env.TELEGRAM_CHAT_ID = '120363xxxxxx@g.us';

		mockUrlShortener = {
			shortenUrlsParallel: jest.fn(),
		};
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		global.fetch = originalFetch;
		jest.restoreAllMocks();
	});

	it('produces identical source citations with shortened URLs across WhatsApp and Discord formatters', async () => {
		mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
			'https://tradingview.com/symbols/BTCUSDT': 'https://picsee.io/btc',
			'https://binance.com/trade/BTC_USDT': 'https://picsee.io/bin',
		});

		const waFormatter = new WhatsAppMarkdownFormatter({
			logger: console,
			urlShortener: mockUrlShortener,
		});
		const discordService = new DiscordService({
			logger: console,
			urlShortener: mockUrlShortener,
		});

		const enrichedAlert = {
			original_text: 'BTC breakout above $65,000',
			summary: 'Strong bullish continuation',
			sources: [
				{ title: 'TradingView Chart', url: 'https://tradingview.com/symbols/BTCUSDT' },
				{ title: 'Binance Spot', url: 'https://binance.com/trade/BTC_USDT' },
			],
		};

		const waFormatted = await waFormatter.formatEnriched(enrichedAlert);
		const discordFormatted = await discordService.formatAlert({ enriched: enrichedAlert });

		expect(discordFormatted).toBe(waFormatted);
		expect(discordFormatted).toContain('https://picsee.io/btc');
		expect(discordFormatted).toContain('https://picsee.io/bin');
		expect(discordFormatted).not.toContain('https://tradingview.com/symbols/BTCUSDT');
		expect(discordFormatted).not.toContain('https://binance.com/trade/BTC_USDT');
	});

	it('maintains cross-channel consistency when URL shortening fails (graceful fallback)', async () => {
		mockUrlShortener.shortenUrlsParallel.mockRejectedValue(new Error('Network timeout'));

		const waFormatter = new WhatsAppMarkdownFormatter({
			logger: console,
			urlShortener: mockUrlShortener,
		});
		const discordService = new DiscordService({
			logger: console,
			urlShortener: mockUrlShortener,
		});

		const enrichedAlert = {
			original_text: 'ETH breakdown below $3,000',
			summary: 'Bearish momentum confirmed',
			sources: [
				{ title: 'TradingView ETH', url: 'https://tradingview.com/symbols/ETHUSDT' },
			],
		};

		const waFormatted = await waFormatter.formatEnriched(enrichedAlert);
		const discordFormatted = await discordService.formatAlert({ enriched: enrichedAlert });

		expect(discordFormatted).toBe(waFormatted);
		expect(discordFormatted).toContain('https://tradingview.com/symbols/ETHUSDT');
	});

	it('delivers consistent shortened URL payloads through both WhatsAppService and DiscordService send()', async () => {
		mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
			'https://tradingview.com/symbols/SOLUSDT': 'https://picsee.io/sol',
		});

		const fetchCalls = [];
		global.fetch = jest.fn().mockImplementation(async (url, options) => {
			fetchCalls.push({ url, options });
			if (options?.method === 'GET') {
				// Discord probe
				return {
					ok: true,
					status: 200,
					json: async () => ({ id: 'probe' }),
					text: async () => JSON.stringify({ id: 'probe' }),
				};
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ id: 'msg-success', idMessage: 'greenapi-msg-1' }),
				text: async () => JSON.stringify({ id: 'msg-success', idMessage: 'greenapi-msg-1' }),
			};
		});

		const waService = new WhatsAppService({
			apiUrl: 'https://api.green-api.com',
			idInstance: '1101234567',
			apiTokenInstance: 'mock-greenapi-token',
			chatId: '120363xxxxxx@g.us',
			logger: console,
			urlShortener: mockUrlShortener,
		});
		await waService.validate();

		const discordService = new DiscordService({
			logger: console,
			urlShortener: mockUrlShortener,
		});
		await discordService.validate();

		const alert = {
			text: 'SOL pump',
			enriched: {
				original_text: 'SOL pump',
				sources: [
					{ title: 'Solana Chart', url: 'https://tradingview.com/symbols/SOLUSDT' },
				],
			},
		};

		const [waResult, discordResult] = await Promise.all([
			waService.send(alert),
			discordService.send(alert),
		]);

		expect(waResult.success).toBe(true);
		expect(discordResult.success).toBe(true);

		// Extract outgoing messages
		const waCall = fetchCalls.find((call) => call.url.includes('green-api.com'));
		const discordCall = fetchCalls.find((call) => call.url.includes('discord.com') && call.options.method === 'POST');

		expect(waCall).toBeDefined();
		expect(discordCall).toBeDefined();

		const waPayload = JSON.parse(waCall.options.body);
		const discordPayload = JSON.parse(discordCall.options.body);

		expect(waPayload.message).toContain('https://picsee.io/sol');
		expect(discordPayload.content).toContain('https://picsee.io/sol');

		// Compare sources block structure between WhatsApp and Discord
		const waSourcesBlock = waPayload.message.slice(waPayload.message.indexOf('*Sources*'));
		const discordSourcesBlock = discordPayload.content.slice(discordPayload.content.indexOf('*Sources*'));

		expect(discordSourcesBlock).toBe(waSourcesBlock);
	});
});
