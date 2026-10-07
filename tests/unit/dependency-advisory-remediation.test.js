const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WORKSPACE_YAML_PATH = path.join(REPO_ROOT, 'pnpm-workspace.yaml');
const LOCKFILE_PATH = path.join(REPO_ROOT, 'pnpm-lock.yaml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

const readOverrides = () => fs.readFileSync(WORKSPACE_YAML_PATH, 'utf8');
const readLockfile = () => fs.readFileSync(LOCKFILE_PATH, 'utf8');
const readPackageJson = () => JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));

const resolvedVersions = (lockfile, name) => {
	const versions = new Set();
	const escaped = name.replace(/[/*?+[\]^$()|\\]/g, '\\$&');
	const pattern = new RegExp(`^ {2}'?${escaped}@(\\d[^:']*)'?:\\s*$`, 'gm');
	let match = pattern.exec(lockfile);
	while (match !== null) {
		versions.add(match[1]);
		match = pattern.exec(lockfile);
	}
	return [...versions];
};

describe('Dependency advisory remediation (issue #872)', () => {
	describe('overrides live where pnpm actually reads them', () => {
		it('declares no pnpm.overrides block in package.json, which pnpm 10 ignores', () => {
			expect(readPackageJson().pnpm?.overrides).toBeUndefined();
		});

		it('keeps the allowBuilds block pnpm already required', () => {
			expect(readOverrides()).toMatch(/^allowBuilds:/m);
			expect(readOverrides()).toMatch(/protobufjs: true/);
		});
	});

	describe('every runtime-reachable advisory is pinned past its patched floor', () => {
		const lockfile = readLockfile();

		const CASES = [
			{
				name: 'protobufjs',
				reason: 'Firestore wire decoder, arbitrary code execution (GHSA-xq3m-2v4x-88gg)',
				floor: '7.6.5',
			},
			{
				name: 'path-to-regexp',
				reason: 'Express 4 route ReDoS (GHSA-37ch-88jc-xwx2)',
				floor: '0.1.13',
			},
			{
				name: 'axios',
				reason: 'binance REST client SSRF and prototype-pollution credential leak',
				floor: '1.20.0',
			},
			{
				name: 'proxy-addr',
				reason: 'trusted-proxy header spoofing (GHSA-jqcg-44mw-7w3h)',
				floor: '2.0.8',
			},
			{
				name: '@fastify/busboy',
				reason: 'firebase-admin multipart parser DoS',
				floor: '3.2.2',
			},
			{
				name: '@protobufjs/utf8',
				reason: 'overlong UTF-8 decoding (GHSA-q6x5-8v7m-xcrf)',
				floor: '1.1.1',
			},
			{
				name: 'qs',
				reason: 'prototype pollution in query parsing',
				floor: '6.16.0',
			},
			{
				name: 'source-map-js',
				reason: 'event-loop denial of service',
				floor: '1.2.2',
			},
			{
				name: 'body-parser',
				reason: 'the express 4 pin is 1.20.3',
				floor: '1.20.6',
			},
			{
				name: 'uuid',
				reason: 'missing buffer bounds check in v3/v5/v6',
				floor: '11.1.1',
			},
		];

		for (const { name, reason, floor } of CASES) {
			it(`${name} resolves at or above ${floor} (${reason})`, () => {
				const versions = resolvedVersions(lockfile, name);
				expect(versions.length).toBeGreaterThan(0);
				const below = versions.filter(
					(v) => /^\d/.test(v) && v.localeCompare(floor, undefined, { numeric: true }) < 0
				);
				expect(below).toEqual([]);
			});
		}

		it('drops the binance build toolchain instead of pinning it', () => {
			const overrides = readOverrides();
			for (const dep of ['webpack', 'ts-loader', 'source-map-loader', 'webpack-cli']) {
				expect(overrides).toContain(`binance>${dep}: '-'`);
				expect(resolvedVersions(lockfile, dep)).toEqual([]);
			}
		});
	});

	describe('firebase-admin stays on the 12.x line', () => {
		it('is not upgraded to the API-breaking 13/14 line', () => {
			const range = readPackageJson().dependencies['firebase-admin'];
			expect(range).toMatch(/\^12\./);
		});

		it('keeps the credential and Firestore API surface the codebase calls', () => {
			// jest's moduleNameMapper rewrites every `firebase-admin` specifier to
			// __mocks__/, including require.resolve, so load the real entry point by
			// path. Asserting the mock instead would defeat the purpose of the test.
			const realAdmin = require(path.join(
				REPO_ROOT,
				'node_modules/firebase-admin/lib/index.js'
			));
			expect(typeof realAdmin.initializeApp).toBe('function');
			expect(typeof realAdmin.credential.cert).toBe('function');
			expect(typeof realAdmin.credential.applicationDefault).toBe('function');
			expect(typeof realAdmin.firestore).toBe('function');
			expect(typeof realAdmin.firestore.FieldPath.documentId).toBe('function');
			expect(typeof realAdmin.firestore.FieldValue.serverTimestamp).toBe('function');
			expect(typeof realAdmin.auth).toBe('function');
			expect(typeof realAdmin.remoteConfig).toBe('function');
			expect(typeof realAdmin.appCheck).toBe('function');
		});

		it('reaches only the node-forge parser, never signature verification', () => {
			const credentialInternal = fs.readFileSync(
				path.join(REPO_ROOT, 'node_modules/firebase-admin/lib/app/credential-internal.js'),
				'utf8'
			);
			const forgeCalls = [...credentialInternal.matchAll(/forge\.\w+/g)].map((m) => m[0]);
			expect(new Set(forgeCalls)).toEqual(new Set(['forge.pki']));
			expect(credentialInternal).not.toMatch(/verify|createSignature/i);
		});
	});

	describe('auditConfig suppression is a single, justified entry', () => {
		it('ignores only the unpatchable node-forge signature-verification advisory', () => {
			const ignored = readOverrides()
				.split('ignoreGhsas:')[1]
				.split('\n')
				.map((line) => line.trim())
				.filter((line) => line.startsWith('- '))
				.map((line) => line.slice(2));
			expect(ignored).toEqual(['GHSA-86w9-cpqp-85rv']);
		});

		it('records the reachability argument next to the ignore it justifies', () => {
			expect(readOverrides()).toMatch(/GHSA-86w9-cpqp-85rv[\s\S]{0,600}unreachable here/);
		});
	});

	describe('the advisory gate itself', () => {
		it('reports no critical or high finding at --audit-level=high', () => {
			let stdout = '';
			let exitCode = 0;
			try {
				stdout = execFileSync('pnpm', ['audit', '--audit-level=high', '--json'], {
					cwd: REPO_ROOT,
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'ignore'],
					env: { ...process.env, npm_config_loglevel: 'silent' },
				});
			} catch (error) {
				stdout = error.stdout || '';
				exitCode = error.status;
			}

			const report = JSON.parse(stdout);
			const advisories = Object.values(report.advisories || {});
			const blocking = advisories.filter(
				(a) => a.severity === 'high' || a.severity === 'critical'
			);

			expect(
				blocking.map((a) => `${a.severity}:${a.module_name}:${a.github_advisory_id}`)
			).toEqual([]);
			expect(exitCode).toBe(0);
		}, 180000);
	});
});