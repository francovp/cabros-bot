const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WORKSPACE_YAML_PATH = path.join(REPO_ROOT, 'pnpm-workspace.yaml');
const LOCKFILE_PATH = path.join(REPO_ROOT, 'pnpm-lock.yaml');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');
const CI_WORKFLOW_PATH = path.join(REPO_ROOT, '.github/workflows/node.js.yml');
const AUDIT_GATE_PATH = path.join(REPO_ROOT, 'scripts/audit-advisories.js');

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

	describe('minimatch is scoped per consumer, never pinned to one major', () => {
		// A bare `minimatch:` override forces a semver-major onto every consumer.
		// minimatch 10's CommonJS entry point is a namespace object rather than the
		// directly-callable export the 3.x/6.x lines ship, so nodemon, test-exclude@6
		// and superstatic each throw `TypeError: minimatch is not a function` -- which
		// broke `pnpm run start-dev` on the first watched-file change.
		const PATCHED_FLOOR = { 3: '3.1.4', 5: '5.1.8', 6: '6.2.2', 9: '9.0.7', 10: '10.2.3' };

		it('declares no global minimatch override', () => {
			expect(readOverrides()).not.toMatch(/^\s+minimatch:/m);
		});

		it('keeps every consumer on its own major at that line’s patched floor', () => {
			// pnpm quotes override keys containing `@`, so compare without the quotes.
			const overrides = readOverrides().replace(/'/g, '');
			for (const scope of [
				'firebase-tools>minimatch',
				'nodemon>minimatch',
				'superstatic>minimatch',
				'glob@10>minimatch',
				'test-exclude@6>minimatch',
			]) {
				expect(overrides).toContain(`${scope}: ^`);
			}

			const resolved = resolvedVersions(readLockfile(), 'minimatch');
			for (const major of Object.keys(PATCHED_FLOOR)) {
				const onLine = resolved.filter((v) => v.split('.')[0] === major);
				expect(onLine.length).toBeGreaterThan(0);
				for (const version of onLine) {
					expect(version.localeCompare(PATCHED_FLOOR[major], undefined, { numeric: true }))
						.toBeGreaterThanOrEqual(0);
				}
			}
		});

		it('leaves the callable minimatch export intact for nodemon and superstatic', () => {
			// The live assertion the broken override failed: these two consumers call
			// `minimatch(...)` directly, so a namespace-object export is a TypeError.
			// Resolve from the store copy rather than from `node_modules/<consumer>`:
			// superstatic is not a direct dependency so no root symlink exists for it,
			// and createRequire() on a missing literal path walks up past the repo and
			// resolves an unrelated minimatch -- different one locally than in CI.
			const { createRequire } = require('module');
			const store = path.join(REPO_ROOT, 'node_modules/.pnpm');
			for (const [consumer, entry] of [
				['nodemon', 'lib/monitor/match.js'],
				['superstatic', 'lib/utils/patterns.js'],
			]) {
				const storeDir = fs
					.readdirSync(store)
					.find((d) => d.startsWith(`${consumer}@`) && fs.existsSync(path.join(store, d)));
				expect([consumer, storeDir !== undefined]).toEqual([consumer, true]);

				const consumerDir = fs.realpathSync(
					path.join(store, storeDir, 'node_modules', consumer)
				);
				const requireFrom = createRequire(path.join(consumerDir, entry));
				expect([consumer, typeof requireFrom('minimatch')]).toEqual([consumer, 'function']);
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
		it('does not run the registry-backed audit inside the default suite', () => {
			// docs/environment-configuration.md promises `pnpm test` needs no external
			// network. A live `pnpm audit` here would break that on any registry outage.
			const suite = fs.readFileSync(__filename, 'utf8');
			expect(suite).not.toContain(['child', 'process'].join('_'));
		});

		it('keeps the gate as a dedicated command that CI runs as its own step', () => {
			expect(readPackageJson().scripts['audit:gate']).toBe('node scripts/audit-advisories.js');
			expect(fs.existsSync(AUDIT_GATE_PATH)).toBe(true);
			expect(fs.readFileSync(CI_WORKFLOW_PATH, 'utf8')).toMatch(/run: pnpm run audit:gate/);
		});

		it('fails closed when the audit report is unparsable', () => {
			const gate = fs.readFileSync(AUDIT_GATE_PATH, 'utf8');
			expect(gate).toMatch(/no parsable report/);
			expect(gate).toMatch(/--ignore-registry-errors/);
		});
	});
});