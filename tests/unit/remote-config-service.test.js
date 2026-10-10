const fs = require('fs');
const path = require('path');

const admin = require('firebase-admin');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const { isFirestoreConfigured } = require('../../src/services/storage/firestoreConfig');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

jest.mock('firebase-admin', () => ({
	remoteConfig: jest.fn(),
}));

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	getFirestore: jest.fn(),
}));

jest.mock('../../src/services/storage/firestoreConfig', () => ({
	isFirestoreConfigured: jest.fn(() => true),
}));

describe('RemoteConfigService', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'false';
		process.env.NEWS_ALERT_THRESHOLD = '0.7';
		process.env.TRADINGVIEW_MCP_TIMEOUT_MS = '12000';
		jest.clearAllMocks();
		isFirestoreConfigured.mockReturnValue(true);
		remoteConfigService._resetForTesting();
	});

	afterEach(() => {
		remoteConfigService.stop();
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		Object.assign(process.env, savedEnv);
	});

	function mockTemplate(values, { versionNumber = '7', load = jest.fn().mockResolvedValue(undefined) } = {}) {
		const template = {
			load,
			evaluate: jest.fn(() => ({
				getNumber: jest.fn((key) => values[key]),
				getBoolean: jest.fn((key) => values[key]),
				getValue: jest.fn((key) => ({
					getSource: jest.fn(() => Object.prototype.hasOwnProperty.call(values, key) ? 'remote' : 'default'),
					asString: jest.fn(() => String(values[key] ?? '')),
				})),
			})),
			toJSON: jest.fn(() => ({ version: { versionNumber } })),
		};
		const initServerTemplate = jest.fn(() => template);
		admin.remoteConfig.mockReturnValue({ initServerTemplate });
		return { template, initServerTemplate };
	}

	it('keeps environment behavior and performs no fetch when disabled', async () => {
		await remoteConfigService.start();

		expect(remoteConfigService.getRuntimeConfig().NEWS_ALERT_THRESHOLD).toBe(0.7);
		expect(remoteConfigService.getRuntimeConfig().TRADINGVIEW_MCP_TIMEOUT_MS).toBe(12000);
		expect(admin.remoteConfig).not.toHaveBeenCalled();
	});

	it('falls back to bounded defaults for invalid TradingView MCP environment values', () => {
		[
			['TRADINGVIEW_MCP_TIMEOUT_MS', 'not-a-number', 12000],
			['TRADINGVIEW_MCP_MAX_RETRIES', '0', 3],
			['TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS', 'Infinity', 12000],
			['EXPANDED_ANALYSIS_ALERT_CONCURRENCY', '0', 3],
			['EXPANDED_ANALYSIS_ALERT_CONCURRENCY', '11', 3],
			['TRADINGVIEW_MCP_TIMEOUT_MS', '999', 12000],
			['TRADINGVIEW_MCP_MAX_RETRIES', '6', 3],
			['TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS', '-1', 12000],
			['REQUEST_TIMEOUT_MS', 'not-a-number', 30000],
			['REQUEST_TIMEOUT_MS', '999', 30000],
			['REQUEST_TIMEOUT_MS', '120001', 30000],
			['ALERT_SCHEDULER_INTERVAL_MS', 'not-a-number', 60000],
			['ALERT_SCHEDULER_INTERVAL_MS', '500', 60000],
			['ALERT_SCHEDULER_INTERVAL_MS', '4000000', 60000],
			['ALERT_SCHEDULER_BATCH_LIMIT', '0', 10],
			['ALERT_SCHEDULER_BATCH_LIMIT', '101', 10],
		].forEach(([key, value, expected]) => {
			process.env[key] = value;
			expect(remoteConfigService.getRuntimeConfig()[key]).toBe(expected);
		});
	});

	it('preserves valid environment values when Remote Config is disabled', async () => {
		process.env.NEWS_ALERT_THRESHOLD = '1.5';
		process.env.NEWS_TIMEOUT_MS = '180000';
		process.env.NEWS_GEMINI_CONCURRENCY = '9';
		process.env.TRADINGVIEW_MCP_TIMEOUT_MS = '15000';
		process.env.TRADINGVIEW_MCP_MAX_RETRIES = '4';
		process.env.TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS = '20000';
		process.env.EXPANDED_ANALYSIS_ALERT_CONCURRENCY = '2';
		process.env.REQUEST_TIMEOUT_MS = '45000';

		await remoteConfigService.start();

		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			NEWS_ALERT_THRESHOLD: 1.5,
			NEWS_TIMEOUT_MS: 180000,
			NEWS_GEMINI_CONCURRENCY: 9,
			TRADINGVIEW_MCP_TIMEOUT_MS: 15000,
			TRADINGVIEW_MCP_MAX_RETRIES: 4,
			TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS: 20000,
			EXPANDED_ANALYSIS_ALERT_CONCURRENCY: 2,
			REQUEST_TIMEOUT_MS: 45000,
		}));
	});

	it('accepts the documented TradingView MCP environment boundaries', () => {
		process.env.TRADINGVIEW_MCP_TIMEOUT_MS = '1000';
		process.env.TRADINGVIEW_MCP_MAX_RETRIES = '5';
		process.env.TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS = '120000';

		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			TRADINGVIEW_MCP_TIMEOUT_MS: 1000,
			TRADINGVIEW_MCP_MAX_RETRIES: 5,
			TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS: 120000,
		}));
	});

	it('preserves environment values above Remote Config override bounds', () => {
		process.env.WEBHOOK_IDEMPOTENCY_TTL_MS = '604800000';

		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			WEBHOOK_IDEMPOTENCY_TTL_MS: 604800000,
		}));
	});

	it('rejects out-of-range remote overrides without discarding environment values', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.WEBHOOK_IDEMPOTENCY_TTL_MS = '604800000';
		mockTemplate({
			WEBHOOK_IDEMPOTENCY_TTL_MS: 604800001,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			WEBHOOK_IDEMPOTENCY_TTL_MS: 604800000,
		}));
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('invalid_value');
	});

	it('rejects invalid remote entry-price chains and preserves the environment chain', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES = 'binance';
		mockTemplate({ SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES: 'wat' });
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		expect(remoteConfigService.getRuntimeConfig().SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES).toBe('binance');
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('invalid_value');
	});

	/**
	 * `firebase-remote-config-template.json` publishes
	 * `SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES` with an intentional empty default,
	 * which is exactly that parameter's schema default. A blank remote value
	 * carries no tuning, so it must not be reported as a misconfiguration: once
	 * the production template is published this would otherwise pin
	 * `lastErrorCategory: "invalid_value"` on every load and make a genuinely
	 * malformed value indistinguishable from the shipped default.
	 */
	it('treats a blank remote value as no override instead of an invalid value', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES = '';
		const template = JSON.parse(fs.readFileSync(
			path.join(__dirname, '../../firebase-remote-config-template.json'),
			'utf8',
		));
		mockTemplate({
			SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES: '',
			NEWS_ALERT_THRESHOLD: 0.75,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		expect(template.parameters.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES.defaultValue.value).toBe('');
		await remoteConfigService.loadNow();

		expect(remoteConfigService.getStatus().lastErrorCategory).toBeNull();
		expect(remoteConfigService.getStatus().ready).toBe(true);
		expect(remoteConfigService.getStatus().source).toBe('remote');
		expect(remoteConfigService.getRuntimeConfig().NEWS_ALERT_THRESHOLD).toBe(0.75);
	});

	it('applies validated allow-listed values and records safe template metadata', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '{"not-a-secret":"redacted-in-test"}';
		const { template, initServerTemplate } = mockTemplate({
			NEWS_ALERT_THRESHOLD: 0.85,
			TRADINGVIEW_MCP_TIMEOUT_MS: 15000,
			ENABLE_MESSAGE_FOOTER_METADATA: false,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		expect(template.load).toHaveBeenCalledTimes(1);
		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			NEWS_ALERT_THRESHOLD: 0.85,
			TRADINGVIEW_MCP_TIMEOUT_MS: 15000,
			ENABLE_MESSAGE_FOOTER_METADATA: false,
		}));
		expect(initServerTemplate).toHaveBeenCalledWith(expect.objectContaining({
			defaultConfig: expect.objectContaining({ NEWS_ALERT_THRESHOLD: '0.7' }),
		}));
		const defaultConfig = initServerTemplate.mock.calls[0][0].defaultConfig;
		expect(defaultConfig).not.toHaveProperty('FIREBASE_SERVICE_ACCOUNT_JSON');
		expect(remoteConfigService.getStatus()).toEqual(expect.objectContaining({
			enabled: true,
			source: 'remote',
			templateVersion: '7',
			lastErrorCategory: null,
			lastSuccessfulLoad: expect.any(String),
		}));

		remoteConfigService.getRuntimeConfig();
		remoteConfigService.getRuntimeConfig();
		expect(template.load).toHaveBeenCalledTimes(1);
	});

	it('rejects out-of-range remote values and preserves environment fallbacks', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.NEWS_ALERT_THRESHOLD = '0.65';
		process.env.TRADINGVIEW_MCP_TIMEOUT_MS = '9000';
		mockTemplate({
			NEWS_ALERT_THRESHOLD: 1.5,
			TRADINGVIEW_MCP_TIMEOUT_MS: -1,
			NEWS_GEMINI_QUOTA_MAX_RETRIES: Number.NaN,
			WEBHOOK_API_KEY: 'must-never-be-read',
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			NEWS_ALERT_THRESHOLD: 0.65,
			TRADINGVIEW_MCP_TIMEOUT_MS: 9000,
		}));
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('invalid_value');
	});

	it('validates raw remote values before typed coercion', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.NEWS_ALERT_THRESHOLD = '0.65';
		process.env.ENABLE_MESSAGE_FOOTER_METADATA = 'true';
		const template = {
			load: jest.fn().mockResolvedValue(undefined),
			evaluate: jest.fn(() => ({
				getNumber: jest.fn(() => 0),
				getBoolean: jest.fn(() => false),
				getValue: jest.fn((key) => {
					const rawValues = {
						NEWS_ALERT_THRESHOLD: 'not-a-number',
						ENABLE_MESSAGE_FOOTER_METADATA: 'not-a-boolean',
					};
					const rawValue = rawValues[key];
					return {
						getSource: jest.fn(() => rawValue === undefined ? 'default' : 'remote'),
						asString: jest.fn(() => rawValue ?? ''),
					};
				}),
			})),
			toJSON: jest.fn(() => ({ version: { versionNumber: '8' } })),
		};
		admin.remoteConfig.mockReturnValue({ initServerTemplate: jest.fn(() => template) });
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			NEWS_ALERT_THRESHOLD: 0.65,
			ENABLE_MESSAGE_FOOTER_METADATA: true,
			NEWS_GEMINI_CONCURRENCY: Infinity,
		}));
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('invalid_value');
	});

	it('fails open when the Remote Config template load rejects', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		const load = jest.fn().mockRejectedValue(new Error('permission denied'));
		mockTemplate({}, { load });
		alertStorageService.getFirestore.mockReturnValue({});

		await expect(remoteConfigService.loadNow()).resolves.toBe(false);

		expect(remoteConfigService.getRuntimeConfig().NEWS_ALERT_THRESHOLD).toBe(0.7);
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('load_failed');
	});

	it('fails open on load timeout and expires cached overrides', async () => {
		jest.useFakeTimers();
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.FIREBASE_REMOTE_CONFIG_MAX_AGE_MS = '10';
		const load = jest.fn(() => new Promise(() => {}));
		mockTemplate({ NEWS_ALERT_THRESHOLD: 0.9 }, { load });
		alertStorageService.getFirestore.mockReturnValue({});

		const loadPromise = remoteConfigService.loadNow({ timeoutMs: 5 });
		await jest.advanceTimersByTimeAsync(5);
		await loadPromise;

		expect(remoteConfigService.getRuntimeConfig().NEWS_ALERT_THRESHOLD).toBe(0.7);
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('timeout');

		remoteConfigService._setRemoteOverridesForTesting({ NEWS_ALERT_THRESHOLD: 0.9 }, Date.now());
		expect(remoteConfigService.getRuntimeConfig().NEWS_ALERT_THRESHOLD).toBe(0.9);
		jest.advanceTimersByTime(11);
		expect(remoteConfigService.getRuntimeConfig().NEWS_ALERT_THRESHOLD).toBe(0.7);
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('stale');
		jest.useRealTimers();
	});

	it('validates string enum parameters like TRADINGVIEW_MCP_DEFAULT_TIMEFRAME', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		mockTemplate({
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '15m',
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();
		expect(remoteConfigService.getRuntimeConfig().TRADINGVIEW_MCP_DEFAULT_TIMEFRAME).toBe('15m');

		// Invalid enum value should be rejected and fall back to env/default
		mockTemplate({
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: 'invalid-timeframe',
		});
		await remoteConfigService.loadNow();
		expect(remoteConfigService.getRuntimeConfig().TRADINGVIEW_MCP_DEFAULT_TIMEFRAME).toBe('1h');
		expect(remoteConfigService.getStatus().lastErrorCategory).toBe('invalid_value');
	});

	it('validates and applies expanded operational parameters from remote config', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		mockTemplate({
			GROUNDING_MAX_SOURCES: 5,
			GROUNDING_TIMEOUT_MS: 45000,
			GROUNDING_MAX_LENGTH: 3000,
			ALERT_GROUNDING_COALESCE_MS: 2500,
			NEWS_CACHE_TTL_HOURS: 12,
			BINANCE_FETCH_TIMEOUT_MS: 8000,
			EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS: 90000,
			EXPANDED_ANALYSIS_ALERT_CONCURRENCY: 4,
			DISCORD_MAX_RETRIES: 5,
			DISCORD_FALLBACK_RETRY_DELAY_MS: 1000,
			DISCORD_MAX_RETRY_DELAY_MS: 8000,
			DISCORD_MAX_TOTAL_RETRY_WAIT_MS: 20000,
			WEBHOOK_IDEMPOTENCY_TTL_MS: 600000,
			JOB_CALLBACK_RETRY_DELAY_MS: 2500,
			JOB_POLL_INTERVAL_MS: 20000,
			SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT: 100,
			SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS: 60000,
			SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS: 5,
			SIGNAL_OUTCOME_MAX_RETRY_AGE_MS: 1209600000,
			EQUITY_MARKET_DATA_RPM: 12,
			NOTIFICATION_REDRIVE_INTERVAL_MS: 120000,
			NOTIFICATION_REDRIVE_BATCH_LIMIT: 75,
			NOTIFICATION_REDRIVE_MAX_ATTEMPTS: 8,
			NOTIFICATION_REDRIVE_MAX_AGE_MS: 7200000,
			TRADINGVIEW_MCP_BREAKER_FAILURE_THRESHOLD: 10,
			TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS: 300000,
			TRADINGVIEW_MCP_PAGE_COOLDOWN_MS: 1800000,
			NEWS_MAX_ALERTS_PER_BATCH: 15,
			NEWS_MAX_ALERTS_PER_WINDOW: 30,
			NEWS_MAX_ALERTS_PER_WINDOW_MS: 600000,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		const config = remoteConfigService.getRuntimeConfig();
		expect(config.NEWS_MAX_ALERTS_PER_BATCH).toBe(15);
		expect(config.NEWS_MAX_ALERTS_PER_WINDOW).toBe(30);
		expect(config.NEWS_MAX_ALERTS_PER_WINDOW_MS).toBe(600000);
		expect(config.GROUNDING_MAX_SOURCES).toBe(5);
		expect(config.GROUNDING_TIMEOUT_MS).toBe(45000);
		expect(config.GROUNDING_MAX_LENGTH).toBe(3000);
		expect(config.ALERT_GROUNDING_COALESCE_MS).toBe(2500);
		expect(config.NEWS_CACHE_TTL_HOURS).toBe(12);
		expect(config.BINANCE_FETCH_TIMEOUT_MS).toBe(8000);
		expect(config.EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS).toBe(90000);
		expect(config.EXPANDED_ANALYSIS_ALERT_CONCURRENCY).toBe(4);
		expect(config.DISCORD_MAX_RETRIES).toBe(5);
		expect(config.DISCORD_FALLBACK_RETRY_DELAY_MS).toBe(1000);
		expect(config.DISCORD_MAX_RETRY_DELAY_MS).toBe(8000);
		expect(config.DISCORD_MAX_TOTAL_RETRY_WAIT_MS).toBe(20000);
		expect(config.WEBHOOK_IDEMPOTENCY_TTL_MS).toBe(600000);
		expect(config.JOB_CALLBACK_RETRY_DELAY_MS).toBe(2500);
		expect(config.JOB_POLL_INTERVAL_MS).toBe(20000);
		expect(config.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT).toBe(100);
		expect(config.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS).toBe(60000);
		expect(config.SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS).toBe(5);
		expect(config.SIGNAL_OUTCOME_MAX_RETRY_AGE_MS).toBe(1209600000);
		expect(config.EQUITY_MARKET_DATA_RPM).toBe(12);
		expect(config.NOTIFICATION_REDRIVE_INTERVAL_MS).toBe(120000);
		expect(config.NOTIFICATION_REDRIVE_BATCH_LIMIT).toBe(75);
		expect(config.NOTIFICATION_REDRIVE_MAX_ATTEMPTS).toBe(8);
		expect(config.NOTIFICATION_REDRIVE_MAX_AGE_MS).toBe(7200000);
		expect(config.TRADINGVIEW_MCP_BREAKER_FAILURE_THRESHOLD).toBe(10);
		expect(config.TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS).toBe(300000);
		expect(config.TRADINGVIEW_MCP_PAGE_COOLDOWN_MS).toBe(1800000);
	});

	it('validates and applies safe request-time feature flags from remote config', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		mockTemplate({
			ENABLE_GEMINI_GROUNDING: true,
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: true,
			ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION: true,
			ENABLE_MARKET_SCANNER: true,
			ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP: true,
			ENABLE_ALERT_HTF_RENDER: false,
			ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT: true,
			ENABLE_FIRESTORE_CHAT_PREFERENCES: true,
			CHAT_PREFERENCES_RETENTION_DAYS: 45,
			CHAT_PREFERENCES_CACHE_TTL_MS: 30000,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		const config = remoteConfigService.getRuntimeConfig();
		expect(config.ENABLE_GEMINI_GROUNDING).toBe(true);
		expect(config.ENABLE_TRADINGVIEW_MCP_ENRICHMENT).toBe(true);
		expect(config.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION).toBe(true);
		expect(config.ENABLE_MARKET_SCANNER).toBe(true);
		expect(config.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP).toBe(true);
		expect(config.ENABLE_ALERT_HTF_RENDER).toBe(false);
		expect(config.ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT).toBe(true);
		expect(config.ENABLE_FIRESTORE_CHAT_PREFERENCES).toBe(true);
		expect(config.CHAT_PREFERENCES_RETENTION_DAYS).toBe(45);
		expect(config.CHAT_PREFERENCES_CACHE_TTL_MS).toBe(30000);
	});

	it('keeps the startup-only signal outcome cadence out of Remote Config', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS = '60000';
		mockTemplate({ SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS: 120000 });
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		expect(remoteConfigService.PARAMETER_SCHEMA).not.toHaveProperty('SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS');
		expect(remoteConfigService.getRuntimeConfig()).not.toHaveProperty('SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS');
	});

	it('keeps test-alert security controls and enablement gate out of Remote Config', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.ENABLE_TEST_ALERT = 'true';
		process.env.TEST_ALERT_DAILY_LIMIT = '30';
		mockTemplate({ ENABLE_TEST_ALERT: false, TEST_ALERT_DAILY_LIMIT: 50 });
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		expect(remoteConfigService.PARAMETER_SCHEMA).not.toHaveProperty('ENABLE_TEST_ALERT');
		expect(remoteConfigService.PARAMETER_SCHEMA).not.toHaveProperty('TEST_ALERT_DAILY_LIMIT');
		expect(remoteConfigService.getRuntimeConfig()).not.toHaveProperty('ENABLE_TEST_ALERT');
		expect(remoteConfigService.getRuntimeConfig()).not.toHaveProperty('TEST_ALERT_DAILY_LIMIT');
	});

	it('keeps the request-time signal outcome entry-price chain eligible for Remote Config', () => {
		process.env.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES = 'mcp,binance,gemini';

		expect(remoteConfigService.PARAMETER_SCHEMA.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES).toEqual(expect.objectContaining({
			type: 'string',
			defaultValue: '',
		}));
		expect(remoteConfigService.getRuntimeConfig().SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES).toBe('mcp,binance,gemini');
	});

	it('enforces bounds on new operational parameters in env parsing', () => {
		process.env.GROUNDING_MAX_SOURCES = '50'; // max 20
		process.env.GROUNDING_TIMEOUT_MS = '-5'; // min 1
		process.env.BINANCE_FETCH_TIMEOUT_MS = '100000'; // max 60000
		process.env.DISCORD_MAX_RETRIES = '-1'; // min 0
		process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME = 'unknown'; // invalid enum
		process.env.TRADINGVIEW_MCP_BREAKER_FAILURE_THRESHOLD = '0'; // min 1
		process.env.TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS = '500'; // min 1000
		process.env.TRADINGVIEW_MCP_PAGE_COOLDOWN_MS = '999999999'; // max 86400000
		process.env.SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS = '25'; // max 20
		process.env.SIGNAL_OUTCOME_MAX_RETRY_AGE_MS = '3000000000'; // max 2592000000
		process.env.SIGNAL_OUTCOME_RETENTION_DAYS = '5000'; // max 3650
		process.env.EQUITY_MARKET_DATA_RPM = '2000'; // max 1200
		process.env.URL_SHORTENER_CACHE_MAX_ENTRIES = '500000'; // max 100000
		process.env.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES = '2000'; // max 1024

		const config = remoteConfigService.getRuntimeConfig();
		expect(config.GROUNDING_MAX_SOURCES).toBe(3); // fallback to default
		expect(config.GROUNDING_TIMEOUT_MS).toBe(30000); // fallback to default
		expect(config.BINANCE_FETCH_TIMEOUT_MS).toBe(5000); // fallback to default
		expect(config.DISCORD_MAX_RETRIES).toBe(2); // fallback to default
		expect(config.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME).toBe('1h'); // fallback to default
		expect(config.TRADINGVIEW_MCP_BREAKER_FAILURE_THRESHOLD).toBe(5); // fallback to default
		expect(config.TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS).toBe(600000); // fallback to default
		expect(config.TRADINGVIEW_MCP_PAGE_COOLDOWN_MS).toBe(3600000); // fallback to default
		expect(config.SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS).toBe(3); // fallback to default
		expect(config.SIGNAL_OUTCOME_MAX_RETRY_AGE_MS).toBe(604800000); // fallback to default
		expect(config.SIGNAL_OUTCOME_RETENTION_DAYS).toBe(365); // fallback to default
		expect(config.EQUITY_MARKET_DATA_RPM).toBe(8); // fallback to default
		expect(config.URL_SHORTENER_CACHE_MAX_ENTRIES).toBe(1000); // fallback to default
		expect(config.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES).toBe(32); // fallback to default
	});

	it('supports ZERO_CHANNEL_ALERT_COOLDOWN_MS and ENABLE_API_ONLY_MODE via Remote Config', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		mockTemplate({
			ZERO_CHANNEL_ALERT_COOLDOWN_MS: 600000,
			ENABLE_API_ONLY_MODE: true,
			SIGNAL_OUTCOME_RETENTION_DAYS: 180,
			URL_SHORTENER_CACHE_MAX_ENTRIES: 2000,
			URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES: 64,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		const config = remoteConfigService.getRuntimeConfig();
		expect(config.ZERO_CHANNEL_ALERT_COOLDOWN_MS).toBe(600000);
		expect(config.ENABLE_API_ONLY_MODE).toBe(true);
		expect(config.SIGNAL_OUTCOME_RETENTION_DAYS).toBe(180);
		expect(config.URL_SHORTENER_CACHE_MAX_ENTRIES).toBe(2000);
		expect(config.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES).toBe(64);
	});

	it('validates and applies Admin SSE operational parameters and keeps enablement gate out', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		process.env.ADMIN_SSE_MAX_CLIENT_CONNECTIONS = '3';
		process.env.ADMIN_SSE_MAX_TOTAL_CONNECTIONS = '50';
		process.env.ADMIN_SSE_HEARTBEAT_MS = '20000';
		mockTemplate({
			ADMIN_SSE_MAX_CLIENT_CONNECTIONS: 8,
			ADMIN_SSE_MAX_TOTAL_CONNECTIONS: 200,
			ADMIN_SSE_HEARTBEAT_MS: 15000,
			ENABLE_ADMIN_SSE: true,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		const config = remoteConfigService.getRuntimeConfig();
		expect(config.ADMIN_SSE_MAX_CLIENT_CONNECTIONS).toBe(8);
		expect(config.ADMIN_SSE_MAX_TOTAL_CONNECTIONS).toBe(200);
		expect(config.ADMIN_SSE_HEARTBEAT_MS).toBe(15000);

		expect(remoteConfigService.PARAMETER_SCHEMA).not.toHaveProperty('ENABLE_ADMIN_SSE');
		expect(config).not.toHaveProperty('ENABLE_ADMIN_SSE');
	});

	describe('getStatus readiness and lifecycle states', () => {
		it('reports disabled readiness status when Remote Config is disabled', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'false';
			alertStorageService.getFirestore.mockReturnValue({});

			const status = remoteConfigService.getStatus();
			expect(status).toEqual(expect.objectContaining({
				enabled: false,
				configured: true,
				ready: false,
				status: 'disabled',
				source: 'disabled',
				lastSuccessfulLoad: null,
				lastErrorCategory: null,
				consecutiveFailures: 0,
			}));
		});

		it('reports misconfigured status when Remote Config is enabled but Firestore is not configured', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			isFirestoreConfigured.mockReturnValue(false);
			alertStorageService.getFirestore.mockReturnValue(null);

			const status = remoteConfigService.getStatus();
			expect(status).toEqual(expect.objectContaining({
				enabled: true,
				configured: false,
				ready: false,
				status: 'misconfigured',
				lastSuccessfulLoad: null,
				lastErrorCategory: null,
				consecutiveFailures: 0,
			}));
		});

		it('reports unknown status and ready: false when enabled and configured before initial load attempt', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			alertStorageService.getFirestore.mockReturnValue({});

			const status = remoteConfigService.getStatus();
			expect(status).toEqual(expect.objectContaining({
				enabled: true,
				configured: true,
				ready: false,
				status: 'unknown',
				lastSuccessfulLoad: null,
				lastErrorCategory: null,
				consecutiveFailures: 0,
			}));
		});

		it('reports degraded status and increments consecutiveFailures on load failure', async () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			const load = jest.fn().mockRejectedValue(new Error('Firebase Remote Config template not published'));
			mockTemplate({}, { load });
			alertStorageService.getFirestore.mockReturnValue({});

			await expect(remoteConfigService.loadNow()).resolves.toBe(false);

			const status1 = remoteConfigService.getStatus();
			expect(status1).toEqual(expect.objectContaining({
				enabled: true,
				configured: true,
				ready: false,
				status: 'degraded',
				lastSuccessfulLoad: null,
				lastErrorCategory: 'load_failed',
				consecutiveFailures: 1,
			}));

			// Subsequent failure increments consecutiveFailures
			await expect(remoteConfigService.loadNow()).resolves.toBe(false);
			const status2 = remoteConfigService.getStatus();
			expect(status2.consecutiveFailures).toBe(2);
			expect(status2.ready).toBe(false);
			expect(status2.status).toBe('degraded');
		});

		it('reports ready: true on success, resets consecutiveFailures, and degrades on subsequent failure', async () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			alertStorageService.getFirestore.mockReturnValue({});

			// First, successful load
			const { template } = mockTemplate({ NEWS_ALERT_THRESHOLD: 0.85 }, { versionNumber: '12' });
			await expect(remoteConfigService.loadNow()).resolves.toBe(true);

			const readyStatus = remoteConfigService.getStatus();
			expect(readyStatus).toEqual(expect.objectContaining({
				enabled: true,
				configured: true,
				ready: true,
				status: 'ready',
				source: 'remote',
				templateVersion: '12',
				lastErrorCategory: null,
				consecutiveFailures: 0,
				lastSuccessfulLoad: expect.any(String),
			}));
			const previousSuccessfulLoad = readyStatus.lastSuccessfulLoad;

			// Next, refresh fails
			template.load.mockRejectedValueOnce(new Error('Network error during refresh'));
			await expect(remoteConfigService.loadNow()).resolves.toBe(false);

			const degradedStatus = remoteConfigService.getStatus();
			expect(degradedStatus).toEqual(expect.objectContaining({
				enabled: true,
				configured: true,
				ready: false,
				status: 'degraded',
				lastSuccessfulLoad: previousSuccessfulLoad,
				lastErrorCategory: 'load_failed',
				consecutiveFailures: 1,
			}));

			// Next, refresh recovers
			template.load.mockResolvedValueOnce(undefined);
			await expect(remoteConfigService.loadNow()).resolves.toBe(true);

			const recoveredStatus = remoteConfigService.getStatus();
			expect(recoveredStatus.ready).toBe(true);
			expect(recoveredStatus.status).toBe('ready');
			expect(recoveredStatus.consecutiveFailures).toBe(0);
		});

		it('reports degraded status and stale category when cache max age expires', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			alertStorageService.getFirestore.mockReturnValue({});

			const loadedAt = Date.now() - 3700000; // 3700s ago (> 3600s maxAgeMs)
			remoteConfigService._setRemoteOverridesForTesting({ NEWS_ALERT_THRESHOLD: 0.85 }, loadedAt);

			const status = remoteConfigService.getStatus();
			expect(status).toEqual(expect.objectContaining({
				enabled: true,
				configured: true,
				ready: false,
				status: 'degraded',
				lastErrorCategory: 'stale',
				lastSuccessfulLoad: new Date(loadedAt).toISOString(),
			}));
		});

		it('applies REQUEST_TIMEOUT_MS remote override within bounds', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			remoteConfigService._setRemoteOverridesForTesting({ REQUEST_TIMEOUT_MS: 50000 });

			expect(remoteConfigService.getRuntimeConfig().REQUEST_TIMEOUT_MS).toBe(50000);
		});

		it('maintains parity between PARAMETER_SCHEMA and firebase-remote-config-template.json', () => {
			const fs = require('fs');
			const path = require('path');
			const templatePath = path.join(__dirname, '../../firebase-remote-config-template.json');
			const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

			const schemaKeys = Object.keys(remoteConfigService.PARAMETER_SCHEMA);
			const templateKeys = Object.keys(template.parameters || {});

			for (const key of schemaKeys) {
				expect(templateKeys).toContain(key);
			}
			expect(template.parameters.REQUEST_TIMEOUT_MS).toEqual(expect.objectContaining({
				defaultValue: { value: '30000' },
				valueType: 'NUMBER',
			}));
		});

		// A published template outranks render.yaml for every allow-listed key, so a
		// blueprint value that disagrees with the template is a flag that reports one
		// thing while doing another (issue #1179). Storage gates that decide where a
		// collection lives are excluded from the template entirely instead.
		it('never lets render.yaml and the published template disagree on an allow-listed key', () => {
			const fs = require('fs');
			const path = require('path');
			const root = path.join(__dirname, '../..');
			const template = JSON.parse(fs.readFileSync(path.join(root, 'firebase-remote-config-template.json'), 'utf8'));
			const blueprint = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');

			const blueprintValues = new Map(
				[...blueprint.matchAll(/- key: ([A-Z0-9_]+)\n\s+value: (\S+)/g)].map((match) => [match[1], match[2]]),
			);

			for (const [key, parameter] of Object.entries(template.parameters)) {
				const blueprintValue = blueprintValues.get(key);
				if (blueprintValue === undefined) {
					continue;
				}
				expect({ [key]: parameter.defaultValue.value }).toEqual({ [key]: blueprintValue });
			}
		});

		it('keeps symbol-analysis storage out of Remote Config so the blueprint is authoritative', () => {
			expect(remoteConfigService.PARAMETER_SCHEMA).not.toHaveProperty('ENABLE_SYMBOL_ANALYSIS_STORAGE');
			expect(remoteConfigService.PARAMETER_SCHEMA).not.toHaveProperty('SYMBOL_ANALYSIS_RETENTION_DAYS');
		});

		it('notifies registered change listeners when remote overrides change', () => {
			const listener = jest.fn();
			const unsubscribe = remoteConfigService.addChangeListener(listener);

			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: true }, Date.now(), '42');

			expect(listener).toHaveBeenCalledWith(expect.objectContaining({
				prevOverrides: {},
				nextOverrides: { ENABLE_MAINTENANCE_MODE: true },
				templateVersion: '42',
			}));

			unsubscribe();
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_MAINTENANCE_MODE: false });
			expect(listener).toHaveBeenCalledTimes(1);
		});

		// Regression coverage for issue #598: the server template has never been
		// published, so initServerTemplate().load() rejects with
		// remote-config/not-found on every refresh. The status must stay
		// explicitly unready, must not claim the feature is live, and must
		// surface a distinguishable category instead of the opaque
		// `load_failed` that hid an unpublishable template.
		describe('unpublished server template (issue #598)', () => {
			function notFoundError() {
				const error = new Error('Server template not found');
				error.code = 'remote-config/not-found';
				error.hasCode = (code) => `remote-config/${code}` === error.code;
				return error;
			}

			it('classifies remote-config/not-found as template_not_published instead of load_failed', async () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				mockTemplate({}, { load: jest.fn().mockRejectedValue(notFoundError()) });
				alertStorageService.getFirestore.mockReturnValue({});

				await expect(remoteConfigService.loadNow()).resolves.toBe(false);

				expect(remoteConfigService.getStatus().lastErrorCategory).toBe('template_not_published');
			});

			it('classifies hasCode-based not-found errors without a .code string', async () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				const error = new Error('Server template not found');
				error.code = 'remote-config/not-found';
				error.hasCode = (code) => code === 'not-found';
				mockTemplate({}, { load: jest.fn().mockRejectedValue(error) });
				alertStorageService.getFirestore.mockReturnValue({});

				await expect(remoteConfigService.loadNow()).resolves.toBe(false);

				expect(remoteConfigService.getStatus().lastErrorCategory).toBe('template_not_published');
			});

			it('keeps remote-config/permission-denied and /unauthenticated distinct from not-found', async () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				mockTemplate({}, { load: jest.fn().mockRejectedValue(Object.assign(new Error('denied'), {
					code: 'remote-config/permission-denied',
				})) });
				alertStorageService.getFirestore.mockReturnValue({});

				await expect(remoteConfigService.loadNow()).resolves.toBe(false);

				expect(remoteConfigService.getStatus().lastErrorCategory).toBe('permission_denied');
			});

			it('never reports ready or status ready while the template has never loaded', async () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				mockTemplate({}, { load: jest.fn().mockRejectedValue(notFoundError()) });
				alertStorageService.getFirestore.mockReturnValue({});

				await remoteConfigService.loadNow();
				const status = remoteConfigService.getStatus();

				expect(status.enabled).toBe(true);
				expect(status.configured).toBe(true);
				expect(status.ready).toBe(false);
				expect(status.status).toBe('degraded');
				expect(status.lastSuccessfulLoad).toBeNull();
				expect(status.source).toBe('environment');
				expect(status.consecutiveFailures).toBe(1);
				// Distinguishes "wired up" from "actually serving remote values".
				expect(status.templatePublished).toBe(false);
			});

			it('marks templatePublished true only after a real load', () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				alertStorageService.getFirestore.mockReturnValue({});

				expect(remoteConfigService.getStatus().templatePublished).toBe(false);

				remoteConfigService._setRemoteOverridesForTesting({ NEWS_ALERT_THRESHOLD: 0.9 });
				expect(remoteConfigService.getStatus().templatePublished).toBe(true);
			});

			it('does not report ready for a stale template even though it once loaded', () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				process.env.FIREBASE_REMOTE_CONFIG_MAX_AGE_MS = '10';
				alertStorageService.getFirestore.mockReturnValue({});

				remoteConfigService._setRemoteOverridesForTesting(
					{ NEWS_ALERT_THRESHOLD: 0.9 },
					Date.now() - 5000,
				);

				const status = remoteConfigService.getStatus();
				expect(status.ready).toBe(false);
				expect(status.status).toBe('degraded');
				expect(status.lastErrorCategory).toBe('stale');
				expect(status.templatePublished).toBe(true);
			});

			it('stays fail-open: environment defaults are used and no startup is blocked', async () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				mockTemplate({}, { load: jest.fn().mockRejectedValue(notFoundError()) });
				alertStorageService.getFirestore.mockReturnValue({});

				await expect(remoteConfigService.start()).resolves.toBe(true);

				const config = remoteConfigService.getRuntimeConfig();
				expect(config.NEWS_ALERT_THRESHOLD).toBe(0.7);
				expect(config.TRADINGVIEW_MCP_TIMEOUT_MS).toBe(12000);
				remoteConfigService.stop();
			});

			it('reports ready only after an actual successful load following an unpublished failure', async () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				const load = jest.fn()
					.mockRejectedValueOnce(notFoundError())
					.mockResolvedValueOnce(undefined);
				mockTemplate({ NEWS_ALERT_THRESHOLD: 0.9 }, { load, versionNumber: '3' });
				alertStorageService.getFirestore.mockReturnValue({});

				await expect(remoteConfigService.loadNow()).resolves.toBe(false);
				expect(remoteConfigService.getStatus().ready).toBe(false);
				expect(remoteConfigService.getStatus().lastErrorCategory).toBe('template_not_published');

				await expect(remoteConfigService.loadNow()).resolves.toBe(true);
				const status = remoteConfigService.getStatus();
				expect(status.ready).toBe(true);
				expect(status.status).toBe('ready');
				expect(status.source).toBe('remote');
				expect(status.lastErrorCategory).toBeNull();
				expect(status.consecutiveFailures).toBe(0);
			});

			it('recovers from template_not_published to load_failed only on a genuinely different failure', async () => {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
				const load = jest.fn()
					.mockRejectedValueOnce(notFoundError())
					.mockRejectedValueOnce(new Error('socket hang up'));
				mockTemplate({}, { load });
				alertStorageService.getFirestore.mockReturnValue({});

				await remoteConfigService.loadNow();
				expect(remoteConfigService.getStatus().lastErrorCategory).toBe('template_not_published');

				await remoteConfigService.loadNow();
				const status = remoteConfigService.getStatus();
				expect(status.lastErrorCategory).toBe('load_failed');
				expect(status.consecutiveFailures).toBe(2);
				expect(status.ready).toBe(false);
			});
		});
	});

	it('supports user price alert parameters via Remote Config', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		mockTemplate({
			ENABLE_USER_PRICE_ALERTS: true,
			USER_PRICE_ALERT_EVALUATION_INTERVAL_MS: 30000,
			USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT: 25,
			USER_PRICE_ALERT_MAX_PER_CHAT: 15,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		const config = remoteConfigService.getRuntimeConfig();
		expect(config.ENABLE_USER_PRICE_ALERTS).toBe(true);
		expect(config.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS).toBe(30000);
		expect(config.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT).toBe(25);
		expect(config.USER_PRICE_ALERT_MAX_PER_CHAT).toBe(15);
	});

	it('supports JOB_BACKLOG_* parameters via Remote Config', async () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		mockTemplate({
			JOB_BACKLOG_ALERT_THRESHOLD_MS: 600000,
			JOB_BACKLOG_PAGE_COOLDOWN_MS: 1200000,
			JOB_BACKLOG_PROBE_INTERVAL_MS: 30000,
		});
		alertStorageService.getFirestore.mockReturnValue({});

		await remoteConfigService.loadNow();

		const config = remoteConfigService.getRuntimeConfig();
		expect(config.JOB_BACKLOG_ALERT_THRESHOLD_MS).toBe(600000);
		expect(config.JOB_BACKLOG_PAGE_COOLDOWN_MS).toBe(1200000);
		expect(config.JOB_BACKLOG_PROBE_INTERVAL_MS).toBe(30000);
	});
});
