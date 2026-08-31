'use strict';

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callScanTool: jest.fn(),
	},
}));

const admin = require('firebase-admin');
const { generateKeyPairSync } = require('crypto');
const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { _resetForTesting: resetScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');

const testPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});
const validFirestoreServiceAccountJson = JSON.stringify({
	project_id: 'scanner-preset-test',
	client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
	private_key: testPrivateKey,
});

describe('Scanner presets API integration tests', () => {
	let savedEnv;
	let mockBot;
	let mockTelegramSendMessage;
	let mockFetch;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'true',
			ENABLE_MARKET_SCANNER: 'true',
			ENABLE_NEWS_MONITOR: 'false',
			MARKET_SCANNER_TIMEOUT_MS: '1000',
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '4h',
			FIREBASE_SERVICE_ACCOUNT_JSON: validFirestoreServiceAccountJson,
			ENABLE_TELEGRAM_BOT: 'true',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_WHATSAPP_ALERTS: 'false',
		});

		jest.clearAllMocks();
		admin.__resetCollectionState();
		resetScannerPresetService();
		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'preset-msg-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};
		mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ idMessage: 'wa-msg-456' }),
		});
		global.fetch = mockFetch;

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		delete global.fetch;
	});

	it('creates, updates, lists, retrieves, and deletes saved presets', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Momentum preset',
				exchange: 'binance',
				timeframe: '1h',
				scans: ['top_gainers'],
				limit: 3,
				bbwThreshold: 0.08,
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		expect(createResponse.body).toEqual(expect.objectContaining({
			success: true,
			storage: expect.objectContaining({
				mode: 'durable',
				backend: 'firestore',
			}),
			preset: expect.objectContaining({
				id: presetId,
				name: 'Momentum preset',
				exchange: 'BINANCE',
				timeframe: '1h',
				scans: ['top_gainers'],
				limit: 3,
				bbwThreshold: 0.08,
			}),
		}));

		const listResponse = await request(app)
			.get('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(listResponse.body.presets).toHaveLength(1);
		expect(listResponse.body.presets[0]).toEqual(expect.objectContaining({
			id: presetId,
			name: 'Momentum preset',
		}));

		const updateResponse = await request(app)
			.put(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.send({ limit: 7 })
			.expect(200);

		expect(updateResponse.body.preset).toEqual(expect.objectContaining({
			id: presetId,
			limit: 7,
		}));

		const getResponse = await request(app)
			.get(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(getResponse.body.preset).toEqual(expect.objectContaining({
			id: presetId,
			limit: 7,
		}));

		await request(app)
			.delete(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		await request(app)
			.get(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.expect(404);
	});

	it('includes storage metadata on not-found responses', async () => {
		const missingId = 'missing-preset-id';
		const expectedStorage = expect.objectContaining({
			enabled: true,
			mode: 'durable',
			backend: 'firestore',
		});

		const getResponse = await request(app)
			.get(`/api/scanner-presets/${missingId}`)
			.set('x-api-key', 'test-key')
			.expect(404);
		const updateResponse = await request(app)
			.put(`/api/scanner-presets/${missingId}`)
			.set('x-api-key', 'test-key')
			.send({ name: 'Missing update' })
			.expect(404);
		const deleteResponse = await request(app)
			.delete(`/api/scanner-presets/${missingId}`)
			.set('x-api-key', 'test-key')
			.expect(404);

		expect(getResponse.body.storage).toEqual(expectedStorage);
		expect(updateResponse.body.storage).toEqual(expectedStorage);
		expect(deleteResponse.body.storage).toEqual(expectedStorage);
	});

	it('reports ephemeral storage when durable scanner persistence is enabled but unavailable', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
		const firestoreAdmin = require('firebase-admin');
		firestoreAdmin.__mockDocSet.mockRejectedValueOnce(new Error('Firestore unavailable'));

		const response = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({ name: 'Ephemeral preset' })
			.expect(201);

		expect(response.body.storage).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('returns structured preview in dry-run mode without calling MCP or delivery services', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Dry run preset',
				exchange: 'binance',
				timeframe: '4h',
				scans: ['top_gainers'],
				limit: 5,
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const runResponse = await request(app)
			.post(`/api/scanner-presets/${presetId}/run?dryRun=true`)
			.set('x-api-key', 'test-key')
			.set('idempotency-key', 'preset-dry-key-123')
			.expect(200);

		expect(runResponse.body).toEqual(expect.objectContaining({
			success: true,
			dryRun: true,
			presetId,
			preset: expect.objectContaining({
				id: presetId,
				name: 'Dry run preset',
				exchange: 'BINANCE',
				timeframe: '4h',
				scans: ['top_gainers'],
				limit: 5,
			}),
			validation: {
				ok: true,
				errors: [],
			},
			estimatedCalls: {
				coinAnalysis: 1,
				multiTimeframe: 0,
			},
			requestedChannels: expect.any(Array),
			mcpReadiness: expect.objectContaining({
				ready: expect.any(Boolean),
			}),
			idempotencyKey: 'preset-dry-key-123',
			requestId: expect.any(String),
		}));

		expect(tradingViewMcpService.callScanTool).not.toHaveBeenCalled();
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('returns validation errors with 200 OK when dry-run preset configuration has invalid settings', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Valid preset initially',
				exchange: 'binance',
				timeframe: '4h',
				scans: ['top_gainers'],
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const runResponse = await request(app)
			.post(`/api/scanner-presets/${presetId}/run`)
			.set('x-api-key', 'test-key')
			.send({
				dryRun: true,
				scans: ['invalid_scan_tool'],
				timeframe: 'invalid_timeframe',
			})
			.expect(200);

		expect(runResponse.body).toEqual(expect.objectContaining({
			success: true,
			dryRun: true,
			presetId,
			validation: {
				ok: false,
				errors: expect.arrayContaining([
					expect.stringContaining('Unsupported scan types'),
					expect.stringContaining('Unsupported timeframe'),
				]),
			},
		}));

		expect(tradingViewMcpService.callScanTool).not.toHaveBeenCalled();
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('estimates multiTimeframe calls when includeMultiTimeframe is enabled', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Multi-timeframe preset',
				exchange: 'binance',
				timeframe: '1h',
				scans: ['top_gainers', 'top_losers'],
				limit: 10,
				includeMultiTimeframe: true,
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const runResponse = await request(app)
			.post(`/api/scanner-presets/${presetId}/run?dryRun=true`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(runResponse.body.estimatedCalls).toEqual({
			coinAnalysis: 2,
			multiTimeframe: 20,
		});
		expect(runResponse.body.preset.includeMultiTimeframe).toBe(true);
		expect(tradingViewMcpService.callScanTool).not.toHaveBeenCalled();
	});

	it('resolves requested channels and chat overrides in dry-run mode', async () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'test-bot-token';
		process.env.TELEGRAM_CHAT_ID = '123456789';

		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Channel override preset',
				exchange: 'binance',
				timeframe: '4h',
				scans: ['top_gainers'],
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const runResponse = await request(app)
			.post(`/api/scanner-presets/${presetId}/run`)
			.set('x-api-key', 'test-key')
			.send({
				dryRun: true,
				channels: ['telegram'],
				telegramChatId: '-100999888777',
			})
			.expect(200);

		expect(runResponse.body.requestedChannels).toEqual(['telegram']);
		expect(tradingViewMcpService.callScanTool).not.toHaveBeenCalled();
		expect(mockTelegramSendMessage).not.toHaveBeenCalled();
	});

	it('routes preset delivery to requested channels only', async () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'test-bot-token';
		process.env.TELEGRAM_CHAT_ID = '123456789';
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.greenapi.com/waInstance123/';
		process.env.WHATSAPP_API_KEY = 'test-whatsapp-key';
		process.env.WHATSAPP_CHAT_ID = '120363000000000000@g.us';

		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:GMTUSDT',
				changePercent: 26.415,
				indicators: { close: 0.0134, RSI: 79.72 },
			},
		]);

		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Telegram preset',
				exchange: 'binance',
				timeframe: '4h',
				scans: ['top_gainers'],
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const runResponse = await request(app)
			.post(`/api/scanner-presets/${presetId}/run`)
			.set('x-api-key', 'test-key')
			.send({
				channels: ['telegram'],
				telegramChatId: '-100999888777',
			})
			.expect(200);

		expect(runResponse.body.requestedChannels).toEqual(['telegram']);
		expect(runResponse.body.deliveredChannels).toEqual(['telegram']);
		expect(runResponse.body.deliveryResults).toHaveLength(1);
		expect(runResponse.body.processingTimeMs).toEqual(expect.any(Number));
		expect(runResponse.body).not.toHaveProperty('totalDurationMs');
		expect(mockTelegramSendMessage).toHaveBeenCalledWith(
			'-100999888777',
			expect.any(String),
			expect.any(Object),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it('creates a scheduled preset and executes it via scheduler sweep', async () => {
		process.env.ENABLE_SCANNER_PRESET_SCHEDULER = 'true';
		const { scannerPresetSchedulerService } = require('../../src/services/scannerPresets');

		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:BTCUSDT',
				changePercent: 5.2,
				indicators: { close: 65000, RSI: 55 },
			},
		]);

		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Hourly scheduled scan',
				exchange: 'binance',
				timeframe: '1h',
				scans: ['top_gainers'],
				schedule: {
					enabled: true,
					cadence: '1h',
				},
				channels: ['telegram'],
				telegramChatId: '123456789',
			})
			.expect(201);

		const preset = createResponse.body.preset;
		expect(preset.schedule).toEqual({
			enabled: true,
			cadence: '1h',
			cadenceMs: 3600000,
		});
		expect(preset.nextRunAt).toBeTruthy();

		// Wait for queued create writes to settle
		await new Promise((r) => setTimeout(r, 10));

		// Fast-forward due time by manually setting nextRunAt in the past
		await admin.firestore().collection('scannerPresets').doc(preset.id).update({
			nextRunAt: new Date(Date.now() - 5000).toISOString(),
		});

		const sweepResult = await scannerPresetSchedulerService.sweep();
		expect(sweepResult.executedCount).toBe(1);
		expect(sweepResult.errorCount).toBe(0);

		expect(mockTelegramSendMessage).toHaveBeenCalledWith(
			'123456789',
			expect.stringContaining('SCANNER DE MERCADO'),
			expect.any(Object),
		);

		const updatedDoc = await admin.firestore().collection('scannerPresets').doc(preset.id).get();
		const data = updatedDoc.data();
		expect(data.lastStatus).toBe('success');
		expect(data.lastRunAt).toBeTruthy();
		expect(new Date(data.nextRunAt).getTime()).toBeGreaterThan(Date.now());
	});

	it('returns ETag header and version field on GET /api/scanner-presets/:id', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({ name: 'ETag preset', exchange: 'BINANCE' })
			.expect(201);

		const presetId = createResponse.body.preset.id;
		expect(createResponse.body.preset.version).toBe(1);

		const getResponse = await request(app)
			.get(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(getResponse.headers.etag).toBe('"1"');
		expect(getResponse.body.preset.version).toBe(1);
	});

	it('updates with a matching If-Match token and increments version', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({ name: 'Matched If-Match preset' })
			.expect(201);

		const presetId = createResponse.body.preset.id;
		const initialVersion = createResponse.body.preset.version;

		const updateResponse = await request(app)
			.put(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.set('If-Match', `"${initialVersion}"`)
			.send({ limit: 12 })
			.expect(200);

		expect(updateResponse.body.preset.version).toBe(initialVersion + 1);
		expect(updateResponse.body.preset.limit).toBe(12);
		expect(updateResponse.headers.etag).toBe(`"${initialVersion + 1}"`);
	});

	it('returns 412 PRECONDITION_FAILED with current preset on stale If-Match', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({ name: 'Stale If-Match preset' })
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const response = await request(app)
			.put(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.set('If-Match', '"999"')
			.send({ limit: 12 })
			.expect(412);

		expect(response.body.code).toBe('PRECONDITION_FAILED');
		expect(response.body.preset).toMatchObject({
			id: presetId,
			version: createResponse.body.preset.version,
		});
	});

	it('returns 409 PRESET_LOCKED when lockedUntil is in the future', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({ name: 'Locked preset' })
			.expect(201);

		const presetId = createResponse.body.preset.id;
		const futureLock = new Date(Date.now() + 60000).toISOString();
		await admin.firestore().collection('scannerPresets').doc(presetId).update({
			lockedUntil: futureLock,
			lockedBy: 'scheduler',
			version: 2,
		});

		const response = await request(app)
			.put(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.send({ limit: 5 })
			.expect(409);

		expect(response.body.code).toBe('PRESET_LOCKED');
		expect(response.body.lockedUntil).toBe(futureLock);
	});

	it('returns 412 PRECONDITION_FAILED on stale If-Match for DELETE', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({ name: 'Stale delete preset' })
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const response = await request(app)
			.delete(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.set('If-Match', '"999"')
			.expect(412);

		expect(response.body.code).toBe('PRECONDITION_FAILED');
		expect(await admin.firestore().collection('scannerPresets').doc(presetId).get()).toBeDefined();
	});

	it('returns 400 INVALID_IF_MATCH for a malformed If-Match header', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({ name: 'Malformed If-Match preset' })
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const response = await request(app)
			.put(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.set('If-Match', '"3", "4"')
			.send({ limit: 7 })
			.expect(400);

		expect(response.body.code).toBe('INVALID_IF_MATCH');
	});
});

