/* global jest, describe, it, beforeEach, expect */

jest.mock('../../src/controllers/webhooks/handlers/alert/grounding', () => ({
	enrichAlert: jest.fn().mockResolvedValue(null),
	ENRICHMENT_PROVIDER_OUTCOMES: Symbol.for('cabros-bot.alert.enrichment-provider-outcomes'),
}));

jest.mock('../../src/lib/validation', () => ({
	validateAlert: jest.fn((text) => ({ text })),
}));

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(() => false),
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
const NotificationManager = require('../../src/services/notification/NotificationManager');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
const sentryService = require('../../src/services/monitoring/SentryService');
const { enrichAlert, ENRICHMENT_PROVIDER_OUTCOMES } = require('../../src/controllers/webhooks/handlers/alert/grounding');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const {
	postAlert,
	resolveRequestId,
	initializeNotificationServices,
	resetNotificationManagerForTesting,
	getCooldownChannelIdentity,
} = require('../../src/controllers/webhooks/handlers/alert/alert');
const { signalRepeatCooldown } = require('../../src/services/alerts/signalRepeatCooldown');
const { parseTradingViewSignal } = require('../../src/services/tradingview/parseTradingViewSignal');

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
		delete process.env.ENABLE_ALERT_DECISION_AUDIT;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		remoteConfigService._resetForTesting();
		jest.clearAllMocks();
		alertStorageService.isEnabled.mockReturnValue(false);
		resetNotificationManagerForTesting();
		signalRepeatCooldown.reset();
	});

	describe('signal outcome price provenance', () => {
		it('normalizes derived quote provenance for MCP prices before recording outcomes', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			enrichAlert.mockResolvedValue({
				current_price: 64863.03,
				levelsSource: 'derived-quote',
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'partial',
			});
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.recordSignal.mockResolvedValue(null);

			const response = buildResponse();
			await postAlert({})({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(signalOutcomeService.recordSignal).toHaveBeenCalledWith(expect.objectContaining({
				priceSource: 'tradingview-mcp',
			}));
		});

		it('forwards invalidation_level, target_level, setup_type, and risk_reward_ratio from alert.enriched to recordSignal (GH-832)', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			enrichAlert.mockResolvedValue({
				current_price: 65000,
				invalidation_level: 63000,
				target_level: 68000,
				setup_type: 'breakout',
				risk_reward_ratio: 2.5,
				tradingViewEnrichmentApplied: true,
			});
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.recordSignal.mockResolvedValue(null);

			const response = buildResponse();
			await postAlert({})({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(signalOutcomeService.recordSignal).toHaveBeenCalledWith(expect.objectContaining({
				invalidationLevel: 63000,
				targetLevel: 68000,
				stop: 63000,
				target: 68000,
				setupType: 'breakout',
				riskRewardRatio: 2.5,
			}));
		});

		it('normalizes derived quote provenance for Binance fallback prices', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			enrichAlert.mockResolvedValue({
				current_price: 64863.03,
				levelsSource: 'derived-quote',
				tradingViewEnrichmentApplied: false,
				tradingViewEnrichmentStatus: 'failed',
			});
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.recordSignal.mockResolvedValue(null);

			const response = buildResponse();
			await postAlert({})({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(signalOutcomeService.recordSignal).toHaveBeenCalledWith(expect.objectContaining({
				priceSource: 'binance',
			}));
		});

		it('normalizes derived quote provenance for Twelve Data fallback prices', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			enrichAlert.mockResolvedValue({
				current_price: 230.5,
				levelsSource: 'derived-quote',
				tradingViewEnrichmentApplied: false,
				tradingViewEnrichmentStatus: 'failed',
			});
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.recordSignal.mockResolvedValue(null);

			const response = buildResponse();
			await postAlert({})({
				headers: {},
				body: { text: 'NASDAQ:AAPL (1h) BUY' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(signalOutcomeService.recordSignal).toHaveBeenCalledWith(expect.objectContaining({
				priceSource: 'twelve-data',
			}));
		});
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
		it('echoes truncation metadata when validation clips alert text', async () => {
			const response = buildResponse();
			const { validateAlert } = require('../../src/lib/validation');
			validateAlert.mockImplementationOnce(() => ({
				text: `${'A'.repeat(4000)}...`,
				metadata: null,
				truncated: true,
				originalLength: 4001,
				deliveredLength: 4003,
			}));

			const handler = postAlert({});

			await handler({
				headers: { 'x-request-id': 'truncated-alert-1' },
				body: { text: 'A'.repeat(4001) },
				query: { dryRun: 'true' },
			}, response);

			expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
				truncated: true,
				originalLength: 4001,
				deliveredLength: 4003,
			}));
		});

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

		it('reuses requestId assigned by request middleware', async () => {
			const response = buildResponse();
			const handler = postAlert({});

			await handler({
				headers: {},
				requestId: 'middleware-request-42',
				body: { text: 'BINANCE:BTCUSDT' },
				query: {},
			}, response);

			expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
				requestId: 'middleware-request-42',
			}));
			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				requestId: 'middleware-request-42',
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

		it('does not persist dry-run alerts when decision audit is disabled', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'false';
			alertStorageService.isEnabled.mockReturnValue(true);
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: { dryRun: 'true' },
			}, response);

			expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
			expect(alertStorageService.saveAlert).not.toHaveBeenCalled();
		});

		it('persists effective broadcast channels in an opted-in dry-run audit', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			await initializeNotificationServices({});
			const response = buildResponse();

			await postAlert({})({
				headers: { 'x-request-id': 'dryrun-audit-42' },
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: { dryRun: 'true' },
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				requestId: 'dryrun-audit-42',
				channels: ['telegram'],
				decision: expect.objectContaining({
					gates: [expect.objectContaining({ name: 'dryRun', decision: 'skip' })],
					dispatch: {
						requestedChannels: ['telegram'],
						requestedChannelMode: 'broadcast',
						sentTo: [],
					},
				}),
			}));
			expect(enrichAlert).not.toHaveBeenCalled();
		});

		it('records explicit request-level channel mode in the audit', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text: 'BTC alert', channels: ['telegram'] },
				query: {},
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				decision: expect.objectContaining({
					dispatch: expect.objectContaining({
						requestedChannels: ['telegram'],
						requestedChannelMode: 'explicit',
					}),
				}),
			}));
		});

		it('does not record a TradingView attempt for non-signal text', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text: 'A broad market update without a TradingView signal.' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				decision: expect.objectContaining({
					enrichment: {
						attempted: false,
						provider: null,
						status: 'not_applicable',
						fallbackUsed: false,
					},
				}),
			}));
			expect(enrichAlert).not.toHaveBeenCalled();
		});

		it('records Gemini success when TradingView is enabled but no signal is present', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			enrichAlert.mockResolvedValueOnce({ sentiment: 'NEUTRAL', sources: [], truncated: false });
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text: 'A broad market update without a TradingView signal.' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				decision: expect.objectContaining({
					enrichment: {
						attempted: true,
						provider: 'gemini-grounding',
						status: 'success',
						fallbackUsed: false,
					},
				}),
			}));
		});

		it('records symbol-route dispatch mode when a configured symbol route matches', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: {
					text: 'BINANCE:BTCUSDT breakout confirmed',
					symbolRoutes: { BTCUSDT: { channels: ['telegram'] } },
				},
				query: {},
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				decision: expect.objectContaining({
					dispatch: expect.objectContaining({
						requestedChannels: ['telegram'],
						requestedChannelMode: 'symbol_route',
					}),
				}),
			}));
		});

		it('records a failed provider attempt even when enrichment returns no result', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			enrichAlert.mockRejectedValueOnce(new Error('provider timeout'));
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: {},
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				decision: expect.objectContaining({
					enrichment: expect.objectContaining({
						attempted: true,
						provider: 'gemini-grounding',
						status: 'failed',
						fallbackUsed: true,
					}),
				}),
			}));
		});

		it('records provider-specific partial failure when Gemini falls back to TradingView MCP', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			const enriched = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
			};
			Object.defineProperty(enriched, ENRICHMENT_PROVIDER_OUTCOMES, {
				value: {
					gemini: { status: 'failed' },
					tradingViewMcp: { status: 'full' },
				},
			});
			enrichAlert.mockResolvedValueOnce(enriched);
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				decision: expect.objectContaining({
					enrichment: {
						attempted: true,
						provider: 'gemini-grounding+tradingview-mcp',
						status: 'partial',
						fallbackUsed: true,
						providers: {
							gemini: { status: 'failed' },
							tradingViewMcp: { status: 'full' },
						},
					},
				}),
			}));
		});

		it('records both failed provider outcomes when enrichment throws without a fallback', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			alertStorageService.isEnabled.mockReturnValue(true);
			const error = new Error('providers unavailable');
			Object.defineProperty(error, ENRICHMENT_PROVIDER_OUTCOMES, {
				value: {
					gemini: { status: 'failed' },
					tradingViewMcp: { status: 'failed' },
				},
			});
			enrichAlert.mockRejectedValueOnce(error);
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text: 'BINANCE:BTCUSDT (1h) BUY' },
				query: { useTradingViewData: 'true' },
			}, response);

			expect(alertStorageService.saveAlert).toHaveBeenCalledWith(expect.objectContaining({
				decision: expect.objectContaining({
					enrichment: {
						attempted: true,
						provider: 'gemini-grounding+tradingview-mcp',
						status: 'failed',
						fallbackUsed: true,
						providers: {
							gemini: { status: 'failed' },
							tradingViewMcp: { status: 'failed' },
						},
					},
				}),
			}));
		});

		it('records a partial same-signal cooldown when one destination remains allowed', async () => {
			const text = 'BINANCE:BTCUSDT (1h) BUY';
			const parsedSignal = parseTradingViewSignal(text);
			const routing = {};
			const telegramIdentity = getCooldownChannelIdentity('telegram', routing);
			signalRepeatCooldown.reserve(parsedSignal, [telegramIdentity], Date.now());
			process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			process.env.ENABLE_TELEGRAM_BOT = 'false';
			alertStorageService.isEnabled.mockReturnValue(true);
			NotificationManager.mockImplementationOnce(() => ({
				validateAll: jest.fn().mockResolvedValue([]),
				getEnabledChannels: jest.fn(() => ['telegram', 'whatsapp']),
				sendToChannels: jest.fn().mockImplementation(async (_alert, channels) => (
					channels.map((channel) => ({ channel, success: true }))
				)),
				isIntentionalApiOnly: jest.fn(() => false),
			}));
			const response = buildResponse();

			await postAlert({})({
				headers: {},
				body: { text, channels: ['telegram', 'whatsapp'] },
				query: {},
			}, response);

			const saveArgs = alertStorageService.saveAlert.mock.calls[0][0];
			const gate = saveArgs.decision.gates.find((entry) => entry.name === 'same-signal-cooldown');
			expect(gate).toMatchObject({ decision: 'suppress', reason: 'channel_cooldown' });
			expect(gate.evidence).toEqual({
				requestedChannels: 'telegram,whatsapp',
				allowedChannels: 'whatsapp',
				suppressedChannels: 'telegram',
			});
			expect(saveArgs.decision.dispatch.sentTo).toEqual(['whatsapp']);
			resetNotificationManagerForTesting();
			signalRepeatCooldown.reset();
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
				priceSource: 'gemini-grounding',
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

		it('preserves a derived-quote price when TradingView MCP fails', async () => {
			process.env.ENABLE_GEMINI_GROUNDING = 'true';
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			setupOutcomeEnabled();
			setupEnrichment({
				sentiment: 'BULLISH',
				current_price: 3250,
				levelsSource: 'derived-quote',
				tradingViewEnrichmentStatus: 'failed',
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
				priceSource: 'binance',
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
