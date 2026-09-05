const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs');
const request = require('supertest');
const express = require('express');
const { generateKeyPairSync } = require('crypto');
const { tmpdir } = require('os');
const { join } = require('path');
jest.mock('firebase-admin');
const admin = require('firebase-admin');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const geminiQuotaManager = require('../../src/services/grounding/geminiQuotaManager');
const groundingMetrics = require('../../src/services/grounding/metrics');
const { deliveryMetricsService } = require('../../src/services/notification/DeliveryMetricsService');
const { getRoutes } = require('../../src/routes');

const testPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});
const validFirestoreServiceAccountJson = JSON.stringify({
	type: 'service_account',
	project_id: 'x',
	client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
	private_key: testPrivateKey,
});

describe('Status endpoints', () => {
	let savedEnv;
	let savedTradingViewRuntimeStatus;
	let savedTradingViewVolumeRuntimeStatus;
	let savedTradingViewEnrichmentEvents;
	let app;
	let tempDir;

	beforeEach(() => {
		savedEnv = saveEnv();
		savedTradingViewRuntimeStatus = tradingViewMcpService.runtimeStatus;
		savedTradingViewVolumeRuntimeStatus = tradingViewMcpService.volumeRuntimeStatus;
		savedTradingViewEnrichmentEvents = tradingViewMcpService.enrichmentEvents;
		tradingViewMcpService.runtimeStatus = {
			status: 'unknown',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
		};
		tradingViewMcpService.volumeRuntimeStatus = {
			status: 'unknown',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
		};
		tradingViewMcpService.enrichmentEvents = [];
		admin.__resetApps();
		admin.__resetCollectionState();
		alertStorageService._resetForTesting();
		remoteConfigService._resetForTesting();
		geminiQuotaManager.resetForTesting();
		groundingMetrics.resetForTesting();
		Object.keys(process.env).forEach((key) => {
			delete process.env[key];
		});
		process.env.NODE_ENV = 'test';
		tempDir = null;
		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => null));

		process.env.WEBHOOK_API_KEY = 'status-key';
		process.env.SERVICE_NAME = 'cabros-bot-test';
		process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';
		process.env.NODE_ENV = 'test';
		delete process.env.SENTRY_ENVIRONMENT;
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'token';
		process.env.TELEGRAM_CHAT_ID = '123';
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://greenapi.example/';
		process.env.WHATSAPP_API_KEY = 'key';
		process.env.WHATSAPP_CHAT_ID = 'chat';
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'gemini-key';
		process.env.GEMINI_MODEL_NAME = 'gemini-2.5-flash';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
		delete process.env.TRADINGVIEW_MCP_URL;
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = validFirestoreServiceAccountJson;
		process.env.ENABLE_SENTRY = 'true';
		process.env.SENTRY_DSN = 'https://dsn.example';
		delete process.env.BRAVE_SEARCH_API_KEY;
		delete process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION;
		delete process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;
	});

	afterEach(() => {
		remoteConfigService._resetForTesting();
		geminiQuotaManager.resetForTesting();
		groundingMetrics.resetForTesting();
		deliveryMetricsService.resetForTesting();
		tradingViewMcpService.runtimeStatus = savedTradingViewRuntimeStatus;
		tradingViewMcpService.volumeRuntimeStatus = savedTradingViewVolumeRuntimeStatus;
		tradingViewMcpService.enrichmentEvents = savedTradingViewEnrichmentEvents;
		restoreEnv(savedEnv);
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('requires a valid API key when WEBHOOK_API_KEY is configured', async () => {
		const response = await request(app).get('/api/status');

		expect(response.status).toBe(401);
		expect(response.body.error).toBe('Unauthorized: Missing API key');
	});

	it('returns machine-readable status on /api/status', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.service).toEqual({
			name: 'cabros-bot-test',
			version: expect.any(String),
			commit: 'abcdef1234567890',
			environment: 'test',
		});
		expect(response.body.service).not.toHaveProperty('timestamp');
		expect(response.body.featureFlags.telegramBot).toBe(true);
		expect(response.body.readiness).toEqual(expect.objectContaining({
			status: 'pending',
			ready: false,
			components: expect.objectContaining({
				telegramBot: { status: 'pending' },
			}),
		}));
		expect(response.body.deliveryChannels.telegram).toEqual({ enabled: true, status: 'ready' });
		expect(response.body.dependencies.gemini).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
		expect(response.body.dependencies.geminiQuota).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			cooldownActive: false,
			remainingCooldownMs: 0,
			lastTriggeredAt: null,
			triggersTotal: 0,
			braveFallbacksDuringCooldown: 0,
			lastBraveFallbackAt: null,
			metrics: {
				totalRequests: 0,
				successRequests: 0,
				failureRequests: 0,
				timeoutRequests: 0,
			},
		});
		expect(response.body.dependencies.groundingCoalescing).toEqual({
			enabled: false,
			windowMs: 0,
			activeEntries: 0,
			hits: 0,
			misses: 0,
			failures: 0,
		});
		expect(response.body.dependencies.tradingViewMcp).toEqual({
			enabled: true,
			configured: true,
			ready: false,
			status: 'unknown',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
			circuitBreaker: {
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
				lastStateChangeAt: null,
				failureThreshold: 5,
				cooldownMs: 600000,
			},
		});
		expect(response.body.dependencies.braveSearch).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		expect(response.body.featureFlags.tradingViewConfluenceEnrichment).toBe(false);
		expect(response.body.dependencies.sentry.status).toBe('ready');
		expect(response.body.dependencies.webhookAuth).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			slots: ['current'],
			previousExpiresAt: null,
		});
	});

	it('reports API key rotation slots when ENABLE_API_KEY_ROTATION is true', async () => {
		process.env.ENABLE_API_KEY_ROTATION = 'true';
		process.env.WEBHOOK_API_KEY = 'status-key';
		process.env.WEBHOOK_API_KEY_PREVIOUS = 'old-key';
		process.env.WEBHOOK_API_KEY_PREVIOUS_EXPIRES_AT = '2999-12-31T23:59:59.000Z';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.webhookAuth).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			slots: ['current', 'previous'],
			previousExpiresAt: '2999-12-31T23:59:59.000Z',
		});
	});

	it('exposes rolling alert-path MCP enrichment rates', async () => {
		tradingViewMcpService.runtimeStatus = {
			status: 'degraded',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
			enrichment: {
				lastStatus: null,
				fullCount: 0,
				partialCount: 0,
				failedCount: 0,
			},
		};
		tradingViewMcpService._recordEnrichmentStatus('full');
		tradingViewMcpService._recordEnrichmentStatus('failed');

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.tradingViewMcp.enrichment.alertPath).toEqual(expect.objectContaining({
			totalCount: 2,
			appliedCount: 1,
			failedCount: 1,
			appliedRate24h: 50,
			failureRate24h: 50,
		}));
	});

	it('reports tradingViewConfluenceEnrichment as true only when explicitly configured to true', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT = 'true';
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.tradingViewConfluenceEnrichment).toBe(true);
	});

	it('reports scanner presets as ephemeral when no Firestore gate is enabled', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_FIRESTORE_SCANNER_PRESETS;
		delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');
		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreScannerPresets).toBe(false);
		expect(response.body.dependencies.scannerPresetStorage).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('reports durable scanner preset storage from its dedicated Firestore gate', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreScannerPresets).toBe(true);
		expect(response.body.dependencies.scannerPresetStorage).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			mode: 'durable',
			backend: 'firestore',
		});
	});

	it('does not report durable scanner presets from the alert storage gate', async () => {
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		delete process.env.ENABLE_FIRESTORE_SCANNER_PRESETS;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreScannerPresets).toBe(false);
		expect(response.body.dependencies.scannerPresetStorage).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('reports scanner preset storage as misconfigured without usable credentials', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.scannerPresetStorage).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
			mode: 'ephemeral',
			backend: 'memory',
		});
	});

	it('reports Cloudflare AI Gateway as disabled by default', async () => {
		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.cloudflareAig).toBe(false);
		expect(response.body.dependencies.cloudflareAig.enabled).toBe(false);
	});

	it('reports Cloudflare AI Gateway when enabled', async () => {
		process.env.ENABLE_CLOUDFLARE_AIG = 'true';
		process.env.CF_AIG_TOKEN = 'cloudflare-token';
		process.env.CF_AIG_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.cloudflareAig).toBe(true);
		expect(response.body.dependencies.cloudflareAig).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports TradingView volume confirmation as disabled by default', async () => {
		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.tradingViewVolumeConfirmation).toBe(false);
		expect(response.body.dependencies.tradingViewVolumeConfirmation).toEqual({
			enabled: false,
			configured: true,
			ready: false,
			status: 'disabled',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
			circuitBreaker: {
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
				lastStateChangeAt: null,
				failureThreshold: 5,
				cooldownMs: 600000,
			},
		});
	});

	it('reports news monitor test mode as disabled by default', async () => {
		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.newsMonitorTestMode).toBe(false);
	});

	it('reports news monitor test mode when enabled', async () => {
		process.env.ENABLE_NEWS_MONITOR_TEST_MODE = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.newsMonitorTestMode).toBe(true);
	});

	it('reports message footer metadata as enabled by default', async () => {
		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.messageFooterMetadata).toBe(true);
	});

	it('reports message footer metadata as disabled when explicitly disabled', async () => {
		process.env.ENABLE_MESSAGE_FOOTER_METADATA = 'false';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.messageFooterMetadata).toBe(false);
	});

	it('reports alert signal repeat suppression as disabled by default', async () => {
		delete process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.alertSignalRepeatSuppression).toBe(false);
		expect(response.body.dependencies.alertSignalRepeatSuppression).toEqual({
			enabled: false,
			suppressedCount: expect.any(Number),
			lastSuppressedAt: null,
			activeTrackedSignals: 0,
		});
	});

	it('reports alert signal repeat suppression when enabled', async () => {
		process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.alertSignalRepeatSuppression).toBe(true);
		expect(response.body.dependencies.alertSignalRepeatSuppression.enabled).toBe(true);
	});

	it('reports safe Firebase Remote Config load metadata without values and honest readiness', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firebaseRemoteConfig).toBe(true);
		expect(response.body.dependencies.firebaseRemoteConfig).toEqual(expect.objectContaining({
			enabled: true,
			configured: true,
			ready: false,
			status: 'unknown',
			source: 'environment',
			templateVersion: null,
			lastSuccessfulLoad: null,
			lastErrorCategory: null,
			consecutiveFailures: 0,
		}));
		expect(JSON.stringify(response.body.dependencies.firebaseRemoteConfig)).not.toContain('gemini-key');

		// When remote overrides are loaded and fresh, status reports ready: true
		const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
		remoteConfigService._setRemoteOverridesForTesting({ NEWS_ALERT_THRESHOLD: 0.85 }, Date.now());

		const readyResponse = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(readyResponse.status).toBe(200);
		expect(readyResponse.body.dependencies.firebaseRemoteConfig).toEqual(expect.objectContaining({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			source: 'remote',
			templateVersion: 'test',
			lastSuccessfulLoad: expect.any(String),
			consecutiveFailures: 0,
		}));
	});

	it('reports signal outcome tracking from the canonical environment variable', async () => {
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.signalOutcomeTracking).toBe(true);
		expect(response.body.dependencies.signalOutcomeWorker.enabled).toBe(true);
	});

	it('reports dedicated worker role and heartbeat counters', async () => {
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'worker';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.signalOutcomeWorker).toMatchObject({
			role: 'worker',
			running: false,
			lastRunScannedCount: 0,
			lastRunPendingCount: 0,
			lastRunErrorCount: 0,
			shutdownRequested: false,
		});
	});

	it('does not report a disabled local scheduler as ready', async () => {
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'disabled';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.signalOutcomeWorker).toMatchObject({
			enabled: true,
			role: 'disabled',
			ready: false,
			status: 'disabled',
		});
	});

	it('does not enable signal outcome tracking from the retired legacy environment variable', async () => {
		process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.signalOutcomeTracking).toBe(false);
		expect(response.body.dependencies.signalOutcomeWorker.enabled).toBe(false);
	});

	it('reports equity market-data readiness without exposing provider credentials', async () => {
		process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
		process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
		process.env.TWELVE_DATA_API_KEY = 'secret-equity-key';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.equityMarketData).toBe(true);
		expect(response.body.dependencies.equityMarketData).toEqual({
			provider: 'twelve-data',
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			supportedExchanges: ['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'FX_IDC', 'SPCFD'],
			timeoutMs: 5000,
			rpm: 0,
		});
		expect(JSON.stringify(response.body)).not.toContain('secret-equity-key');
	});

	it('reports Firestore job storage as disabled by default', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreJobStorage).toBe(false);
		expect(response.body.dependencies.firestoreJobStorage).toEqual({
			enabled: false,
			configured: true,
			ready: false,
			status: 'disabled',
		});
	});

	it('reports render-worker queue readiness without exposing broker details', async () => {
		process.env.JOB_EXECUTION_MODE = 'render-worker';
		delete process.env.REDIS_URL;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.jobExecutionWorker).toBe(true);
		expect(response.body.dependencies.jobExecutionQueue).toMatchObject({
			mode: 'render-worker',
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
		expect(JSON.stringify(response.body.dependencies.jobExecutionQueue)).not.toContain('redis://');
	});

	it('reports firestore-poller mode execution readiness without Redis', async () => {
		process.env.JOB_EXECUTION_MODE = 'firestore-poller';
		delete process.env.REDIS_URL;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.jobExecutionWorker).toBe(true);
		expect(response.body.dependencies.jobExecutionQueue).toMatchObject({
			mode: 'firestore-poller',
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
	});

	it('reports Firestore job storage through the legacy alert-storage gate', async () => {
		delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreJobStorage).toBe(true);
		expect(response.body.dependencies.firestoreJobStorage).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports Firestore job storage readiness when enabled', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreJobStorage).toBe(true);
		expect(response.body.dependencies.firestoreJobStorage).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports TradingView volume confirmation readiness when enabled', async () => {
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.tradingViewVolumeConfirmation).toBe(true);
		expect(response.body.dependencies.tradingViewVolumeConfirmation).toEqual({
			enabled: true,
			configured: true,
			ready: false,
			status: 'unknown',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
			circuitBreaker: {
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
				lastStateChangeAt: null,
				failureThreshold: 5,
				cooldownMs: 600000,
			},
		});
	});

	it('does not report volume confirmation ready without MCP enrichment', async () => {
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.tradingViewVolumeConfirmation).toBe(true);
		expect(response.body.dependencies.tradingViewVolumeConfirmation).toEqual({
			enabled: false,
			configured: true,
			ready: false,
			status: 'disabled',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
			circuitBreaker: {
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
				lastStateChangeAt: null,
				failureThreshold: 5,
				cooldownMs: 600000,
			},
		});
	});

	it('treats Gemini grounding as misconfigured without a Gemini model on the Gemini provider path', async () => {
		process.env.MODEL_PROVIDER = 'gemini';
		delete process.env.GEMINI_MODEL_NAME;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.geminiGrounding).toBe(true);
		expect(response.body.dependencies.gemini).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
		expect(response.body.dependencies.geminiQuota).toEqual(expect.objectContaining({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		}));
	});

	it('reports Gemini quota status as degraded when active cooldown is in effect', async () => {
		const before = Date.now();
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 5000 });
		geminiQuotaManager.recordBraveFallbackDuringCooldown();
		groundingMetrics.recordSuccess(100, 'ALERT_ENRICHMENT');
		groundingMetrics.recordFailure('timeout', new Error('timeout'), 'ALERT_ENRICHMENT');

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.geminiQuota).toEqual({
			enabled: true,
			configured: true,
			ready: false,
			status: 'degraded',
			cooldownActive: true,
			remainingCooldownMs: expect.any(Number),
			lastTriggeredAt: expect.any(String),
			triggersTotal: 1,
			braveFallbacksDuringCooldown: 1,
			lastBraveFallbackAt: expect.any(String),
			metrics: {
				totalRequests: 2,
				successRequests: 1,
				failureRequests: 0,
				timeoutRequests: 1,
			},
		});
		expect(response.body.dependencies.geminiQuota.remainingCooldownMs).toBeGreaterThan(0);
		expect(response.body.dependencies.geminiQuota.remainingCooldownMs).toBeLessThanOrEqual(5000);
		const lastTriggeredTime = new Date(response.body.dependencies.geminiQuota.lastTriggeredAt).getTime();
		expect(lastTriggeredTime).toBeGreaterThanOrEqual(before);
	});

	it('reports Gemini quota status as disabled when Gemini is disabled', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		delete process.env.ENABLE_NEWS_MONITOR;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.geminiQuota).toEqual({
			enabled: false,
			configured: true,
			ready: false,
			status: 'disabled',
			cooldownActive: false,
			remainingCooldownMs: 0,
			lastTriggeredAt: null,
			triggersTotal: 0,
			braveFallbacksDuringCooldown: 0,
			lastBraveFallbackAt: null,
			metrics: {
				totalRequests: 0,
				successRequests: 0,
				failureRequests: 0,
				timeoutRequests: 0,
			},
		});
	});


	it('treats Gemini as enabled when news monitor depends on it', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.geminiGrounding).toBe(false);
		expect(response.body.featureFlags.newsMonitor).toBe(true);
		expect(response.body.dependencies.gemini).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports the primary news monitor Gemini provider separately from Gemini search readiness', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'gemini';
		delete process.env.GEMINI_MODEL_NAME;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.gemini).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'gemini',
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('does not require Gemini when news monitor uses Brave search and Azure', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'azure';
		process.env.FORCE_BRAVE_SEARCH = 'true';
		process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
		process.env.AZURE_LLM_KEY = 'azure-key';
		process.env.AZURE_LLM_MODEL = 'gpt-4o-mini';
		delete process.env.GEMINI_API_KEY;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.newsMonitor).toBe(true);
		expect(response.body.dependencies.gemini).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		expect(response.body.dependencies.braveSearch).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'azure',
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports forced Brave search as misconfigured when its API key is missing', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'azure';
		process.env.FORCE_BRAVE_SEARCH = 'true';
		process.env.AZURE_LLM_KEY = 'azure-key';
		process.env.AZURE_LLM_MODEL = 'gpt-4o-mini';
		delete process.env.GEMINI_API_KEY;
		delete process.env.BRAVE_SEARCH_API_KEY;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.braveSearch).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'azure',
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('normalizes mixed-case primary news monitor provider names', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'Azure';
		process.env.FORCE_BRAVE_SEARCH = 'true';
		process.env.BRAVE_SEARCH_API_KEY = 'brave-key';
		process.env.AZURE_LLM_KEY = 'azure-key';
		process.env.AZURE_LLM_MODEL = 'gpt-4o-mini';
		delete process.env.GEMINI_API_KEY;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'azure',
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports Azure as misconfigured when the primary news monitor provider is missing credentials', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'azure';
		process.env.FORCE_BRAVE_SEARCH = 'true';
		delete process.env.GEMINI_API_KEY;
		delete process.env.AZURE_LLM_KEY;
		delete process.env.AZURE_LLM_MODEL;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.gemini).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'azure',
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('reports OpenRouter as the primary news monitor provider', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'openrouter';
		process.env.FORCE_BRAVE_SEARCH = 'true';
		delete process.env.GEMINI_API_KEY;
		delete process.env.OPENROUTER_API_KEY;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.gemini).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'openrouter',
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('reports Azure LLM enrichment readiness when the feature flag is enabled', async () => {
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.llmAlertEnrichment).toBe(true);
		expect(response.body.dependencies).toHaveProperty('llmAlertEnrichment');
		expect(response.body.dependencies.llmAlertEnrichment).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('treats the default Azure LLM endpoint as configured for enrichment readiness', async () => {
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
		process.env.AZURE_LLM_KEY = 'azure-key';
		process.env.AZURE_LLM_MODEL = 'gpt-4o-mini';
		delete process.env.AZURE_LLM_ENDPOINT;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.llmAlertEnrichment).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('aliases /api/capabilities to the same payload shape', async () => {
		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body).toHaveProperty('service');
		expect(response.body).toHaveProperty('featureFlags');
		expect(response.body).toHaveProperty('deliveryChannels');
		expect(response.body).toHaveProperty('dependencies');
	});

	it('handles disabled optional integrations without failing', async () => {
		delete process.env.WHATSAPP_API_KEY;
		process.env.ENABLE_WHATSAPP_ALERTS = 'false';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.whatsapp).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		expect(response.body.dependencies.tradingViewMcp.status).toBe('disabled');
	});

	it('treats TradingView MCP as enabled when market scanner depends on it', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
		process.env.ENABLE_MARKET_SCANNER = 'true';
		delete process.env.TRADINGVIEW_MCP_URL;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.marketScanner).toBe(true);
		expect(response.body.featureFlags.tradingViewMcpEnrichment).toBe(false);
		expect(response.body.dependencies.tradingViewMcp).toEqual({
			enabled: true,
			configured: true,
			ready: false,
			status: 'unknown',
			lastCheckedAt: null,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
			circuitBreaker: {
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
				lastStateChangeAt: null,
				failureThreshold: 5,
				cooldownMs: 600000,
			},
		});
	});

	it('keeps observed MCP readiness visible after an always-mounted consumer uses it', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
		delete process.env.ENABLE_MARKET_SCANNER;
		const originalCallTool = tradingViewMcpService._callTool;
		tradingViewMcpService._callTool = jest.fn().mockResolvedValue({
			price_data: { current_price: 70000 },
		});

		try {
			await tradingViewMcpService.callCoinAnalysis({
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1D',
			});

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.dependencies.tradingViewMcp).toEqual(expect.objectContaining({
				enabled: true,
				configured: true,
				ready: true,
				status: 'ready',
				successCount: 1,
			}));
		} finally {
			tradingViewMcpService._callTool = originalCallTool;
		}
	});

	it('tracks volume-confirmation readiness independently from generic MCP calls', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';
		const originalCallTool = tradingViewMcpService._callTool;
		tradingViewMcpService._callTool = jest.fn().mockResolvedValue({
			price_data: { current_price: 70000 },
		});

		try {
			await tradingViewMcpService.callCoinAnalysis({
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1D',
			});

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.dependencies.tradingViewMcp).toEqual(expect.objectContaining({
				ready: true,
				status: 'ready',
				successCount: 1,
			}));
			expect(response.body.dependencies.tradingViewVolumeConfirmation).toEqual(expect.objectContaining({
				enabled: true,
				configured: true,
				ready: false,
				status: 'unknown',
				successCount: 0,
				failureCount: 0,
			}));

			await tradingViewMcpService.callVolumeConfirmation({
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1D',
			});

			const volumeResponse = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');
			expect(volumeResponse.body.dependencies.tradingViewVolumeConfirmation).toEqual(expect.objectContaining({
				ready: true,
				status: 'ready',
				successCount: 1,
			}));
		} finally {
			tradingViewMcpService._callTool = originalCallTool;
		}
	});

	it('treats Firestore ADC on Google-managed runtimes as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.K_SERVICE = 'cabros-bot';
		process.env.GOOGLE_CLOUD_PROJECT = 'cabros-project';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('does not treat a bare Google project id as Firestore ADC readiness', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.GOOGLE_CLOUD_PROJECT = 'cabros-project';
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-gcloud-empty-'));
		process.env.HOME = tempDir;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('treats an unreadable Firestore credential file path as misconfigured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/cabros-missing-service-account.json';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('treats a readable Firestore credential file path as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-firestore-'));
		const credentialsPath = join(tempDir, 'service-account.json');
		writeFileSync(credentialsPath, validFirestoreServiceAccountJson);
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('does not treat a service-account file without its type as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-firestore-'));
		const credentialsPath = join(tempDir, 'service-account-without-type.json');
		writeFileSync(credentialsPath, JSON.stringify({
			project_id: 'x',
			client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
			private_key: testPrivateKey,
		}));
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('does not treat a readable credential directory as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-firestore-'));
		process.env.GOOGLE_APPLICATION_CREDENTIALS = tempDir;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('does not treat malformed credential file JSON as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-firestore-'));
		const credentialsPath = join(tempDir, 'service-account.json');
		writeFileSync(credentialsPath, '{"project_id":');
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('treats a valid authorized-user ADC file as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		process.env.FIREBASE_PROJECT_ID = 'authorized-user-project';
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-firestore-'));
		const credentialsPath = join(tempDir, 'authorized-user.json');
		writeFileSync(credentialsPath, JSON.stringify({
			type: 'authorized_user',
			client_id: 'client-id.apps.googleusercontent.com',
			client_secret: 'client-secret',
			refresh_token: 'refresh-token',
		}));
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('rejects authorized-user ADC files without a project id', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.GOOGLE_CLOUD_PROJECT;
		delete process.env.GCLOUD_PROJECT;
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-firestore-'));
		const credentialsPath = join(tempDir, 'authorized-user.json');
		writeFileSync(credentialsPath, JSON.stringify({
			type: 'authorized_user',
			client_id: 'client-id.apps.googleusercontent.com',
			client_secret: 'client-secret',
			refresh_token: 'refresh-token',
		}));
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('rejects external-account ADC files unsupported by Firebase Admin', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-firestore-'));
		const credentialsPath = join(tempDir, 'external-account.json');
		writeFileSync(credentialsPath, JSON.stringify({
			type: 'external_account',
			audience: '//iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/pool/providers/provider',
			subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
			token_url: 'https://sts.googleapis.com/v1/token',
			credential_source: { file: '/tmp/subject-token.txt' },
		}));
		process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		console.log('DEBUG status test line 911:', response.status, response.body);
		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('treats well-known ADC files as configured', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.GOOGLE_CLOUD_PROJECT = 'well-known-project';
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-gcloud-'));
		const credentialsDirectory = join(tempDir, '.config', 'gcloud');
		mkdirSync(credentialsDirectory, { recursive: true });
		const credentialsPath = join(credentialsDirectory, 'application_default_credentials.json');
		writeFileSync(credentialsPath, validFirestoreServiceAccountJson);
		process.env.HOME = tempDir;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('does not use os.homedir when HOME is unset for ADC discovery', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete process.env.HOME;
		delete process.env.APPDATA;
		delete process.env.CLOUDSDK_CONFIG;
		process.env.GOOGLE_CLOUD_PROJECT = 'home-unset-project';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('does not treat CLOUDSDK_CONFIG as Firebase ADC discovery', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.GOOGLE_CLOUD_PROJECT = 'cloudsdk-config-project';
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-gcloud-config-'));
		writeFileSync(join(tempDir, 'application_default_credentials.json'), validFirestoreServiceAccountJson);
		process.env.CLOUDSDK_CONFIG = tempDir;
		const homeDirectory = join(tempDir, 'home-without-adc');
		mkdirSync(homeDirectory, { recursive: true });
		process.env.HOME = homeDirectory;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('does not fall back to well-known ADC when the explicit path is invalid', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		process.env.GOOGLE_CLOUD_PROJECT = 'well-known-project';
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-gcloud-'));
		const credentialsDirectory = join(tempDir, '.config', 'gcloud');
		mkdirSync(credentialsDirectory, { recursive: true });
		const wellKnownPath = join(credentialsDirectory, 'application_default_credentials.json');
		writeFileSync(wellKnownPath, validFirestoreServiceAccountJson);
		process.env.HOME = tempDir;
		process.env.GOOGLE_APPLICATION_CREDENTIALS = join(tempDir, 'missing-explicit.json');

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('treats Compute Engine metadata credentials as configured with a project id', async () => {
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		process.env.GCE_METADATA_HOST = 'metadata.google.internal';
		process.env.GOOGLE_CLOUD_PROJECT = 'metadata-project';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key')
			.expect(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('treats malformed inline Firestore credentials as misconfigured', async () => {
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"project_id":';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('treats incomplete inline Firestore credentials as misconfigured', async () => {
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			project_id: 'x',
		});

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('does not leak configured secret values', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');
		const serializedBody = JSON.stringify(response.body);

		expect(serializedBody).not.toContain('token');
		expect(serializedBody).not.toContain('key');
		expect(serializedBody).not.toContain('gemini-key');
		expect(serializedBody).not.toContain('https://dsn.example');
		expect(serializedBody).not.toContain('https://greenapi.example/');
	});

	it('reports preview-disabled Telegram delivery separately from the feature flag', async () => {
		process.env.RENDER = 'true';
		process.env.IS_PULL_REQUEST = 'true';
		process.env.NODE_ENV = 'production';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.service.environment).toBe('preview');
		expect(response.body.featureFlags.telegramBot).toBe(true);
		expect(response.body.deliveryChannels.telegram).toEqual({ enabled: false, status: 'disabled' });
		expect(response.body.dependencies.telegram.ready).toBe(false);
	});

	it('reports Vercel preview deployments consistently', async () => {
		process.env.VERCEL_ENV = 'preview';
		process.env.NODE_ENV = 'production';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.service.environment).toBe('preview');
		expect(response.body.deliveryChannels.telegram).toEqual({ enabled: false, status: 'disabled' });
	});

	it('reports preview WhatsApp readiness from the preview destination', async () => {
		process.env.VERCEL_ENV = 'preview';
		delete process.env.WHATSAPP_CHAT_ID;
		process.env.WHATSAPP_PREVIEW_CHAT_ID = 'preview-chat';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.whatsapp).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports news monitor deduplication as process-local (in-memory) by default', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'false';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorDedup).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'in-memory',
			backend: null,
		});
	});

	it('reports news monitor deduplication as persistent (firestore) when enabled', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorDedup).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			mode: 'persistent',
			backend: 'firestore',
		});
	});

	it('reports news monitor deduplication as persistent when enabled via Remote Config while process.env is false', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'false';
		remoteConfigService._setRemoteOverridesForTesting({
			ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP: true,
		});

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorDedup).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			mode: 'persistent',
			backend: 'firestore',
		});
	});

	it('reports news monitor deduplication as disabled when disabled via Remote Config while process.env is true', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		remoteConfigService._setRemoteOverridesForTesting({
			ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP: false,
		});

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorDedup).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'in-memory',
			backend: null,
		});
	});

	it('reports Cloudflare as the primary news monitor provider and fallback model as configured', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'cloudflare';
		process.env.CF_AIG_TOKEN = 'cloudflare-token';
		process.env.CF_AIG_BASE_URL = 'https://gateway.ai.cloudflare.com/v1/xyz/default/compat';
		delete process.env.CF_AIG_MODEL;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'cloudflare',
			configured: true,
			ready: true,
			status: 'ready',
		});
	});

	it('reports Cloudflare as misconfigured if base URL is missing', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.MODEL_PROVIDER = 'cloudflare';
		process.env.CF_AIG_TOKEN = 'cloudflare-token';
		delete process.env.CF_AIG_BASE_URL;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorLlm).toEqual({
			enabled: true,
			provider: 'cloudflare',
			configured: false,
			ready: false,
			status: 'misconfigured',
		});
	});

	it('reports notificationRedrive feature flag and dependency status when disabled and enabled', async () => {
		delete process.env.ENABLE_NOTIFICATION_REDRIVE;
		const disabledResponse = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(disabledResponse.status).toBe(200);
		expect(disabledResponse.body.featureFlags.notificationRedrive).toBe(false);
		expect(disabledResponse.body.dependencies.notificationRedrive).toMatchObject({
			enabled: false,
			role: 'web',
			running: false,
			pendingCount: 0,
		});

		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'worker';
		const enabledResponse = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(enabledResponse.status).toBe(200);
		expect(enabledResponse.body.featureFlags.notificationRedrive).toBe(true);
		expect(enabledResponse.body.dependencies.notificationRedrive).toMatchObject({
			enabled: true,
			role: 'worker',
			batchLimit: 50,
			maxAttempts: 5,
		});
	});

	it('omits deliveryMetrics when no deliveries have been recorded', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body).not.toHaveProperty('deliveryMetrics');
	});

	it('exposes per-channel deliveryMetrics after recorded results', async () => {
		deliveryMetricsService.record({ channel: 'telegram', success: true, durationMs: 120 });
		deliveryMetricsService.record({ channel: 'telegram', success: false, durationMs: 250 });
		deliveryMetricsService.record({ channel: 'whatsapp', success: true, durationMs: 300 });

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.deliveryMetrics).toEqual(expect.objectContaining({
			success: 2,
			failure: 1,
			total: 3,
			successRate: expect.closeTo(2 / 3, 4),
			byChannel: {
				telegram: expect.objectContaining({
					success: 1,
					failure: 1,
					total: 2,
					successRate: 0.5,
					averageDeliveryMs: 185,
				}),
				whatsapp: expect.objectContaining({
					success: 1,
					failure: 0,
					total: 1,
					successRate: 1.0,
					averageDeliveryMs: 300,
				}),
			},
			window: expect.objectContaining({
				startedAt: expect.any(String),
				durationMs: expect.any(Number),
			}),
		}));
		expect(response.body.deliveryMetrics.averageDeliveryMs).toBeCloseTo((120 + 250 + 300) / 3, 1);
	});

	it('aliases /api/capabilities to expose deliveryMetrics', async () => {
		deliveryMetricsService.record({ channel: 'discord', success: true, durationMs: 80 });

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.deliveryMetrics).toEqual(expect.objectContaining({
			success: 1,
			failure: 0,
			total: 1,
			byChannel: expect.objectContaining({
				discord: expect.objectContaining({ successRate: 1.0 }),
			}),
		}));
	});
});
