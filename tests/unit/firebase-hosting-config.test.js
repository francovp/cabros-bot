'use strict';

const fs = require('fs');
const path = require('path');
const { buildHosting } = require('../../scripts/build-hosting');

function getHeader(config, key) {
	const headers = (config.hosting && config.hosting.headers) || [];
	const entry = headers.find((h) => Array.isArray(h.headers) && h.headers.some((kv) => kv.key === key));
	if (!entry) return undefined;
	const kv = entry.headers.find((h) => h.key === key);
	return kv && kv.value;
}

function getHeaderForSource(config, source, key) {
	const headers = (config.hosting && config.hosting.headers) || [];
	const entry = headers.find((h) => h.source === source);
	if (!entry) return undefined;
	const kv = (entry.headers || []).find((h) => h.key === key);
	return kv && kv.value;
}

describe('Firebase Hosting Configuration', () => {
	const rootDir = path.join(__dirname, '../..');
	const firebaseJsonPath = path.join(rootDir, 'firebase.json');
	const workflowPath = path.join(rootDir, '.github/workflows/firebase-hosting.yml');
	const srcAdminHtmlPath = path.join(rootDir, 'src/admin/index.html');
	const publicAdminHtmlPath = path.join(rootDir, 'public/admin/index.html');

	it('configures hosting and emulator in firebase.json', () => {
		expect(fs.existsSync(firebaseJsonPath)).toBe(true);
		const config = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));

		expect(config.hosting).toBeDefined();
		expect(config.hosting.public).toBe('public');
		expect(Array.isArray(config.hosting.ignore)).toBe(true);
		expect(config.hosting.ignore).toContain('firebase.json');

		expect(Array.isArray(config.hosting.rewrites)).toBe(true);
		const adminRewrite = config.hosting.rewrites.find((r) => r.source === '/admin/**' || r.source === '**');
		expect(adminRewrite).toBeDefined();
		expect(adminRewrite.destination).toBe('/admin/index.html');

		expect(config.emulators).toBeDefined();
		expect(config.emulators.hosting).toBeDefined();
		expect(config.emulators.hosting.port).toBe(5000);
	});

	it('buildHosting builds public admin assets and root redirect', () => {
		buildHosting();

		const publicDir = path.join(rootDir, 'public');
		const publicAdminDir = path.join(publicDir, 'admin');

		expect(fs.existsSync(path.join(publicDir, 'index.html'))).toBe(true);
		expect(fs.existsSync(path.join(publicAdminDir, 'index.html'))).toBe(true);
		expect(fs.existsSync(path.join(publicAdminDir, 'admin.js'))).toBe(true);
		expect(fs.existsSync(path.join(publicAdminDir, 'admin.css'))).toBe(true);
		expect(fs.existsSync(path.join(publicAdminDir, 'admin-request.js'))).toBe(true);
	});

	it('defines preview and live hosting deployments in GitHub Actions workflow', () => {
		expect(fs.existsSync(workflowPath)).toBe(true);
		const workflowContent = fs.readFileSync(workflowPath, 'utf8');

		expect(workflowContent).toContain('FirebaseExtended/action-hosting-deploy');
		expect(workflowContent).toContain('projectId: cabros-bot');
		expect(workflowContent).toContain('pull_request');
		expect(workflowContent).toContain('channelId: live');
	});

	it('emits Content-Security-Policy headers on Firebase Hosting responses', () => {
		const config = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
		const csp = getHeader(config, 'Content-Security-Policy');

		expect(csp).toBeDefined();
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("base-uri 'self'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).toContain("object-src 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("style-src 'self'");
		expect(csp).toContain("img-src 'self'");
		expect(csp).toContain('https://identitytoolkit.googleapis.com');
		expect(csp).toContain('https://securetoken.googleapis.com');
		expect(csp).toContain('https://*.web.app');
		expect(csp).toContain('https://*.firebaseapp.com');
		expect(csp).toContain('https://cabros-bot-production.up.railway.app');
		expect(csp).not.toContain("'unsafe-eval'");
		expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
		expect(csp).not.toMatch(/default-src[^;]*'unsafe-inline'/);
	});

	it('emits X-Frame-Options DENY on Firebase Hosting responses', () => {
		const config = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
		const header = getHeader(config, 'X-Frame-Options');
		expect(header).toBe('DENY');
	});

	it('emits X-Content-Type-Options nosniff on Firebase Hosting responses', () => {
		const config = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
		const header = getHeader(config, 'X-Content-Type-Options');
		expect(header).toBe('nosniff');
	});

	it('emits Referrer-Policy no-referrer on Firebase Hosting responses', () => {
		const config = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
		const header = getHeader(config, 'Referrer-Policy');
		expect(header).toBe('no-referrer');
	});

	it('mirrors the CSP as a meta http-equiv fallback in src/admin/index.html', () => {
		const html = fs.readFileSync(srcAdminHtmlPath, 'utf8');

		expect(html).toMatch(/<meta\s+http-equiv=["']Content-Security-Policy["']/i);
		expect(html).toMatch(/<meta\s+http-equiv=["']X-Content-Type-Options["']\s+content=["']nosniff["']/i);
		expect(html).toMatch(/<meta\s+http-equiv=["']X-Frame-Options["']\s+content=["']DENY["']/i);
		expect(html).toMatch(/<meta\s+http-equiv=["']Referrer-Policy["']\s+content=["']no-referrer["']/i);

		const cspMatch = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])([\s\S]*?)\1/i);
		expect(cspMatch).not.toBeNull();
		const csp = cspMatch[2];
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toContain("default-src 'self'");
		expect(csp).toContain('https://identitytoolkit.googleapis.com');
		expect(csp).toContain('https://cabros-bot-production.up.railway.app');
	});

	it('keeps the CSP value in firebase.json and src/admin/index.html consistent', () => {
		const config = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
		const headerCsp = getHeader(config, 'Content-Security-Policy');
		expect(headerCsp).toBeDefined();

		const html = fs.readFileSync(srcAdminHtmlPath, 'utf8');
		const cspMatch = html.match(/<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(["'])([\s\S]*?)\1/i);
		expect(cspMatch).not.toBeNull();
		const metaCsp = cspMatch[2];

		expect(metaCsp).toBe(headerCsp);
	});

	it('keeps the generated public/admin/index.html in sync with the security meta tags', () => {
		const srcHtml = fs.readFileSync(srcAdminHtmlPath, 'utf8');
		const publicHtml = fs.readFileSync(publicAdminHtmlPath, 'utf8');

		const extractTags = (html) => {
			const matches = html.match(/<meta\s+http-equiv=["'][^"']+["']\s+content=["'][^"']*["']\s*\/?>/gi) || [];
			return matches.map((tag) => tag.replace(/\s+/g, ' ').trim()).sort();
		};

		const srcTags = extractTags(srcHtml);
		const publicTags = extractTags(publicHtml);

		expect(publicTags.length).toBeGreaterThan(0);
		expect(publicTags).toEqual(srcTags);
		expect(publicHtml).toContain('Content-Security-Policy');
		expect(publicHtml).toContain('X-Frame-Options');
		expect(publicHtml).toContain('X-Content-Type-Options');
		expect(publicHtml).toContain('Referrer-Policy');
	});

	it('keeps the security meta tags inside the <head> element', () => {
		const html = fs.readFileSync(srcAdminHtmlPath, 'utf8');
		const headMatch = html.match(/<head>([\s\S]*?)<\/head>/i);
		expect(headMatch).not.toBeNull();
		const headContent = headMatch[1];

		expect(headContent).toMatch(/<meta\s+http-equiv=["']Content-Security-Policy["']/i);
		expect(headContent).toMatch(/<meta\s+http-equiv=["']X-Frame-Options["']/i);
		expect(headContent).toMatch(/<meta\s+http-equiv=["']X-Content-Type-Options["']/i);
		expect(headContent).toMatch(/<meta\s+http-equiv=["']Referrer-Policy["']/i);
	});
});
