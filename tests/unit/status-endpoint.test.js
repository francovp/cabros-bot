'use strict';

const { getStatus } = require('../../src/controllers/status');
const {
	getBuildInfo,
	_resetLocalGitShaCache,
} = require('../../src/lib/deploymentEnvironment');

describe('status endpoint build metadata (issue #753)', () => {
	beforeEach(() => {
		_resetLocalGitShaCache();
	});

	it('covers the Render platform branch state', () => {
		const env = {
			RENDER: 'true',
			RENDER_GIT_COMMIT: 'abcdef1234567890abcdef1234567890abcdef12',
			RENDER_GIT_REPO_SLUG: 'francovp/cabros-bot',
			RENDER_SERVICE_NAME: 'cabros-bot-api',
		};

		const build = getBuildInfo(env);
		expect(build).toMatchObject({
			name: 'cabros-bot-api',
			commit: 'abcdef1',
			full: 'abcdef1234567890abcdef1234567890abcdef12',
			repo: 'francovp/cabros-bot',
			platform: 'render',
		});
		expect(build.environment).toBe('render');
		expect(new Date(build.startedAt).toISOString()).toBe(build.startedAt);
		expect(typeof build.uptimeSeconds).toBe('number');
		expect(build.uptimeSeconds).toBeGreaterThanOrEqual(0);

		const status = getStatus({ env });
		expect(status.build).toEqual(build);
		expect(status.service.commit).toBe('abcdef1234567890abcdef1234567890abcdef12');
	});

	it('covers the Vercel platform branch state', () => {
		const env = {
			VERCEL: '1',
			VERCEL_GIT_COMMIT_SHA: '9988776655443322110099887766554433221100',
			VERCEL_GIT_REPO_SLUG: 'cabros-bot',
			VERCEL_GIT_REPO_OWNER: 'francovp',
			SERVICE_NAME: 'cabros-bot-vercel',
		};

		const build = getBuildInfo(env);
		expect(build).toMatchObject({
			name: 'cabros-bot-vercel',
			commit: '9988776',
			full: '9988776655443322110099887766554433221100',
			repo: 'francovp/cabros-bot',
			platform: 'vercel',
		});
		expect(build.environment).toBe('vercel');
		expect(new Date(build.startedAt).toISOString()).toBe(build.startedAt);
		expect(typeof build.uptimeSeconds).toBe('number');
		expect(build.uptimeSeconds).toBeGreaterThanOrEqual(0);

		const status = getStatus({ env });
		expect(status.build).toEqual(build);
		expect(status.service.commit).toBe('9988776655443322110099887766554433221100');
	});

	it('covers the Railway platform branch state', () => {
		const env = {
			RAILWAY_ENVIRONMENT_NAME: 'production',
			RAILWAY_GIT_COMMIT_SHA: '1122334455667788990011223344556677889900',
			RAILWAY_GIT_REPO_NAME: 'cabros-bot',
			RAILWAY_GIT_REPO_OWNER: 'francovp',
			RAILWAY_SERVICE_NAME: 'cabros-bot-railway',
		};

		const build = getBuildInfo(env);
		expect(build).toMatchObject({
			name: 'cabros-bot-railway',
			commit: '1122334',
			full: '1122334455667788990011223344556677889900',
			repo: 'francovp/cabros-bot',
			platform: 'railway',
		});
		expect(build.environment).toBe('railway');
		expect(new Date(build.startedAt).toISOString()).toBe(build.startedAt);
		expect(typeof build.uptimeSeconds).toBe('number');
		expect(build.uptimeSeconds).toBeGreaterThanOrEqual(0);

		const status = getStatus({ env });
		expect(status.build).toEqual(build);
		expect(status.service.commit).toBe('1122334455667788990011223344556677889900');
	});

	it('covers the no platform variables state without throwing and resolves missing values to null', () => {
		const env = {};

		const build = getBuildInfo(env);
		expect(build).toBeDefined();
		expect(build.commit).toBeNull();
		expect(build.full).toBeNull();
		expect(new Date(build.startedAt).toISOString()).toBe(build.startedAt);
		expect(typeof build.uptimeSeconds).toBe('number');
		expect(build.uptimeSeconds).toBeGreaterThanOrEqual(0);

		// Missing commit values resolve to null without throwing
		const status = getStatus({ env });
		expect(status.build.commit).toBeNull();
		expect(status.build.full).toBeNull();
		expect(status.service.commit).toBeNull();
	});

	it('derives preview environment correctly when RENDER and IS_PULL_REQUEST are set', () => {
		const env = {
			RENDER: 'true',
			IS_PULL_REQUEST: 'true',
			RENDER_GIT_COMMIT: 'aabbccd1234567890abcdef1234567890abcdef12',
		};

		const build = getBuildInfo(env);
		expect(build.environment).toBe('preview');
		expect(build.commit).toBe('aabbccd');
	});
});
