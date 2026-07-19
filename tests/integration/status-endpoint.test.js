const { mkdtempSync, rmSync, writeFileSync } = require('fs');
const request = require('supertest');
const express = require('express');
const { generateKeyPairSync } = require('crypto');
const { tmpdir } = require('os');
const { join } = require('path');
const { getRoutes } = require('../../src/routes');

const testPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});
const validFirestoreServiceAccountJson = JSON.stringify({
	project_id: 'x',
	client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
	private_key: testPrivateKey,
});

describe('Status endpoints', () => {
	const originalEnv = { ...process.env };
	let app;
	let tempDir;

	beforeEach(() => {
		Object.keys(process.env).forEach((key) => {
			delete process.env[key];
		});
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
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);

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
		expect(response.body.deliveryChannels.telegram).toEqual({ enabled: true, status: 'ready' });
		expect(response.body.dependencies.gemini).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
		expect(response.body.dependencies.tradingViewMcp).toEqual({
			enabled: true,
			configured: true,
			ready: true,
			status: 'ready',
		});
		expect(response.body.dependencies.braveSearch).toEqual({
			enabled: false,
			configured: false,
			ready: false,
			status: 'disabled',
		});
		expect(response.body.dependencies.sentry.status).toBe('ready');
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
		});
	});

	it('reports Firestore job storage as disabled by default', async () => {
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

	it('reports Firestore job storage readiness when enabled', async () => {
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
			ready: true,
			status: 'ready',
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
			ready: true,
			status: 'ready',
		});
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
});
