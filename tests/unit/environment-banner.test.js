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
		expect(payload.deployedAt).toBe('dep-1');
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