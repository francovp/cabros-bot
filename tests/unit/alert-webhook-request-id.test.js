/* global jest, describe, it, beforeEach, expect */

jest.mock('../../src/controllers/webhooks/handlers/alert/grounding', () => ({
	enrichAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/lib/validation', () => ({
	validateAlert: jest.fn((text) => ({ text })),
}));

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	extractSymbolAndExchange: jest.fn(() => ({ symbol: 'BTCUSDT', exchange: 'BINANCE' })),
	saveAlert: jest.fn().mockResolvedValue('alert-id'),
}));

jest.mock('../../src/services/notification/NotificationManager', () => jest.fn().mockImplementation(() => ({
	validateAll: jest.fn().mockResolvedValue([]),
	getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
	sendToAll: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]),
	sendToChannels: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]),
})));

jest.mock('../../src/services/notification/TelegramService', () => jest.fn());
jest.mock('../../src/services/notification/WhatsAppService', () => jest.fn());
jest.mock('../../src/services/notification/DiscordService', () => jest.fn());
jest.mock('../../src/services/monitoring/SentryService', () => ({
	getActiveSpan: jest.fn(() => null),
	captureRuntimeError: jest.fn(),
	startInactiveSpan: jest.fn(() => ({ finish: jest.fn(), setAttribute: jest.fn() })),
	endSpan: jest.fn(),
}));
jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(() => false),
	recordSignal: jest.fn(),
}));

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const sentryService = require('../../src/services/monitoring/SentryService');
const { postAlert, resolveRequestId } = require('../../src/controllers/webhooks/handlers/alert/alert');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildResponse() {
	const response = {
		json: jest.fn(),
		status: jest.fn(),
		send: jest.fn(),
	};
	response.status.mockReturnValue(response);
	response.json.mockReturnValue(response);
	response.send.mockReturnValue(response);
	return response;
}

describe('alert request ID resolution and echo', () => {
	beforeEach(() => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
		process.env.ENABLE_TELEGRAM_BOT = 'false';
		process.env.ENABLE_WHATSAPP_ALERTS = 'false';
		process.env.ENABLE_DISCORD_ALERTS = 'false';
		jest.clearAllMocks();
	});

	describe('resolveRequestId helper', () => {
		it('returns sanitized x-request-id header when valid', () => {
			const req = { headers: { 'x-request-id': 'custom-req-12345' } };
			expect(resolveRequestId(req)).toBe('custom-req-12345');
		});

		it('trims whitespace around x-request-id', () => {
			const req = { headers: { 'x-request-id': '  alert-correlation-99  ' } };
			expect(resolveRequestId(req)).toBe('alert-correlation-99');
		});

		it('generates a valid UUID v4 when header is missing', () => {
			const req = { headers: {} };
			const requestId = resolveRequestId(req);
			expect(requestId).toMatch(UUID_REGEX);
		});

		it('falls back to UUID v4 when header is empty or whitespace only', () => {
			const req = { headers: { 'x-request-id': '   ' } };
			const requestId = resolveRequestId(req);
			expect(requestId).toMatch(UUID_REGEX);
		});

		it('falls back to UUID v4 when header contains non-printable characters', () => {
			const req = { headers: { 'x-request-id': 'bad\nid\rwith\x00null' } };
			const requestId = resolveRequestId(req);
			expect(requestId).toMatch(UUID_REGEX);
		});

		it('falls back to UUID v4 when header exceeds 128 characters', () => {
			const req = { headers: { 'x-request-id': 'a'.repeat(129) } };
			const requestId = resolveRequestId(req);
			expect(requestId).toMatch(UUID_REGEX);
		});
	});

	describe('postAlert handler requestId propagation', () => {
		it('echoes inbound valid x-request-id in success response and persists it to storage', async () => {
			const response = buildResponse();
			const handler = postAlert({});

			await handler({
				headers: { 'x-request-id': 'tv-alert-sync-42' },
				body: { text: 'BINANCE:BTCUSDT' },
				query: {},
			}, response);

			expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
				success: true,
				requestId: 'tv-alert-sync-42',
			}));
			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				requestId: 'tv-alert-sync-42',
			}));
		});

		it('generates UUID requestId when header omitted, echoes it, and persists to storage', async () => {
			const response = buildResponse();
			const handler = postAlert({});

			await handler({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT' },
				query: {},
			}, response);

			const jsonCall = response.json.mock.calls[0][0];
			expect(jsonCall.success).toBe(true);
			expect(jsonCall.requestId).toMatch(UUID_REGEX);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				requestId: jsonCall.requestId,
			}));
		});

		it('includes requestId in dry-run response', async () => {
			const response = buildResponse();
			const handler = postAlert({});

			await handler({
				headers: { 'x-request-id': 'dryrun-id-101' },
				body: { text: 'BINANCE:ETHUSDT' },
				query: { dryRun: 'true' },
			}, response);

			expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
				success: true,
				dryRun: true,
				requestId: 'dryrun-id-101',
			}));
		});

		it('includes requestId in Sentry error capture context on unexpected error', async () => {
			const response = buildResponse();
			const { validateAlert } = require('../../src/lib/validation');
			validateAlert.mockImplementationOnce(() => {
				throw new Error('Validation explosion');
			});

			const handler = postAlert({});

			await handler({
				headers: { 'x-request-id': 'err-trace-777' },
				body: { text: 'BINANCE:BTCUSDT' },
				query: {},
			}, response);

			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
				http: expect.objectContaining({
					endpoint: '/api/webhook/alert',
					method: 'POST',
					requestId: 'err-trace-777',
				}),
			}));
		});
	});

	describe('GH-599 Gemini-grounding entry-price fallback for recordSignal', () => {
		const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
		const { enrichAlert } = require('../../src/controllers/webhooks/handlers/alert/grounding');

		function setupOutcomeEnabled() {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.recordSignal.mockClear();
		}

		function setupEnrichment(enrichmentPayload) {
			enrichAlert.mockResolvedValue(enrichmentPayload);
		}

		it('records a gemini-grounding-sourced entry price when MCP is absent', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
			setupOutcomeEnabled();
			setupEnrichment({
				sentiment: 'BULLISH',
				sentiment_score: 0.7,
				current_price: 85000,
				invalidation_level: 83000,
				target_level: 89000,
				sources: [],
				truncated: false,
			});

			const response = buildResponse();
			const handler = postAlert({});
			await handler({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT(240) pasó a señal de COMPRA' },
				query: {},
			}, response);

			expect(signalOutcomeService.recordSignal).toHaveBeenCalledWith(expect.objectContaining({
				price: 85000,
				priceSource: 'gemini-grounding',
				side: 'BUY',
			}));
		});

		it('prefers the TradingView-MCP price over the gemini-grounding fallback', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			setupOutcomeEnabled();
			setupEnrichment({
				sentiment: 'BULLISH',
				sentiment_score: 0.6,
				price_data: { current_price: 3250 },
				tradingViewEnrichmentStatus: 'full',
				sources: [],
				truncated: false,
			});

			const response = buildResponse();
			const handler = postAlert({});
			await handler({
				headers: {},
				body: { text: 'BINANCE:ETHUSDT(60) pasó a señal de COMPRA' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(signalOutcomeService.recordSignal).toHaveBeenCalledWith(expect.objectContaining({
				price: 3250,
				priceSource: 'tradingview-mcp',
			}));
		});

		it('passes side to saveAlert so deterministic R:R can be computed', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
			setupOutcomeEnabled();
			setupEnrichment({
				sentiment: 'BULLISH',
				sentiment_score: 0.6,
				sources: [],
				truncated: false,
			});

			const response = buildResponse();
			const handler = postAlert({});
			await handler({
				headers: {},
				body: { text: 'BINANCE:ETHUSDT(60) pasó a señal de COMPRA' },
				query: {},
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				side: 'BUY',
			}));
		});
	});
});
