'use strict';

const fs = require('fs');
const os = require('os');
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
		const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabros-hosting-test-'));
		const sourceAdminDir = path.join(temporaryDir, 'src/admin');
		const publicDir = path.join(temporaryDir, 'public');
		const trackedRuntime = path.join(rootDir, 'src/admin/vue.runtime.global.prod.js');
		const trackedRuntimeBefore = fs.readFileSync(trackedRuntime);

		try {
			fs.cpSync(path.join(rootDir, 'src/admin'), sourceAdminDir, { recursive: true });
			fs.writeFileSync(path.join(sourceAdminDir, 'vue.runtime.global.prod.js'), 'stale runtime sentinel');
			buildHosting({ sourceAdminDir, publicDir });

			const publicAdminDir = path.join(publicDir, 'admin');
			expect(fs.existsSync(path.join(publicDir, 'index.html'))).toBe(true);
			expect(fs.existsSync(path.join(publicAdminDir, 'index.html'))).toBe(true);
			expect(fs.existsSync(path.join(publicAdminDir, 'admin.js'))).toBe(true);
			expect(fs.existsSync(path.join(publicAdminDir, 'admin.css'))).toBe(true);
			expect(fs.existsSync(path.join(publicAdminDir, 'admin-request.js'))).toBe(true);
			expect(fs.readFileSync(path.join(sourceAdminDir, 'vue.runtime.global.prod.js'), 'utf8'))
				.toBe(fs.readFileSync(require.resolve('vue/dist/vue.runtime.global.prod.js'), 'utf8'));
			for (const asset of ['admin-components.js', 'vue.runtime.global.prod.js']) {
				expect(fs.readFileSync(path.join(publicAdminDir, asset), 'utf8'))
					.toBe(fs.readFileSync(path.join(sourceAdminDir, asset), 'utf8'));
			}
			expect(fs.readFileSync(trackedRuntime)).toEqual(trackedRuntimeBefore);
		} finally {
			fs.rmSync(temporaryDir, { recursive: true, force: true });
		}
	});

	it('defines preview and live hosting deployments in GitHub Actions workflow', () => {
		expect(fs.existsSync(workflowPath)).toBe(true);
		const workflowContent = fs.readFileSync(workflowPath, 'utf8');

		expect(workflowContent).toContain('FirebaseExtended/action-hosting-deploy');
		expect(workflowContent).toContain('projectId: cabros-bot');
		expect(workflowContent).toContain('pull_request');
		expect(workflowContent).toContain('channelId: live');
	});
});
