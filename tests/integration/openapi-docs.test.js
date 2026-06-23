const request = require('supertest');

describe('public OpenAPI documentation', () => {
	let app;

	beforeAll(() => {
		process.env.WEBHOOK_API_KEY = 'must-not-appear-in-docs';
		app = require('../../app');
	});

	afterAll(() => {
		delete process.env.WEBHOOK_API_KEY;
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
});
