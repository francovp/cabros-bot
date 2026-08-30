// tests/integration/cors-allowlist.test.js
const request = require('supertest');

describe('App-level CORS allowlist integration', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		delete process.env.CORS_ALLOWED_ORIGINS;
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	function loadApp() {
		let app;
		jest.isolateModules(() => {
			app = require('../../app');
		});
		return app;
	}

	test('healthcheck returns 200 for requests without an Origin header (server-to-server)', async () => {
		const app = loadApp();
		const response = await request(app).get('/healthcheck');
		expect(response.status).toBe(200);
		expect(response.headers['access-control-allow-origin']).toBeUndefined();
	});

	test('grants CORS headers for the default hosted-console origin', async () => {
		const app = loadApp();
		const response = await request(app)
			.get('/healthcheck')
			.set('Origin', 'https://cabros-bot.web.app');
		expect(response.status).toBe(200);
		expect(response.headers['access-control-allow-origin']).toBe('https://cabros-bot.web.app');
		expect(response.headers.vary).toContain('Origin');
	});

	test('omits CORS headers for a disallowed browser origin', async () => {
		const app = loadApp();
		const response = await request(app)
			.get('/healthcheck')
			.set('Origin', 'https://attacker.example.com');
		expect(response.status).toBe(200);
		expect(response.headers['access-control-allow-origin']).toBeUndefined();
	});

	test('honors CORS_ALLOWED_ORIGINS override at app load time', async () => {
		process.env.CORS_ALLOWED_ORIGINS = 'https://staging.example.com';
		const app = loadApp();
		const response = await request(app)
			.get('/healthcheck')
			.set('Origin', 'https://staging.example.com');
		expect(response.headers['access-control-allow-origin']).toBe('https://staging.example.com');

		const denied = await request(app)
			.get('/healthcheck')
			.set('Origin', 'https://cabros-bot.web.app');
		expect(denied.headers['access-control-allow-origin']).toBeUndefined();
	});

	test('OPTIONS preflight from an allowed origin returns 204 with allow headers', async () => {
		const app = loadApp();
		const response = await request(app)
			.options('/api/status')
			.set('Origin', 'https://cabros-bot.firebaseapp.com')
			.set('Access-Control-Request-Method', 'GET')
			.set('Access-Control-Request-Headers', 'content-type, x-api-key');
		expect(response.status).toBe(204);
		expect(response.headers['access-control-allow-origin']).toBe('https://cabros-bot.firebaseapp.com');
		expect(response.headers['access-control-allow-methods']).toMatch(/GET/);
		expect(response.headers['access-control-allow-credentials']).toBeUndefined();
	});
});