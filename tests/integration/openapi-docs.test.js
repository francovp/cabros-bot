const request = require('supertest');

describe('public OpenAPI documentation', () => {
	let app;
	let savedEnv;

	beforeAll(() => {
		savedEnv = saveEnv();
		process.env.WEBHOOK_API_KEY = 'must-not-appear-in-docs';
		app = require('../../app');
	});

	afterAll(() => {
		restoreEnv(savedEnv);
	});

	it('serves the raw contract without API-key authentication', async () => {
		const response = await request(app).get('/openapi.json');

		expect(response.status).toBe(200);
		expect(response.headers['content-type']).toMatch(/application\/json/);
		expect(response.body.openapi).toMatch(/^3\./);
		expect(response.body.components.securitySchemes.ApiKeyHeader).toEqual({
			type: 'apiKey',
			in: 'header',
			name: 'x-api-key',
		});
		expect(response.text).not.toContain(process.env.WEBHOOK_API_KEY);
	});

	it('renders self-hosted Swagger UI without API-key authentication', async () => {
		const page = await request(app).get('/docs');
		const stylesheet = await request(app).get('/docs/swagger-ui.css');

		expect(page.status).toBe(200);
		expect(page.headers['content-type']).toMatch(/text\/html/);
		expect(page.text).toContain('Cabros Bot API');
		expect(page.text).toContain('/docs/swagger-ui-bundle.js');
		expect(page.text).not.toContain(process.env.WEBHOOK_API_KEY);
		expect(stylesheet.status).toBe(200);
		expect(stylesheet.headers['content-type']).toMatch(/text\/css/);
	});

	it('serves the API admin shell and external assets without an API key', async () => {
		const page = await request(app).get('/admin');
		const script = await request(app).get('/admin/admin.js');

		expect(page.status).toBe(200);
		expect(page.text).toContain('Cabros Bot Console');
		expect(page.text).toContain('/admin/admin.js');
		expect(page.text).not.toContain('https://www.gstatic.com/firebasejs/');
		expect(page.text).not.toMatch(/admin\.(?:js|css)\?v=/);
		expect(page.text).not.toContain(process.env.WEBHOOK_API_KEY);
		expect(script.status).toBe(200);
		expect(script.headers['content-type']).toMatch(/javascript/);
		expect(script.headers['cache-control']).toBe('no-cache');
	});

	it('allows only the pinned Firebase Auth browser origins in the admin CSP', async () => {
		const page = await request(app).get('/admin');
		const policy = page.headers['content-security-policy'];

		expect(policy).toContain("script-src 'self' https://www.gstatic.com");
		expect(policy).toContain('https://identitytoolkit.googleapis.com');
		expect(policy).toContain('https://securetoken.googleapis.com');
		expect(policy).not.toContain("script-src 'self' https:;");
	});

	it('keeps the admin client contract-driven without exposing the configured API key', async () => {
		const client = await request(app).get('/admin/admin.js');

		expect(client.status).toBe(200);
		expect(client.text).toContain('fetchWithTimeout(`${prefix}/openapi.json`');
		expect(client.text).toContain('CONTRACT_TIMEOUT_MS');
		expect(client.text).not.toContain(process.env.WEBHOOK_API_KEY);
	});

	describe('hosting asset sync', () => {
		const fs = require('fs');
		const path = require('path');

		// Compares the source asset with its generated copy in memory. It must
		// NOT call buildHosting(): the copier writes into the worktree, and the
		// clean-worktree invariant forbids a test from mutating tracked files.
		const ASSETS = ['admin.js', 'admin.css', 'admin-request.js', 'admin-components.js', 'index.html'];

		it.each(ASSETS)('public/admin/%s matches its src/admin source byte for byte', (file) => {
			const source = fs.readFileSync(path.join(__dirname, '../../src/admin', file));
			const built = fs.readFileSync(path.join(__dirname, '../../public/admin', file));

			expect(built.equals(source)).toBe(true);
		});

		it('serves the same bytes that the source asset declares', async () => {
			const served = await request(app).get('/admin/admin.js');
			const source = fs.readFileSync(path.join(__dirname, '../../src/admin/admin.js'), 'utf8');

			expect(served.status).toBe(200);
			expect(served.text).toBe(source);
		});
	});

	describe('rate limit exemption', () => {
		const rateLimiter = require('../../src/lib/rateLimiter');

		beforeEach(() => {
			rateLimiter.enableTestMode();
			rateLimiter.reset();
			process.env.RATE_LIMIT_MAX = '2';
		});

		afterEach(() => {
			rateLimiter.disableTestMode();
			rateLimiter.reset();
		});

		it('serves docs and admin routes even when the global rate limit is exhausted', async () => {
			// Exhaust rate limit on a non-exempt path that reaches the rate limiter
			await request(app).get('/api/unregistered-path-for-rate-limit');
			await request(app).get('/api/unregistered-path-for-rate-limit');
			const blocked = await request(app).get('/api/unregistered-path-for-rate-limit');
			expect(blocked.status).toBe(429);

			// Public OpenAPI and Swagger UI routes remain accessible
			const openApiResponse = await request(app).get('/openapi.json');
			expect(openApiResponse.status).toBe(200);

			const docsResponse = await request(app).get('/docs');
			expect(docsResponse.status).toBe(200);

			const docsCssResponse = await request(app).get('/docs/swagger-ui.css');
			expect(docsCssResponse.status).toBe(200);

			// Admin console HTML, auth config, and static JS/CSS remain accessible
			const adminResponse = await request(app).get('/admin');
			expect(adminResponse.status).toBe(200);

			const adminConfigResponse = await request(app).get('/admin/auth-config');
			expect(adminConfigResponse.status).toBe(200);

			const adminJsResponse = await request(app).get('/admin/admin.js');
			expect(adminJsResponse.status).toBe(200);

			const adminCssResponse = await request(app).get('/admin/admin.css');
			expect(adminCssResponse.status).toBe(200);
		});

		it('does not consume the global rate limiter budget when accessing docs or admin routes', async () => {
			// Make multiple requests to public docs and admin routes
			for (let i = 0; i < 5; i++) {
				const openApi = await request(app).get('/openapi.json');
				expect(openApi.status).toBe(200);

				const docs = await request(app).get('/docs');
				expect(docs.status).toBe(200);

				const admin = await request(app).get('/admin');
				expect(admin.status).toBe(200);
			}

			// The rate limit budget for non-exempt paths is still fresh (limit is 2)
			const res1 = await request(app).get('/api/fresh-budget-check');
			expect(res1.status).toBe(404); // reached route handler past rateLimiter

			const res2 = await request(app).get('/api/fresh-budget-check');
			expect(res2.status).toBe(404);

			// Third non-exempt request hits the limit
			const res3 = await request(app).get('/api/fresh-budget-check');
			expect(res3.status).toBe(429);
		});
	});
});

