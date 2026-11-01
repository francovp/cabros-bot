const path = require('path');

const banner = require(path.resolve(__dirname, '../../src/lib/environmentBanner'));

describe('environment banner helpers', () => {
	it('defaults to enabled when ENABLE_ENVIRONMENT_BANNER is unset', () => {
		expect(banner.isEnvironmentBannerEnabled({})).toBe(true);
		expect(banner.isEnvironmentBannerEnabled({ ENABLE_ENVIRONMENT_BANNER: '' })).toBe(true);
		expect(banner.isEnvironmentBannerEnabled({ ENABLE_ENVIRONMENT_BANNER: null })).toBe(true);
		expect(banner.isEnvironmentBannerEnabled({ ENABLE_ENVIRONMENT_BANNER: undefined })).toBe(true);
	});

	it('disables when ENABLE_ENVIRONMENT_BANNER is "false"', () => {
		expect(banner.isEnvironmentBannerEnabled({ ENABLE_ENVIRONMENT_BANNER: 'false' })).toBe(false);
		expect(banner.isEnvironmentBannerEnabled({ ENABLE_ENVIRONMENT_BANNER: 'FALSE' })).toBe(false);
		expect(banner.isEnvironmentBannerEnabled({ ENABLE_ENVIRONMENT_BANNER: '  false  ' })).toBe(false);
	});

	it('exposes a sanitized payload without secrets', () => {
		const metadata = banner.getEnvironmentBannerMetadata({
			SERVICE_NAME: 'cabros-bot-preview',
			RENDER_GIT_COMMIT: 'abcdef1234567890fedcba0987654321deadbeef',
		});
		const payload = banner.getEnvironmentBannerPayload({
			SERVICE_NAME: 'cabros-bot-preview',
			RENDER_GIT_COMMIT: 'abcdef1234567890fedcba0987654321deadbeef',
			RENDER_DEPLOY_ID: 'dep-1',
			RENDER_GIT_COMMIT_DATE: '2026-08-29T12:34:56Z',
		});
		expect(metadata.shortCommit).toBe('abcdef12');
		expect(payload.name).toBe('cabros-bot-preview');
		expect(payload.commit).toBe('abcdef1234567890fedcba0987654321deadbeef');
		expect(payload.deployedAt).toBe('2026-08-29T12:34:56.000Z');
		expect(JSON.stringify(payload)).not.toMatch(/secret|key|token|password|api/i);
	});

	it('returns null commit and deployedAt when host metadata is missing', () => {
		const payload = banner.getEnvironmentBannerPayload({});
		expect(payload.commit).toBeNull();
		expect(payload.deployedAt).toBeNull();
	});

	it('prefers SENTRY_ENVIRONMENT when provided', () => {
		expect(banner.resolveEnvironmentBannerEnvironment({
			SENTRY_ENVIRONMENT: 'staging-eu',
			RENDER: 'true',
		})).toBe('staging-eu');
	});

	it('classifies Railway PR environments as preview', () => {
		expect(banner.resolveEnvironmentBannerEnvironment({
			RAILWAY_ENVIRONMENT_NAME: 'cabros-bot-pr-359',
		})).toBe('preview');
	});

	it('classifies production deployments as production', () => {
		expect(banner.resolveEnvironmentBannerEnvironment({
			RAILWAY_ENVIRONMENT_NAME: 'production',
			NODE_ENV: 'production',
		})).toBe('production');
	});

	it('falls back to NODE_ENV when no platform metadata exists', () => {
		expect(banner.resolveEnvironmentBannerEnvironment({ NODE_ENV: 'test' })).toBe('test');
		expect(banner.resolveEnvironmentBannerEnvironment({})).toBe('development');
	});

	it('builds a middleware that stamps X-Cabros-* headers when enabled', () => {
		const middleware = banner.buildEnvironmentBannerMiddleware({
			ENABLE_ENVIRONMENT_BANNER: 'true',
			SERVICE_NAME: 'cabros-bot',
			RENDER_GIT_COMMIT: 'abcdef1234567890',
		});
		const setHeader = jest.fn();
		const next = jest.fn();
		middleware({}, { setHeader }, next);
		expect(setHeader).toHaveBeenCalledWith(banner.BANNER_HEADER_ENVIRONMENT, expect.any(String));
		expect(setHeader).toHaveBeenCalledWith(banner.BANNER_HEADER_COMMIT, 'abcdef12');
		expect(setHeader).toHaveBeenCalledWith(banner.BANNER_HEADER_SERVICE, 'cabros-bot');
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('builds a no-op middleware when disabled', () => {
		const middleware = banner.buildEnvironmentBannerMiddleware({
			ENABLE_ENVIRONMENT_BANNER: 'false',
			RENDER_GIT_COMMIT: 'abcdef1234567890',
		});
		const setHeader = jest.fn();
		const next = jest.fn();
		middleware({}, { setHeader }, next);
		expect(setHeader).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('omits the commit header when commit is unavailable', () => {
		const middleware = banner.buildEnvironmentBannerMiddleware({
			ENABLE_ENVIRONMENT_BANNER: 'true',
			SERVICE_NAME: 'cabros-bot',
		});
		const setHeader = jest.fn();
		middleware({}, { setHeader }, jest.fn());
		const calls = setHeader.mock.calls.map(([name]) => name);
		expect(calls).toContain(banner.BANNER_HEADER_ENVIRONMENT);
		expect(calls).toContain(banner.BANNER_HEADER_SERVICE);
		expect(calls).not.toContain(banner.BANNER_HEADER_COMMIT);
	});
});

describe('environment banner runtime controls', () => {
	const remoteConfig = require('../../src/services/remoteConfig/RemoteConfigService');
	afterEach(() => jest.restoreAllMocks());

	it('rechecks Remote Config for each response without restarting middleware', () => {
		const config = { ENABLE_ENVIRONMENT_BANNER: true };
		jest.spyOn(remoteConfig, 'getRuntimeConfig').mockImplementation(() => config);
		const middleware = banner.buildEnvironmentBannerMiddleware();
		const enabledResponse = { setHeader: jest.fn() };
		middleware({}, enabledResponse, jest.fn());
		expect(enabledResponse.setHeader).toHaveBeenCalled();
		config.ENABLE_ENVIRONMENT_BANNER = false;
		const disabledResponse = { setHeader: jest.fn() };
		middleware({}, disabledResponse, jest.fn());
		expect(disabledResponse.setHeader).not.toHaveBeenCalled();
	});

	it('keeps response delivery fail-open if optional Remote Config resolution throws', () => {
		jest.spyOn(remoteConfig, 'getRuntimeConfig').mockImplementation(() => { throw new Error('config unavailable'); });
		const next = jest.fn();
		expect(() => banner.buildEnvironmentBannerMiddleware()({}, { setHeader: jest.fn() }, next)).not.toThrow();
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('keeps metadata footers empty when their existing runtime gate is off', () => {
		jest.spyOn(remoteConfig, 'getRuntimeConfig').mockReturnValue({ ENABLE_MESSAGE_FOOTER_METADATA: false });
		expect(banner.appendEnvironmentFooter('', { SENTRY_ENVIRONMENT: 'preview', GIT_COMMIT: 'abcdef12' })).toBe('');
	});

	it('adds one environment footer for custom non-production environments', () => {
		jest.spyOn(remoteConfig, 'getRuntimeConfig').mockReturnValue({ ENABLE_MESSAGE_FOOTER_METADATA: true });
		expect(banner.appendEnvironmentFooter('model info', { SENTRY_ENVIRONMENT: 'staging-eu', GIT_COMMIT: 'abcdef1234' }))
			.toBe('model info\n\\(env: staging\\-eu @ abcdef12\\)');
		expect(banner.appendEnvironmentFooter('model info', { NODE_ENV: 'production' })).toBe('model info');
	});

	it('uses only deployment timestamps for deployedAt', () => {
		expect(banner.getEnvironmentBannerPayload({ RENDER_DEPLOY_ID: 'dep-1', RENDER_GIT_COMMIT_DATE: '2026-08-29T12:34:56Z' }).deployedAt)
			.toBe('2026-08-29T12:34:56.000Z');
		expect(banner.getEnvironmentBannerPayload({ RAILWAY_DEPLOYMENT_ID: 'deployment-id' }).deployedAt).toBeNull();
	});

	it('does not crash response delivery on invalid environment header characters', () => {
		const { ServerResponse } = require('http');
		const res = new ServerResponse({ method: 'GET' });
		const next = jest.fn();
		expect(() => banner.buildEnvironmentBannerMiddleware({ SERVICE_NAME: 'bot\r\ninvalid', GIT_COMMIT: 'abcdef12' })({}, res, next)).not.toThrow();
		expect(res.statusCode).toBe(200);
		expect(next).toHaveBeenCalledTimes(1);
		expect(res.getHeader('X-Cabros-Service')).toBeUndefined();
	});
});


describe('environment footer delivery formatting', () => {
	it('escapes the appended line for Telegram and leaves WhatsApp readable', async () => {
		const remoteConfig = require('../../src/services/remoteConfig/RemoteConfigService');
		const spy = jest.spyOn(remoteConfig, 'getRuntimeConfig').mockReturnValue({ ENABLE_MESSAGE_FOOTER_METADATA: true });
		try {
			const metadata = banner.appendEnvironmentFooter('', { SENTRY_ENVIRONMENT: 'staging_eu', GIT_COMMIT: 'abcdef12' });
			const MarkdownV2Formatter = require('../../src/services/notification/formatters/markdownV2Formatter');
			const WhatsAppMarkdownFormatter = require('../../src/services/notification/formatters/whatsappMarkdownFormatter');
			const alert = { original_text: 'BTC alert', extraText: metadata };
			const telegram = new MarkdownV2Formatter().formatEnriched(alert);
			expect(telegram).toContain('\\(env: staging\\_eu @ abcdef12\\)');
			expect(telegram).not.toContain('(env: staging_eu');
			expect(await new WhatsAppMarkdownFormatter().formatEnriched(alert)).toContain('(env: staging_eu @ abcdef12)');
		} finally { spy.mockRestore(); }
	});
});
