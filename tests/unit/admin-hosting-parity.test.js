'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '../..');
const srcAdminDir = path.join(repoRoot, 'src/admin');
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
});
