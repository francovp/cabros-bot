const admin = require('firebase-admin');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

jest.mock('firebase-admin', () => ({
	remoteConfig: jest.fn(),
}));

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	getFirestore: jest.fn(),
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

	it('preserves legacy environment values when Remote Config is disabled', async () => {
		process.env.NEWS_ALERT_THRESHOLD = '1.5';
		process.env.NEWS_TIMEOUT_MS = '180000';
		process.env.NEWS_GEMINI_CONCURRENCY = '9';
		process.env.TRADINGVIEW_MCP_TIMEOUT_MS = '500';
		process.env.TRADINGVIEW_MCP_MAX_RETRIES = '8';

		await remoteConfigService.start();

		expect(remoteConfigService.getRuntimeConfig()).toEqual(expect.objectContaining({
			NEWS_ALERT_THRESHOLD: 1.5,
			NEWS_TIMEOUT_MS: 180000,
			NEWS_GEMINI_CONCURRENCY: 9,
			TRADINGVIEW_MCP_TIMEOUT_MS: 500,
			TRADINGVIEW_MCP_MAX_RETRIES: 8,
		}));
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
});
