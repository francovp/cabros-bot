'use strict';

const fs = require('fs');
const path = require('path');
const { buildHosting } = require('../../scripts/build-hosting');

describe('Firebase Hosting Configuration', () => {
	const rootDir = path.join(__dirname, '../..');
	const firebaseJsonPath = path.join(rootDir, 'firebase.json');
	const workflowPath = path.join(rootDir, '.github/workflows/firebase-hosting.yml');

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

	it('firebase.json hosting headers include required security headers for all routes', () => {
		const config = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8'));
		const headerGroups = config.hosting.headers;
		expect(Array.isArray(headerGroups)).toBe(true);

		// Flatten all header key/value pairs across all sources
		const allHeaders = headerGroups.flatMap((g) => g.headers);
		const byKey = Object.fromEntries(allHeaders.map((h) => [h.key, h.value]));

		expect(byKey['X-Content-Type-Options']).toBe('nosniff');
		expect(byKey['Referrer-Policy']).toBe('no-referrer');
		expect(byKey['X-Frame-Options']).toBe('DENY');
		expect(byKey['Content-Security-Policy']).toContain('frame-ancestors \'none\'');
		expect(byKey['Content-Security-Policy']).toContain('default-src \'self\'');
	});

	it('generated public/admin/index.html contains security meta-tag fallbacks', () => {
		buildHosting();
		const publicAdminIndex = path.join(rootDir, 'public/admin/index.html');
		const html = fs.readFileSync(publicAdminIndex, 'utf8');

		expect(html).toContain('http-equiv="X-Content-Type-Options"');
		expect(html).toContain('content="nosniff"');
		expect(html).toContain('http-equiv="Referrer-Policy"');
		expect(html).toContain('content="no-referrer"');
		expect(html).toContain('http-equiv="X-Frame-Options"');
		expect(html).toContain('http-equiv="Content-Security-Policy"');
		expect(html).toContain('frame-ancestors \'none\'');
	});

	it('src/admin/index.html and public/admin/index.html have identical security meta tags', () => {
		buildHosting();
		const srcHtml = fs.readFileSync(path.join(rootDir, 'src/admin/index.html'), 'utf8');
		const publicHtml = fs.readFileSync(path.join(rootDir, 'public/admin/index.html'), 'utf8');

		const securityMetaRe = /<meta http-equiv="(?:Content-Security-Policy|X-Frame-Options|X-Content-Type-Options|Referrer-Policy)"[^>]+>/g;
		const srcTags = srcHtml.match(securityMetaRe) || [];
		const publicTags = publicHtml.match(securityMetaRe) || [];

		expect(srcTags.length).toBe(4);
		expect(publicTags).toEqual(srcTags);
	});
});
