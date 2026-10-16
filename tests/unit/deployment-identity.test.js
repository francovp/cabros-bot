'use strict';

const {
	getDeploymentPlatform,
	getDeploymentService,
	getRuntimeVersion,
	getDeploymentIdentity,
	deploymentIdentity,
	_resetLocalGitShaCache,
} = require('../../src/lib/deploymentEnvironment');
const deploymentIdentityModule = require('../../src/lib/deploymentIdentity');

describe('deploymentIdentity', () => {
	beforeEach(() => {
		_resetLocalGitShaCache();
	});

	it('exports expected functions from deploymentEnvironment and deploymentIdentity', () => {
		expect(typeof getDeploymentIdentity).toBe('function');
		expect(typeof deploymentIdentity).toBe('function');
		expect(deploymentIdentity).toBe(getDeploymentIdentity);
		expect(deploymentIdentityModule.getDeploymentIdentity).toBe(getDeploymentIdentity);
		expect(deploymentIdentityModule.deploymentIdentity).toBe(getDeploymentIdentity);
	});

	it('returns render platform and commit when running on Render', () => {
		const env = {
			RENDER: 'true',
			RENDER_GIT_COMMIT: 'abcdef1234567890abcdef1234567890abcdef12',
			RENDER_SERVICE_NAME: 'cabros-bot-api',
		};
		const identity = getDeploymentIdentity(env);
		expect(identity).toEqual({
			platform: 'render',
			gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
			service: 'cabros-bot-api',
			runtimeVersion: expect.any(String),
		});
	});

	it('returns railway platform and commit when running on Railway', () => {
		const env = {
			RAILWAY_ENVIRONMENT_NAME: 'production',
			RAILWAY_GIT_COMMIT_SHA: '1122334455667788990011223344556677889900',
			RAILWAY_SERVICE_NAME: 'cabros-bot-worker',
		};
		const identity = getDeploymentIdentity(env);
		expect(identity).toEqual({
			platform: 'railway',
			gitSha: '1122334455667788990011223344556677889900',
			service: 'cabros-bot-worker',
			runtimeVersion: expect.any(String),
		});
	});

	it('returns vercel platform and commit when running on Vercel', () => {
		const env = {
			VERCEL: '1',
			VERCEL_GIT_COMMIT_SHA: '9988776655443322110099887766554433221100',
			SERVICE_NAME: 'cabros-bot-frontend',
		};
		const identity = getDeploymentIdentity(env);
		expect(identity).toEqual({
			platform: 'vercel',
			gitSha: '9988776655443322110099887766554433221100',
			service: 'cabros-bot-frontend',
			runtimeVersion: expect.any(String),
		});
	});

	it('supports explicit DEPLOYMENT_PLATFORM override', () => {
		const env = {
			DEPLOYMENT_PLATFORM: 'local',
			GIT_COMMIT: '1234567',
			SERVICE_NAME: 'test-service',
		};
		const identity = getDeploymentIdentity(env);
		expect(identity.platform).toBe('local');
		expect(identity.gitSha).toBe('1234567');
		expect(identity.service).toBe('test-service');
	});

	it('returns null fields without undefined when env is empty', () => {
		const identity = getDeploymentIdentity({});
		expect(identity).toEqual({
			platform: null,
			gitSha: null,
			service: 'cabros-bot',
			runtimeVersion: expect.any(String),
		});
		// Invariant: no undefined values that could crash Firestore
		for (const [key, val] of Object.entries(identity)) {
			expect(val).not.toBeUndefined();
		}
	});

	it('handles non-object env fail-open', () => {
		const identity = getDeploymentIdentity(null);
		expect(identity).toHaveProperty('platform');
		expect(identity).toHaveProperty('gitSha');
		expect(identity).toHaveProperty('service');
		expect(identity).toHaveProperty('runtimeVersion');
		for (const [key, val] of Object.entries(identity)) {
			expect(val).not.toBeUndefined();
		}
	});

	it('falls back to local git sha when env === process.env or RESOLVE_LOCAL_GIT_SHA is true', () => {
		const identity = getDeploymentIdentity({
			RESOLVE_LOCAL_GIT_SHA: 'true',
		});
		expect(identity.gitSha).toMatch(/^[0-9a-f]{7,40}$/);
	});
});
