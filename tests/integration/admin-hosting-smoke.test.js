'use strict';

const request = require('supertest');
const app = require('../../app');

describe('Admin Console Hosting Smoke & Security', () => {
	it('serves admin console HTML and assets with correct CSP headers', async () => {
		const res = await request(app).get('/admin');
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/html');
		expect(res.headers['content-security-policy']).toContain('https://*.web.app');
		expect(res.headers['content-security-policy']).toContain('https://*.firebaseapp.com');
		expect(res.headers['content-security-policy']).toContain('https://identitytoolkit.googleapis.com');
		expect(res.text).toContain('/admin/admin.js');
		expect(res.text).toContain('/admin/admin-request.js');
		expect(res.text).toContain('/admin/admin.css');
	});

	it('serves admin auth-config without exposing service credentials', async () => {
		const res = await request(app).get('/admin/auth-config');
		expect(res.status).toBe(200);
		expect(res.body).toBeDefined();
		expect(res.body.enabled).toBeDefined();
		expect(res.text).not.toContain('private_key');
		expect(res.text).not.toContain('client_secret');
	});

	it('serves OpenAPI contract on /openapi.json', async () => {
		const res = await request(app).get('/openapi.json');
		expect(res.status).toBe(200);
		expect(res.body.openapi).toMatch(/^3\./);
		expect(res.body.paths).toBeDefined();
	});

	it('serves static admin JS and CSS assets', async () => {
		const jsRes = await request(app).get('/admin/admin.js');
		expect(jsRes.status).toBe(200);
		expect(jsRes.headers['content-type']).toContain('javascript');

		const reqJsRes = await request(app).get('/admin/admin-request.js');
		expect(reqJsRes.status).toBe(200);
		expect(reqJsRes.headers['content-type']).toContain('javascript');

		const cssRes = await request(app).get('/admin/admin.css');
		expect(cssRes.status).toBe(200);
		expect(cssRes.headers['content-type']).toContain('text/css');
	});
});
