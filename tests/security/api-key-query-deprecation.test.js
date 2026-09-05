const request = require('supertest');
const express = require('express');

function buildApp(authModule) {
	const app = express();
	app.use(express.json());
	app.post('/protected', authModule.validateApiKey, (req, res) => {
		res.status(200).json({ success: true });
	});
	return app;
}

describe('Security: api-key query-parameter deprecation (GH-756)', () => {
	let savedEnv;
	let auth;

	beforeEach(() => {
		savedEnv = saveEnv();
		process.env.WEBHOOK_API_KEY = 'valid-api-key';
		jest.resetModules();
		auth = require('../../src/lib/auth');
		auth._resetQueryDeprecationFlagForTests();
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		jest.resetModules();
	});

	it('accepts query-param auth and emits a one-time deprecation warning per process', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const app = buildApp(auth);

		const first = await request(app)
			.post('/protected?api-key=valid-api-key')
			.send({});
		expect(first.status).toBe(200);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('api-key query parameter is deprecated'));

		const second = await request(app)
			.post('/protected?api-key=valid-api-key')
			.send({});
		expect(second.status).toBe(200);

		const deprecationCalls = warn.mock.calls
			.filter(([message]) => typeof message === 'string' && message.includes('api-key query parameter is deprecated'));
		expect(deprecationCalls).toHaveLength(1);

		warn.mockRestore();
	});

	it('does not emit a deprecation warning when header auth is used', async () => {
		const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
		const app = buildApp(auth);

		const res = await request(app)
			.post('/protected')
			.set('x-api-key', 'valid-api-key')
			.send({});
		expect(res.status).toBe(200);

		const deprecationCalls = warn.mock.calls
			.filter(([message]) => typeof message === 'string' && message.includes('api-key query parameter is deprecated'));
		expect(deprecationCalls).toHaveLength(0);

		warn.mockRestore();
	});

	it('rejects query-param auth with a distinct error when API_KEY_QUERY_SUNSET has passed', async () => {
		process.env.API_KEY_QUERY_SUNSET = '2000-01-01';
		const localAuth = require('../../src/lib/auth');
		const app = buildApp(localAuth);

		const res = await request(app)
			.post('/protected?api-key=valid-api-key')
			.send({});

		expect(res.status).toBe(401);
		expect(res.body.error).toMatch(/api-key query parameter support has been removed/i);
		expect(res.body.code).toBe('API_KEY_QUERY_REMOVED');
	});

	it('still accepts query-param auth when API_KEY_QUERY_SUNSET is in the future', async () => {
		process.env.API_KEY_QUERY_SUNSET = '2099-12-31';
		const localAuth = require('../../src/lib/auth');
		const app = buildApp(localAuth);

		const res = await request(app)
			.post('/protected?api-key=valid-api-key')
			.send({});

		expect(res.status).toBe(200);
	});

	it('still accepts header auth when API_KEY_QUERY_SUNSET has passed', async () => {
		process.env.API_KEY_QUERY_SUNSET = '2000-01-01';
		const localAuth = require('../../src/lib/auth');
		const app = buildApp(localAuth);

		const res = await request(app)
			.post('/protected')
			.set('x-api-key', 'valid-api-key')
			.send({});

		expect(res.status).toBe(200);
	});

	it('ignores malformed API_KEY_QUERY_SUNSET values and treats them as unset', async () => {
		process.env.API_KEY_QUERY_SUNSET = 'not-a-date';
		const localAuth = require('../../src/lib/auth');
		const app = buildApp(localAuth);

		const res = await request(app)
			.post('/protected?api-key=valid-api-key')
			.send({});

		expect(res.status).toBe(200);
	});

	it('parses valid YYYY-MM-DD API_KEY_QUERY_SUNSET values to a deterministic UTC timestamp', () => {
		const ts = auth._parseApiKeyQuerySunset('2099-12-31');
		expect(ts).toBe(Date.UTC(2099, 11, 31));
	});

	it('returns null for invalid sunset date strings', () => {
		expect(auth._parseApiKeyQuerySunset('')).toBeNull();
		expect(auth._parseApiKeyQuerySunset('2026/01/01')).toBeNull();
		expect(auth._parseApiKeyQuerySunset('2026-13-01')).toBeNull();
		expect(auth._parseApiKeyQuerySunset('2026-00-10')).toBeNull();
	});
});
