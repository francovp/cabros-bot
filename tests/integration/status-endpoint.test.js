/* global saveEnv, restoreEnv */
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
const { firestoreWriteMetricsService } = require('../../src/services/storage/FirestoreWriteMetricsService');
const equityMarketDataService = require('../../src/services/storage/EquityMarketDataService');
const idempotencyStorageService = require('../../src/services/storage/IdempotencyStorageService');
const promptReadiness = require('../../src/services/prompts/promptReadiness');
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
		tradingViewMcpService.toolMetrics = {};
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
		process.env.BOT_TOKEN = 'secret-bot-token';
		process.env.TELEGRAM_CHAT_ID = '123';
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://greenapi.example/';
		process.env.WHATSAPP_API_KEY = 'secret-whatsapp-key';
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
		firestoreWriteMetricsService.resetForTesting();
		tradingViewMcpService.runtimeStatus = savedTradingViewRuntimeStatus;
		tradingViewMcpService.volumeRuntimeStatus = savedTradingViewVolumeRuntimeStatus;
		tradingViewMcpService.enrichmentEvents = savedTradingViewEnrichmentEvents;
		tradingViewMcpService.toolMetrics = {};
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
			windowStartedAt: null,
			windowDurationMs: 60000,
			requestsInWindow: 0,
			exhaustedEventsInWindow: 0,
			lastExhaustedAt: null,
			quotaStatus: 'healthy',
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
			errorCategoryCounts: {
				circuit_breaker_open: 0,
				http_5xx: 0,
				http_4xx: 0,
				timeout: 0,
				invalid_response: 0,
				request_failed: 0,
			},
			toolMetrics: {},
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
		expect(response.body.dependencies.scannerPresetStorage).toEqual(expect.objectContaining({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'ephemeral',
			backend: 'memory',
			failOpen: true,
			collection: 'scannerPresets',
			pendingWrites: 0,
			inFlightWrites: 0,
			pendingDeletes: 0,
			oldestPendingWriteAt: null,
			lastReadFellBack: false,
		}));
	});

	it('reports firestoreChatPreferences feature flag and dependency status when disabled and enabled', async () => {
		delete process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES;
		let res = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(res.status).toBe(200);
		expect(res.body.featureFlags.firestoreChatPreferences).toBe(false);
		expect(res.body.dependencies.chatPreferences.enabled).toBe(false);

		process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES = 'true';
		res = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(res.status).toBe(200);
		expect(res.body.featureFlags.firestoreChatPreferences).toBe(true);
		expect(res.body.dependencies.chatPreferences.enabled).toBe(true);
		expect(res.body.dependencies.chatPreferences.cachedCount).toEqual(expect.any(Number));
	});

	it('reports durable scanner preset storage from its dedicated Firestore gate', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreScannerPresets).toBe(true);
		// `ready` here is proven by the bounded durable read `/api/status` runs, not
		// inferred from credential shape (#1342). The observed counters are a
		// process-local window that only a restart clears, so they are asserted by type.
		expect(response.body.dependencies.scannerPresetStorage).toEqual(expect.objectContaining({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			readiness: 'verified',
			mode: 'durable',
			backend: 'firestore',
			failOpen: true,
			collection: 'scannerPresets',
			operationsAttempted: expect.any(Number),
			operationsSucceeded: expect.any(Number),
			operationsFailed: 0,
			consecutiveFailures: 0,
			lastSuccessAt: expect.any(String),
			pendingWrites: 0,
			inFlightWrites: 0,
			pendingDeletes: 0,
			oldestPendingWriteAt: null,
			lastReadFellBack: false,
		}));
	});

	it('does not report durable scanner presets from the alert storage gate', async () => {
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		delete process.env.ENABLE_FIRESTORE_SCANNER_PRESETS;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreScannerPresets).toBe(false);
		expect(response.body.dependencies.scannerPresetStorage).toEqual(expect.objectContaining({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'ephemeral',
			backend: 'memory',
			failOpen: true,
			collection: 'scannerPresets',
			pendingWrites: 0,
			inFlightWrites: 0,
			pendingDeletes: 0,
			oldestPendingWriteAt: null,
			lastReadFellBack: false,
		}));
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
		expect(response.body.dependencies.scannerPresetStorage).toEqual(expect.objectContaining({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
			mode: 'ephemeral',
			backend: 'memory',
			failOpen: true,
			collection: 'scannerPresets',
			pendingWrites: 0,
			inFlightWrites: 0,
			pendingDeletes: 0,
			oldestPendingWriteAt: null,
		}));
	});

	it('reports degraded durable scanner preset storage after a durable read failure', async () => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

		// Prove durability first, which also arms the probe cooldown so the verdict below
		// reflects the read failure rather than a fresh probe.
		await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key')
			.expect(200);

		admin.__mockGet.mockRejectedValueOnce(new Error('Temporary Firestore outage'));
		await request(app)
			.get('/api/scanner-presets')
			.set('x-api-key', 'status-key')
			.expect(200);

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.scannerPresetStorage).toEqual(expect.objectContaining({
			enabled: true,
			// Credentials are valid, so this is a store fault and not `misconfigured`
			// (#1342): the operator must not be sent to fix credentials that work.
			configured: true,
			ready: false,
			status: 'degraded',
			mode: 'durable',
			backend: 'firestore',
			lastErrorReason: 'firestore_unavailable',
			consecutiveFailures: 1,
			lastReadFellBack: true,
		}));
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

	it('reports the optional news monitor classifier gate', async () => {
		let response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.newsMonitorClassifier).toBe(false);

		process.env.ENABLE_NEWS_MONITOR_CLASSIFIER = 'true';
		response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.newsMonitorClassifier).toBe(true);
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

	it('reports signal class marker as enabled by default', async () => {
		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.signalClassMarker).toBe(true);
	});

	it('reports signal class marker as disabled when explicitly disabled', async () => {
		process.env.ENABLE_SIGNAL_CLASS_MARKER = 'false';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.signalClassMarker).toBe(false);
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

	// Issue #598: production reported `enabled: true, configured: true` with a
	// never-loaded server template. The status contract must make the
	// unready-but-configured state explicit so an operator cannot mistake
	// "wired up" for "actually serving remote values".
	it('reports an explicit unready state while the server template has never loaded', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		const remoteConfig = response.body.dependencies.firebaseRemoteConfig;

		expect(remoteConfig.ready).toBe(false);
		expect(remoteConfig.lastSuccessfulLoad).toBeNull();
		expect(remoteConfig.status).not.toBe('ready');
		expect(response.body.featureFlags.firebaseRemoteConfig).toBe(true);
		// `enabled` + `configured` alone must not read as "template is live".
		expect(remoteConfig.templatePublished).toBe(false);
	});

	it('keeps /api/capabilities readiness consistent with /api/status', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';

		const statusResponse = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');
		const capabilitiesResponse = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(statusResponse.status).toBe(200);
		expect(capabilitiesResponse.status).toBe(200);
		expect(capabilitiesResponse.body.dependencies.firebaseRemoteConfig)
			.toEqual(statusResponse.body.dependencies.firebaseRemoteConfig);
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
			entryPriceSources: {
				configured: false,
				crypto: ['mcp', 'binance', 'gemini'],
				equity: ['twelve-data'],
			},
		});
	});

	it('reports the sweep lease observability on both status aliases', async () => {
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'web';

		const status = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');
		const capabilities = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(status.status).toBe(200);
		expect(status.body.dependencies.signalOutcomeWorker).toMatchObject({
			leaseMs: 120000,
			lastRunLeaseHeld: false,
			leaseHeldSkipCount: 0,
		});
		expect(capabilities.body.dependencies.signalOutcomeWorker).toMatchObject({
			leaseMs: 120000,
			lastRunLeaseHeld: false,
			leaseHeldSkipCount: 0,
		});
	});

	it('reports the configured sweep lease duration and never lock ownership', async () => {
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
		process.env.SIGNAL_OUTCOME_WORKER_ROLE = 'web';
		process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS = '45000';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.signalOutcomeWorker.leaseMs).toBe(45000);

		// Lease ownership is an internal lock value and must never reach an operator.
		expect(response.text).not.toContain('lockedBy');
		delete process.env.SIGNAL_OUTCOME_EVALUATION_LEASE_MS;
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
		// Credentials have the right shape, but nothing has called the provider yet, so
		// the endpoint must not claim equity outcomes are working (#1116).
		expect(response.body.dependencies.equityMarketData).toEqual({
			provider: 'twelve-data',
			enabled: true,
			configured: true,
			ready: false,
			status: 'unverified',
			readiness: 'unverified',
			requestsAttempted: 0,
			requestsSucceeded: 0,
			requestsFailed: 0,
			consecutiveFailures: 0,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastErrorReason: null,
			supportedExchanges: ['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'FX_IDC', 'SPCFD'],
			timeoutMs: 5000,
			rpm: 0,
		});
		expect(JSON.stringify(response.body)).not.toContain('secret-equity-key');
	});

	it('surfaces an equity market-data provider failure through /api/status', async () => {
		process.env.ENABLE_EQUITY_MARKET_DATA = 'true';
		process.env.EQUITY_MARKET_DATA_PROVIDER = 'twelve-data';
		process.env.TWELVE_DATA_API_KEY = 'secret-equity-key';

		const originalFetch = global.fetch;
		global.fetch = jest.fn().mockResolvedValue({
			ok: false,
			status: 401,
			headers: new Map(),
			json: async () => ({ code: 401, message: 'Invalid API key' }),
		});
		try {
			await equityMarketDataService.getEntryPrice({ symbol: 'AAPL', exchange: 'NASDAQ' })
				.catch(() => {});

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.dependencies.equityMarketData).toMatchObject({
				configured: true,
				ready: false,
				status: 'degraded',
				readiness: 'degraded',
				requestsAttempted: 1,
				requestsFailed: 1,
				lastErrorReason: 'twelve_data_misconfigured',
			});
			expect(JSON.stringify(response.body)).not.toContain('secret-equity-key');
		} finally {
			global.fetch = originalFetch;
			equityMarketDataService._resetReadinessForTesting();
		}
	});

	// Issue #1111 enables durable idempotency in production. Every Firestore error in
	// `IdempotencyStorageService` is swallowed into in-memory fallback, so before the
	// proven-readiness change a deployment that could not reach Firestore reported the
	// same `ready` verdict as a working one and the enablement was unverifiable.
	it('reports idempotency storage as unverified while credentials only look valid', async () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = validFirestoreServiceAccountJson;
		idempotencyStorageService._resetForTesting();

		try {
			const response = await request(app)
				.get('/api/capabilities')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.featureFlags.firestoreIdempotency).toBe(true);
			expect(response.body.dependencies.idempotencyStorage).toEqual({
				enabled: true,
				configured: true,
				ready: false,
				status: 'unverified',
				mode: 'durable',
				backend: 'firestore',
				failOpen: true,
				readiness: 'unverified',
				collection: 'idempotency_keys',
				operationsAttempted: 0,
				operationsSucceeded: 0,
				operationsFailed: 0,
				consecutiveFailures: 0,
				lastSuccessAt: null,
				lastFailureAt: null,
				lastErrorReason: null,
			});
		} finally {
			idempotencyStorageService._resetForTesting();
		}
	});

	it('surfaces a durable idempotency failure through /api/status as degraded', async () => {
		process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = validFirestoreServiceAccountJson;
		idempotencyStorageService._resetForTesting();

		try {
			// The firebase-admin double has no `runTransaction`, so the reservation
			// rejects exactly the way an unreachable Firestore would.
			await idempotencyStorageService.reserveEntry('status-key-replay', 'hash', 300000);

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.dependencies.idempotencyStorage).toMatchObject({
				enabled: true,
				configured: true,
				ready: false,
				status: 'degraded',
				readiness: 'degraded',
				failOpen: true,
				operationsAttempted: 1,
				operationsFailed: 1,
				consecutiveFailures: 1,
				lastErrorReason: 'firestore_unavailable',
			});
		} finally {
			idempotencyStorageService._resetForTesting();
		}
	});

	// Issue #1178 enables Langfuse dynamic prompts in production. Before the
	// proven-readiness change `dependencies.langfuse` was
	// `dependencyStatus({ enabled, configured })`, so flipping the gate made a
	// deployment report `ready: true` while every alert silently resolved to the
	// local fallback file. `configured` validates credential shape only, which a
	// typo'd, revoked or wrong-project key satisfies.
	it('reports Langfuse prompts as unverified while credentials only look valid', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';
		process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-status-public';
		process.env.LANGFUSE_SECRET_KEY = 'sk-lf-status-secret';
		process.env.LANGFUSE_PROMPT_LABEL = 'production';
		process.env.LANGFUSE_PROMPT_CACHE_TTL_SECONDS = '300';
		promptReadiness.resetPromptReadinessForTesting();

		try {
			const response = await request(app)
				.get('/api/capabilities')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.featureFlags.langfusePrompts).toBe(true);
			expect(response.body.dependencies.langfuse).toEqual({
				enabled: true,
				configured: true,
				ready: false,
				status: 'unverified',
				readiness: 'unverified',
				failOpen: true,
				baseUrlHost: 'cloud.langfuse.com',
				label: 'production',
				cacheTtlSeconds: 300,
				promptsAttempted: 0,
				promptsSucceeded: 0,
				promptsFailed: 0,
				localFallbackCount: 0,
				consecutiveFailures: 0,
				lastSuccessAt: null,
				lastFailureAt: null,
				lastErrorReason: null,
				byPrompt: {},
				localFallbackByPrompt: {},
			});
			expect(JSON.stringify(response.body)).not.toContain('sk-lf-status-secret');
			expect(JSON.stringify(response.body)).not.toContain('pk-lf-status-public');
		} finally {
			promptReadiness.resetPromptReadinessForTesting();
		}
	});

	it('surfaces an observed Langfuse prompt failure through /api/status as degraded', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';
		process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-status-public';
		process.env.LANGFUSE_SECRET_KEY = 'sk-lf-status-secret';
		promptReadiness.resetPromptReadinessForTesting();

		try {
			promptReadiness.getPromptReadiness().recordAttempt();
			promptReadiness.getPromptReadiness().recordFailure('langfuse_prompt_not_found');
			promptReadiness.getPromptReadiness().recordLocalFallback({ promptName: 'alert-enrichment' });

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.dependencies.langfuse).toMatchObject({
				enabled: true,
				configured: true,
				ready: false,
				status: 'degraded',
				readiness: 'degraded',
				failOpen: true,
				promptsAttempted: 1,
				promptsFailed: 1,
				localFallbackCount: 1,
				lastErrorReason: 'langfuse_prompt_not_found',
				localFallbackByPrompt: { 'alert-enrichment': 1 },
			});
		} finally {
			promptReadiness.resetPromptReadinessForTesting();
		}
	});

	it('reports Langfuse prompts ready only after an observed successful resolution', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';
		process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-status-public';
		process.env.LANGFUSE_SECRET_KEY = 'sk-lf-status-secret';
		promptReadiness.resetPromptReadinessForTesting();

		try {
			promptReadiness.getPromptReadiness().recordAttempt();
			promptReadiness.getPromptReadiness().recordSuccess({
				promptName: 'alert-enrichment',
				label: 'production',
				version: 12,
			});

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.dependencies.langfuse).toMatchObject({
				ready: true,
				status: 'ready',
				readiness: 'verified',
				promptsSucceeded: 1,
				byPrompt: {
					'alert-enrichment': { langfuse: 1, local: 0, lastVersion: 12, lastLabel: 'production' },
				},
			});
		} finally {
			promptReadiness.resetPromptReadinessForTesting();
		}
	});

	it('reports a disabled Langfuse gate even after successes were recorded', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'false';
		promptReadiness.resetPromptReadinessForTesting();

		try {
			promptReadiness.getPromptReadiness().recordAttempt();
			promptReadiness.getPromptReadiness().recordSuccess({ promptName: 'alert-enrichment', label: 'latest' });

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.featureFlags.langfusePrompts).toBe(false);
			expect(response.body.dependencies.langfuse).toMatchObject({
				enabled: false,
				ready: false,
				status: 'disabled',
			});
		} finally {
			promptReadiness.resetPromptReadinessForTesting();
		}
	});

	it('reports a Langfuse gate with a missing credential as misconfigured, not ready', async () => {
		process.env.ENABLE_LANGFUSE_PROMPTS = 'true';
		process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-status-public';
		process.env.LANGFUSE_SECRET_KEY = '';
		promptReadiness.resetPromptReadinessForTesting();

		try {
			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.dependencies.langfuse).toMatchObject({
				enabled: true,
				configured: false,
				ready: false,
				status: 'misconfigured',
			});
		} finally {
			promptReadiness.resetPromptReadinessForTesting();
		}
	});

	it('reports idempotency storage as ephemeral when the gate is off', async () => {
		delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY;
		delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		idempotencyStorageService._resetForTesting();

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.firestoreIdempotency).toBe(false);
		expect(response.body.dependencies.idempotencyStorage).toMatchObject({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'ephemeral',
			backend: 'memory',
		});
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
			waitingCount: expect.any(Number),
			delayedCount: expect.any(Number),
			failedCount: expect.any(Number),
			activeCount: expect.any(Number),
			durableQueuedCount: expect.any(Number),
			// Documented in the OpenAPI JobQueueStatus schema and both Postman
			// success examples, so the endpoint must actually surface it. Asserting
			// here pins the published contract rather than one layer's projection.
			durableScanRotated: expect.any(Boolean),
			durableCycleComplete: expect.any(Boolean),
			// A misconfigured queue has no broker to have a verdict about, so the
			// probe fields stay null rather than reporting a fabricated false.
			brokerReachable: null,
			lastBrokerProbeAt: null,
			lastBrokerProbeErrorCode: null,
			backlogAlert: {
				active: false,
				thresholdMs: expect.any(Number),
			},
		});
		expect(JSON.stringify(response.body.dependencies.jobExecutionQueue)).not.toContain('redis://');
	});

	it('reports the broker probe verdict so a render-worker cutover is verifiable', async () => {
		const { jobQueue } = require('../../src/services/jobs/JobQueue');
		const probe = jest.spyOn(jobQueue, 'probeBrokerReadiness').mockResolvedValue({ reachable: true });

		try {
			process.env.JOB_EXECUTION_MODE = 'render-worker';
			process.env.REDIS_URL = 'redis://queue.example:6379';
			// Mirrors a healthy boot probe without needing a live Redis in the suite.
			jobQueue.queueReady = true;
			jobQueue.brokerProbe = {
				reachable: true,
				lastProbeAt: '2026-10-04T12:00:00.000Z',
				lastErrorCode: null,
			};

			const response = await request(app)
				.get('/api/capabilities')
				.set('x-api-key', 'status-key');

			expect(response.status).toBe(200);
			expect(response.body.featureFlags.jobExecutionWorker).toBe(true);
			// This is the payload issue #1117 asks an operator to check after the
			// cutover; it has to read "ready" without a job having been enqueued.
			expect(response.body.dependencies.jobExecutionQueue).toMatchObject({
				mode: 'render-worker',
				enabled: true,
				configured: true,
				ready: true,
				status: 'ready',
				brokerReachable: true,
				lastBrokerProbeAt: '2026-10-04T12:00:00.000Z',
				lastBrokerProbeErrorCode: null,
			});
			expect(JSON.stringify(response.body.dependencies.jobExecutionQueue)).not.toContain('redis://');
		} finally {
			probe.mockRestore();
			jobQueue.queueReady = false;
			jobQueue.brokerProbe = { reachable: null, lastProbeAt: null, lastErrorCode: null };
			delete process.env.REDIS_URL;
		}
	});

	it('reports an unreachable broker as distinct from an unprobed one', async () => {
		const { jobQueue } = require('../../src/services/jobs/JobQueue');

		try {
			process.env.JOB_EXECUTION_MODE = 'render-worker';
			process.env.REDIS_URL = 'redis://queue.example:6379';
			jobQueue.brokerProbe = {
				reachable: false,
				lastProbeAt: '2026-10-04T12:00:00.000Z',
				lastErrorCode: 'JOB_QUEUE_PROBE_TIMEOUT',
			};

			const response = await request(app)
				.get('/api/status')
				.set('x-api-key', 'status-key');

			// `configured` only proves REDIS_URL is a non-empty string, so without a
			// distinct verdict an operator cannot tell this from a healthy cutover.
			expect(response.body.dependencies.jobExecutionQueue).toMatchObject({
				configured: true,
				ready: false,
				status: 'unreachable',
				brokerReachable: false,
				lastBrokerProbeErrorCode: 'JOB_QUEUE_PROBE_TIMEOUT',
			});
			expect(JSON.stringify(response.body.dependencies.jobExecutionQueue)).not.toContain('queue.example');
		} finally {
			jobQueue.brokerProbe = { reachable: null, lastProbeAt: null, lastErrorCode: null };
			delete process.env.REDIS_URL;
		}
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
			windowStartedAt: expect.any(String),
			windowDurationMs: 60000,
			requestsInWindow: 0,
			exhaustedEventsInWindow: 1,
			lastExhaustedAt: expect.any(String),
			quotaStatus: 'exhausted',
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
			windowStartedAt: null,
			windowDurationMs: 60000,
			requestsInWindow: 0,
			exhaustedEventsInWindow: 0,
			lastExhaustedAt: null,
			quotaStatus: 'healthy',
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

	it('reports news monitor volume tracking status and window usage', async () => {
		process.env.ENABLE_NEWS_MONITOR = 'true';
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitor).toEqual(
			expect.objectContaining({
				enabled: true,
				paused: false,
				alertsDelivered: 0,
				alertsThrottled: 0,
				windowResetsAt: expect.any(String),
			}),
		);
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
			errorCategoryCounts: {
				circuit_breaker_open: 0,
				http_5xx: 0,
				http_4xx: 0,
				timeout: 0,
				invalid_response: 0,
				request_failed: 0,
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

	// ── Issue #1285 ──────────────────────────────────────────────────────────
	// `ready` used to be derived from credential *shape* alone, so a deployment
	// whose writes succeeded while every ordered read was rejected still reported
	// `ready: true`. These pin the read-aware verdict.
	it('omits firestoreReadMetrics until a read has actually been observed', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies).not.toHaveProperty('firestoreReadMetrics');
	});

	it('reports Firestore not ready with a sanitized category when the read path is broken', async () => {
		firestoreWriteMetricsService.recordReadFailure('alerts', 'failed_precondition');

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toMatchObject({
			ready: false,
			status: 'degraded',
			readHealth: 'degraded',
			lastReadErrorCategory: 'failed_precondition',
		});
		expect(response.body.dependencies.firestoreReadMetrics).toMatchObject({
			readHealth: 'degraded',
			readsFailed: 1,
			lastErrorCategory: 'failed_precondition',
		});
		// Alias surface must carry the same verdict.
		const capabilities = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');
		expect(capabilities.body.dependencies.firestore).toMatchObject({
			ready: false,
			status: 'degraded',
		});
	});

	it('keeps Firestore ready when the read path has only ever succeeded', async () => {
		firestoreWriteMetricsService.recordReadSuccess('alerts');

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestore).toMatchObject({
			ready: true,
			status: 'ready',
			readHealth: 'healthy',
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

		expect(serializedBody).not.toContain('secret-bot-token');
		expect(serializedBody).not.toContain('secret-whatsapp-key');
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
		expect(response.body.dependencies.newsMonitorDedup).toMatchObject({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
			mode: 'in-memory',
			backend: null,
		});
		expect(response.body.dependencies.newsMonitorDedup.cacheSize).toBeDefined();
		expect(typeof response.body.dependencies.newsMonitorDedup.cacheSize.entries).toBe('number');
	});

	it('reports news monitor deduplication as persistent (firestore) when enabled', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.newsMonitorDedup).toMatchObject({
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
		expect(response.body.dependencies.newsMonitorDedup).toMatchObject({
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
		expect(response.body.dependencies.newsMonitorDedup).toMatchObject({
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
			workerRole: 'web',
			running: false,
			pendingCount: 0,
			zeroChannelBroadcasts: 0,
			lastSweepAt: null,
			lastSweepResult: null,
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
			workerRole: 'worker',
			batchLimit: 50,
			maxAttempts: 5,
			zeroChannelBroadcasts: 0,
		});
		expect(enabledResponse.body.dependencies.notificationRedrive.lastSweepAt).toBeNull();
		expect(enabledResponse.body.dependencies.notificationRedrive.lastSweepResult).toBeNull();
	});

	it('reports operator-intent channel configuration for zero-channel triage (GH-713)', async () => {
		// Nothing configured: every channel must be listed as unconfigured so an operator
		// can tell "never configured" apart from "configured but failing".
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		delete process.env.BOT_TOKEN;
		delete process.env.TELEGRAM_CHAT_ID;
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		delete process.env.WHATSAPP_API_URL;
		delete process.env.WHATSAPP_API_KEY;
		delete process.env.WHATSAPP_CHAT_ID;
		process.env.ENABLE_DISCORD_ALERTS = 'true';
		delete process.env.DISCORD_WEBHOOK_URL;

		const unconfiguredResponse = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(unconfiguredResponse.status).toBe(200);
		expect(unconfiguredResponse.body.notificationChannelIntent).toEqual({
			configured: [],
			unconfigured: expect.arrayContaining(['telegram', 'whatsapp', 'discord']),
		});

		// Configure Discord only: intent must be Discord-configured, Telegram/WhatsApp unconfigured.
		process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/abc';
		const partialResponse = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(partialResponse.status).toBe(200);
		expect(partialResponse.body.notificationChannelIntent).toEqual({
			configured: ['discord'],
			unconfigured: expect.arrayContaining(['telegram', 'whatsapp']),
		});

		// Intent mirrors NotificationChannel.isConfigured() = enable flag AND
		// credentials (dependencyStatus.ready). A channel whose webhook URL is set
		// but whose ENABLE_DISCORD_ALERTS flag is off is therefore NOT configured
		// by operator intent — the same verdict the zero-channel page reaches,
		// since it calls that same method. Reporting it as configured here would
		// contradict the page that reported it as unconfigured.
		process.env.ENABLE_DISCORD_ALERTS = 'false';
		const flagDisabledResponse = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(flagDisabledResponse.body.dependencies.discord.configured).toBe(true);
		expect(flagDisabledResponse.body.dependencies.discord.ready).toBe(false);
		expect(flagDisabledResponse.body.notificationChannelIntent.configured).toEqual([]);
		expect(flagDisabledResponse.body.notificationChannelIntent.unconfigured)
			.toEqual(expect.arrayContaining(['telegram', 'whatsapp', 'discord']));
	});

	it('waits for the initial notification redrive heartbeat before serializing status', async () => {
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'web';
		const statusController = require('../../src/controllers/status');
		const service = require('../../src/services/notification/NotificationRedriveService').notificationRedriveService;
		let releaseSync;
		let responseSettled = false;
		const response = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn(),
		};
		const getFirestoreSpy = jest.spyOn(service, 'getFirestore').mockReturnValue({});
		const getStatusSpy = jest.spyOn(service, 'getStatus');
		const syncSpy = jest.spyOn(service, 'syncWorkerTelemetry').mockImplementation(() => new Promise((resolve) => {
			releaseSync = () => {
				service.persistedPendingCount = 6;
				service.persistedLastSweepAt = new Date('2026-09-14T08:00:00.000Z');
				resolve(true);
			};
		}));

		try {
			const responsePromise = Promise.resolve(statusController.getApiStatus({}, response))
				.then(() => {
					responseSettled = true;
				});
			await new Promise((resolve) => setImmediate(resolve));
			expect(syncSpy).toHaveBeenCalledTimes(1);
			expect(responseSettled).toBe(false);

			releaseSync();
			await responsePromise;
			expect(response.status).toHaveBeenCalledWith(200);
			expect(response.json).toHaveBeenCalledTimes(1);
			expect(getStatusSpy).toHaveBeenCalledWith({ skipTelemetrySync: true });
			expect(syncSpy).toHaveBeenCalledTimes(1);
			expect(response.json.mock.calls[0][0].dependencies.notificationRedrive.pendingCount).toBe(6);
			expect(response.json.mock.calls[0][0].dependencies.notificationRedrive.lastSweepAt).toBe('2026-09-14T08:00:00.000Z');
		} finally {
			releaseSync?.();
			syncSpy.mockRestore();
			getStatusSpy.mockRestore();
			getFirestoreSpy.mockRestore();
			service._resetForTesting();
		}
	});

	it('exposes structured lastSweepResult with processed/succeeded/exhausted/errors after a sweep', async () => {
		process.env.ENABLE_NOTIFICATION_REDRIVE = 'true';
		process.env.NOTIFICATION_REDRIVE_WORKER_ROLE = 'web';
		const service = require('../../src/services/notification/NotificationRedriveService').notificationRedriveService;
		service.lastSweepAt = new Date('2026-08-30T00:00:00.000Z');
		service.lastSweepResult = {
			processed: 8,
			succeeded: 3,
			exhausted: 2,
			errors: 1,
		};

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.notificationRedrive.lastSweepAt).toBe('2026-08-30T00:00:00.000Z');
		expect(response.body.dependencies.notificationRedrive.lastSweepResult).toEqual({
			processed: 8,
			succeeded: 3,
			exhausted: 2,
			errors: 1,
		});
		service._resetForTesting();
	});

	it('reports testAlert feature flag and dependency status', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.featureFlags.testAlert).toBe(true);
		expect(response.body.dependencies.testAlert).toEqual({
			enabled: true,
			lastRunAt: null,
			lastRunStatus: null,
			rateLimitState: {
				windowMs: 60000,
				dailyLimit: 30,
				dailyRunsToday: 0,
			},
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

	it('omits firestoreWriteMetrics when no writes have been recorded', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies).not.toHaveProperty('firestoreWriteMetrics');
	});

	it('exposes firestoreWriteMetrics counters after alert and job writes', async () => {
		firestoreWriteMetricsService.recordWriteSuccess('alerts');
		firestoreWriteMetricsService.recordWriteSuccess('alerts');
		firestoreWriteMetricsService.recordWriteFailure('alerts');
		firestoreWriteMetricsService.recordWriteSuccess('jobs');
		firestoreWriteMetricsService.recordWriteFailure('jobs');

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		const metrics = response.body.dependencies.firestoreWriteMetrics;
		expect(metrics).toEqual(expect.objectContaining({
			writesAttempted: 5,
			writesSucceeded: 3,
			writesFailed: 2,
			successRate: 3 / 5,
			window: expect.objectContaining({
				startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
				durationMs: expect.any(Number),
			}),
			byDomain: expect.objectContaining({
				alerts: expect.objectContaining({ success: 2, failure: 1, total: 3, successRate: 2 / 3 }),
				jobs: expect.objectContaining({ success: 1, failure: 1, total: 2, successRate: 0.5 }),
			}),
		}));
	});

	it('aliases /api/capabilities to expose firestoreWriteMetrics', async () => {
		firestoreWriteMetricsService.recordWriteSuccess('alerts');

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.firestoreWriteMetrics).toEqual(expect.objectContaining({
			writesSucceeded: 1,
			writesFailed: 0,
		}));
	});

	it('invokes tokenCostBudgetService.syncSharedSpendThrottled before returning status', async () => {
		const { tokenCostBudgetService } = require('../../src/lib/tokenUsage');
		const syncSpy = jest.spyOn(tokenCostBudgetService, 'syncSharedSpendThrottled').mockResolvedValue();

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(syncSpy).toHaveBeenCalled();
	});


	it('exposes per-tool metrics for TradingView MCP calls in dependencies.tradingViewMcp', async () => {
		tradingViewMcpService._recordToolSuccess('coin_analysis', 150);
		tradingViewMcpService._recordToolSuccess('coin_analysis', 250);
		tradingViewMcpService._recordToolFailure('volume_confirmation_analysis', 500, new Error('ETIMEDOUT: request timed out'));

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.tradingViewMcp.toolMetrics).toEqual({
			coin_analysis: {
				callCount: 2,
				successCount: 2,
				failureCount: 0,
				timeoutCount: 0,
				totalDurationMs: 400,
				averageDurationMs: 200,
				lastCallAt: expect.any(String),
				lastErrorCategory: null,
			},
			volume_confirmation_analysis: {
				callCount: 1,
				successCount: 0,
				failureCount: 1,
				timeoutCount: 1,
				totalDurationMs: 500,
				averageDurationMs: 500,
				lastCallAt: expect.any(String),
				lastErrorCategory: 'timeout',
			},
		});
	});

	it('aliases /api/capabilities to expose TradingView MCP toolMetrics', async () => {
		tradingViewMcpService._recordToolSuccess('coin_analysis', 100);

		const response = await request(app)
			.get('/api/capabilities')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.tradingViewMcp.toolMetrics).toEqual({
			coin_analysis: {
				callCount: 1,
				successCount: 1,
				failureCount: 0,
				timeoutCount: 0,
				totalDurationMs: 100,
				averageDurationMs: 100,
				lastCallAt: expect.any(String),
				lastErrorCategory: null,
			},
		});
	});

	it('omits TradingView MCP toolMetrics when ENABLE_TRADINGVIEW_MCP_ENRICHMENT is false', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
		tradingViewMcpService._recordToolSuccess('coin_analysis', 100);

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.tradingViewMcp.toolMetrics).toBeUndefined();
	});

	it('exposes grounding operational metrics in /api/status when ENABLE_GEMINI_GROUNDING is true', async () => {
		groundingMetrics.recordSuccess(100, 'ALERT_ENRICHMENT');
		groundingMetrics.recordFailure('error', new Error('API error'), 'ALERT_ENRICHMENT');

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.grounding).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
			metrics: {
				totalRequests: 2,
				successRequests: 1,
				failureRequests: 1,
				timeoutRequests: 0,
				successRate: 0.5,
				uptimeSince: expect.any(String),
			},
		});
	});

	it('omits grounding section when ENABLE_GEMINI_GROUNDING is disabled', async () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies).not.toHaveProperty('grounding');
	});

	it('reports grounding as misconfigured when credentials are missing but grounding is enabled', async () => {
		delete process.env.GEMINI_API_KEY;

		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'status-key');

		expect(response.status).toBe(200);
		expect(response.body.dependencies.grounding).toEqual({
			enabled: true,
			configured: false,
			ready: false,
			status: 'misconfigured',
			metrics: expect.objectContaining({
				totalRequests: 0,
				successRequests: 0,
				failureRequests: 0,
				timeoutRequests: 0,
				successRate: 0,
				uptimeSince: expect.any(String),
			}),
		});
	});
});
