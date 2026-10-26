'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkAdminDrift, ROOT_INDEX_HTML } = require('../../scripts/build-hosting');

const repoRoot = path.join(__dirname, '../..');
const srcAdminDir = path.join(repoRoot, 'src/admin');
const publicDir = path.join(repoRoot, 'public');
const publicAdminDir = path.join(repoRoot, 'public/admin');

const listFiles = (dir) => fs.readdirSync(dir)
	.filter((file) => fs.statSync(path.join(dir, file)).isFile())
	.sort();

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('admin console hosting parity', () => {
	// GH-1201: `scripts/build-hosting.js` copies src/admin/* over public/admin/*
	// unconditionally, so a console fix applied to the generated artifact instead
	// of the source is silently deleted by the next Firebase deploy, and CI stayed
	// green because nothing compared the two trees.
	it('parses both trees so a missing directory is a loud failure, not an empty pass', () => {
		expect(fs.existsSync(srcAdminDir)).toBe(true);
		expect(fs.existsSync(publicAdminDir)).toBe(true);
		expect(listFiles(srcAdminDir).length).toBeGreaterThan(0);
		expect(listFiles(publicAdminDir).length).toBeGreaterThan(0);
	});

	it('tracks every console asset named in the issue', () => {
		expect(listFiles(srcAdminDir)).toEqual(expect.arrayContaining([
			'admin.js',
			'admin.css',
			'index.html',
			'admin-request.js',
			'i18n.js',
		]));
	});

	it.each(listFiles(srcAdminDir))('public/admin/%s is byte-identical to its src/admin source', (file) => {
		expect(fs.existsSync(path.join(publicAdminDir, file))).toBe(true);
		expect(digest(path.join(publicAdminDir, file))).toBe(digest(path.join(srcAdminDir, file)));
	});

	it('carries no built asset without a source, since build:hosting copies source to artifact', () => {
		expect(listFiles(publicAdminDir)).toEqual(listFiles(srcAdminDir));
	});

	it('keeps vue.runtime.global.prod.js pinned to the lockfile build in both trees', () => {
		// build-hosting.js re-copies this from require.resolve('vue/...') before
		// syncing, so it is present in both trees and must stay in parity.
		expect(fs.existsSync(path.join(srcAdminDir, 'vue.runtime.global.prod.js'))).toBe(true);
		expect(fs.existsSync(path.join(publicAdminDir, 'vue.runtime.global.prod.js'))).toBe(true);
	});

	it('keeps public/index.html matching the canonical redirect template', () => {
		expect(fs.existsSync(path.join(publicDir, 'index.html'))).toBe(true);
		expect(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')).toBe(ROOT_INDEX_HTML);
	});

	it('passes checkAdminDrift on the repository trees', () => {
		const result = checkAdminDrift({ sourceAdminDir: srcAdminDir, publicDir });
		expect(result).toEqual({ ok: true, message: 'Admin hosting assets are in sync.' });
	});

	describe('checkAdminDrift isolation guard (GH-758)', () => {
		let tmpDir;
		let tmpSrcAdmin;
		let tmpPublic;
		let tmpPublicAdmin;

		beforeEach(() => {
			tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-drift-test-'));
			tmpSrcAdmin = path.join(tmpDir, 'src/admin');
			tmpPublic = path.join(tmpDir, 'public');
			tmpPublicAdmin = path.join(tmpPublic, 'admin');

			fs.mkdirSync(tmpSrcAdmin, { recursive: true });
			fs.mkdirSync(tmpPublicAdmin, { recursive: true });

			fs.writeFileSync(path.join(tmpSrcAdmin, 'admin.js'), 'console.log("src");', 'utf8');
			fs.writeFileSync(path.join(tmpPublicAdmin, 'admin.js'), 'console.log("src");', 'utf8');
			fs.writeFileSync(path.join(tmpPublic, 'index.html'), ROOT_INDEX_HTML, 'utf8');
		});

		afterEach(() => {
			if (tmpDir && fs.existsSync(tmpDir)) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it('reports clean sync when all assets match', () => {
			const result = checkAdminDrift({ sourceAdminDir: tmpSrcAdmin, publicDir: tmpPublic });
			expect(result.ok).toBe(true);
			expect(result.message).toBe('Admin hosting assets are in sync.');
		});

		it('fails with actionable message when src/admin asset is modified without build:hosting', () => {
			fs.writeFileSync(path.join(tmpSrcAdmin, 'admin.js'), 'console.log("modified");', 'utf8');
			const result = checkAdminDrift({ sourceAdminDir: tmpSrcAdmin, publicDir: tmpPublic });
			expect(result.ok).toBe(false);
			expect(result.message).toContain('generated hosting assets are out of date; run pnpm run build:hosting');
			expect(result.message).toContain('public/admin/admin.js differs from src/admin/admin.js');
			expect(result.errors).toContain('public/admin/admin.js differs from src/admin/admin.js');
		});

		it('fails with actionable message when public asset is missing', () => {
			fs.unlinkSync(path.join(tmpPublicAdmin, 'admin.js'));
			const result = checkAdminDrift({ sourceAdminDir: tmpSrcAdmin, publicDir: tmpPublic });
			expect(result.ok).toBe(false);
			expect(result.message).toContain('generated hosting assets are out of date; run pnpm run build:hosting');
			expect(result.message).toContain('Missing in public/admin: admin.js');
		});

		it('fails with actionable message when orphan file exists in public/admin', () => {
			fs.writeFileSync(path.join(tmpPublicAdmin, 'orphan.js'), 'console.log("orphan");', 'utf8');
			const result = checkAdminDrift({ sourceAdminDir: tmpSrcAdmin, publicDir: tmpPublic });
			expect(result.ok).toBe(false);
			expect(result.message).toContain('generated hosting assets are out of date; run pnpm run build:hosting');
			expect(result.message).toContain('Extra file in public/admin without source in src/admin: orphan.js');
		});

		it('fails with actionable message when public/index.html is missing or corrupted', () => {
			fs.writeFileSync(path.join(tmpPublic, 'index.html'), 'corrupted', 'utf8');
			const result = checkAdminDrift({ sourceAdminDir: tmpSrcAdmin, publicDir: tmpPublic });
			expect(result.ok).toBe(false);
			expect(result.message).toContain('generated hosting assets are out of date; run pnpm run build:hosting');
			expect(result.message).toContain('public/index.html does not match expected redirect content');
		});
	});
});
