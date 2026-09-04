const request = require('supertest');
const express = require('express');
const {
	buildEnvironmentBannerMiddleware,
	getEnvironmentBannerPayload,
} = require('../../src/lib/environmentBanner');

const ENV_KEYS_FOR_BANNER = [
	'ENABLE_ENVIRONMENT_BANNER',
	'SERVICE_NAME',
	'RENDER_GIT_COMMIT',
	'RENDER_DEPLOY_ID',
	'RENDER_GIT_COMMIT_DATE',
	'RAILWAY_GIT_COMMIT_SHA',
	'RAILWAY_DEPLOYMENT_ID',
	'RAILWAY_GIT_COMMIT_DATE',
	'RAILWAY_ENVIRONMENT_NAME',
	'VERCEL_DEPLOYMENT_ID',
	'VERCEL_GIT_COMMIT_SHA',
	'VERCEL_ENV',
	'VERCEL_GIT_COMMIT_DATE',
	'SENTRY_ENVIRONMENT',
	'NODE_ENV',
	'GIT_COMMIT',
	'COMMIT_SHA',
	'GITHUB_SHA',
	'SOURCE_VERSION',
];

let savedBannerEnv = {};

function buildTestApp(envOverrides = {}) {
	savedBannerEnv = {};
	ENV_KEYS_FOR_BANNER.forEach((key) => {
		savedBannerEnv[key] = process.env[key];
		delete process.env[key];
	});
	process.env.ENABLE_ENVIRONMENT_BANNER = 'true';
	Object.entries(envOverrides).forEach(([key, value]) => {
		if (value === undefined || value === null) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	});
	const app = express();
	app.use(buildEnvironmentBannerMiddleware());
	app.get('/api/banner', (req, res) => {
		return res.status(200).json(getEnvironmentBannerPayload());
	});
	app.get('/healthcheck', (req, res) => res.status(200).json({ ok: true }));
	return app;
}

afterEach(() => {
	ENV_KEYS_FOR_BANNER.forEach((key) => {
		if (savedBannerEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedBannerEnv[key];
		}
	});
});

describe('Environment banner middleware and /api/banner endpoint', () => {
	it('stamps X-Cabros-* headers on /healthcheck', async () => {
		const app = buildTestApp({
			SERVICE_NAME: 'cabros-bot',
			RENDER_GIT_COMMIT: 'abcdef1234567890',
		});
		const response = await request(app).get('/healthcheck');
		expect(response.status).toBe(200);
		expect(response.headers['x-cabros-environment']).toBeDefined();
		expect(response.headers['x-cabros-commit']).toBe('abcdef12');
		expect(response.headers['x-cabros-service']).toBe('cabros-bot');
	});

	it('omits commit header when commit is unavailable', async () => {
		const app = buildTestApp({ SERVICE_NAME: 'cabros-bot' });
		const response = await request(app).get('/healthcheck');
		expect(response.headers['x-cabros-environment']).toBeDefined();
		expect(response.headers['x-cabros-service']).toBe('cabros-bot');
		expect(response.headers['x-cabros-commit']).toBeUndefined();
	});

	it('classifies Railway PR as preview', async () => {
		const app = buildTestApp({
			RAILWAY_ENVIRONMENT_NAME: 'cabros-bot-pr-359',
			RAILWAY_GIT_COMMIT_SHA: '1234567890abcdef',
		});
		const response = await request(app).get('/api/banner');
		expect(response.status).toBe(200);
		expect(response.body.environment).toBe('preview');
		expect(response.body.commit).toBe('1234567890abcdef');
		expect(response.body.name).toBe('cabros-bot');
		expect(response.headers['x-cabros-environment']).toBe('preview');
		expect(response.headers['x-cabros-commit']).toBe('12345678');
	});

	it('honors SENTRY_ENVIRONMENT override', async () => {
		const app = buildTestApp({
			SENTRY_ENVIRONMENT: 'staging-eu',
			RENDER_GIT_COMMIT: 'abcdef1234567890',
		});
		const response = await request(app).get('/api/banner');
		expect(response.status).toBe(200);
		expect(response.body.environment).toBe('staging-eu');
		expect(response.headers['x-cabros-environment']).toBe('staging-eu');
	});

	it('returns only sanitized fields without secrets', async () => {
		const app = buildTestApp({
			SERVICE_NAME: 'cabros-bot',
			RENDER_GIT_COMMIT: 'abcdef1234567890',
			RENDER_DEPLOY_ID: 'dep-1',
		});
		const response = await request(app).get('/api/banner');
		const keys = Object.keys(response.body).sort();
		expect(keys).toEqual(['commit', 'deployedAt', 'environment', 'name']);
		expect(JSON.stringify(response.body)).not.toMatch(/secret|key|token|password|api/i);
	});

	it('skips headers entirely when disabled', async () => {
		process.env.ENABLE_ENVIRONMENT_BANNER = 'false';
		process.env.RENDER_GIT_COMMIT = 'abcdef1234567890';
		const app = express();
		app.use(buildEnvironmentBannerMiddleware());
		app.get('/healthcheck', (req, res) => res.status(200).json({ ok: true }));
		const response = await request(app).get('/healthcheck');
		expect(response.headers['x-cabros-environment']).toBeUndefined();
		expect(response.headers['x-cabros-commit']).toBeUndefined();
		expect(response.headers['x-cabros-service']).toBeUndefined();
	});

	it('does not require auth and exposes deployedAt when host metadata exists', async () => {
		const app = buildTestApp({
			SERVICE_NAME: 'cabros-bot',
			RENDER_GIT_COMMIT: 'abcdef1234567890',
			RENDER_DEPLOY_ID: 'dep-2',
			RENDER_GIT_COMMIT_DATE: '2026-08-29T12:34:56Z',
		});
		const response = await request(app).get('/api/banner');
		expect(response.status).toBe(200);
		expect(response.body.deployedAt).toBe('dep-2');
	});
});