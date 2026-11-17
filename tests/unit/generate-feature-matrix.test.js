'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.join(__dirname, '..', '..');
const {
	FEATURES,
	collectEnvReadsFromSource,
	loadOpenApiPaths,
	loadStatusKeys,
	renderMatrix,
	renderMarkdown,
} = require('../../scripts/generate-feature-matrix');

describe('feature matrix generator', () => {
	describe('collectEnvReadsFromSource', () => {
		it('collects process.env.* references', () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-matrix-'));
			const srcDir = path.join(tmpDir, 'src');
			fs.mkdirSync(srcDir, { recursive: true });
			fs.writeFileSync(path.join(srcDir, 'a.js'), 'const x = process.env.ENABLE_FOO;');
			fs.writeFileSync(path.join(srcDir, 'b.js'), "process.env['BAR_TOKEN'] = 'k';");
			const refs = collectEnvReadsFromSource(tmpDir);
			expect(refs.has('ENABLE_FOO')).toBe(true);
			expect(refs.has('BAR_TOKEN')).toBe(true);
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it('collects dynamic-read helpers', () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-matrix-'));
			const srcDir = path.join(tmpDir, 'src');
			fs.mkdirSync(srcDir, { recursive: true });
			fs.writeFileSync(path.join(srcDir, 'a.js'), "parseEnvInt('NEWS_TIMEOUT_MS', 30); getSymbolsFromEnv('NEWS_SYMBOLS_CRYPTO');");
			const refs = collectEnvReadsFromSource(tmpDir);
			expect(refs.has('NEWS_TIMEOUT_MS')).toBe(true);
			expect(refs.has('NEWS_SYMBOLS_CRYPTO')).toBe(true);
			fs.rmSync(tmpDir, { recursive: true, force: true });
		});

		it('returns the real source env set when called with the repo root', () => {
			const refs = collectEnvReadsFromSource(REPO_ROOT);
			expect(refs.has('ENABLE_TELEGRAM_BOT')).toBe(true);
			expect(refs.has('WEBHOOK_API_KEY')).toBe(true);
		});
	});

	describe('loadOpenApiPaths', () => {
		it('reads paths from src/openapi/openapi.json', () => {
			const openapiPath = path.join(REPO_ROOT, 'src', 'openapi', 'openapi.json');
			const paths = loadOpenApiPaths(openapiPath);
			expect(paths.has('/api/webhook/alert')).toBe(true);
			expect(paths.has('/api/status')).toBe(true);
		});
	});

	describe('loadStatusKeys', () => {
		it('surfaces featureFlags and dependencies keys', () => {
			const keys = loadStatusKeys(path.join(REPO_ROOT, 'src', 'controllers', 'status.js'));
			expect(keys.has('featureFlags.telegramBot')).toBe(true);
			expect(keys.has('dependencies.webhookAuth')).toBe(true);
		});
	});

	describe('renderMatrix', () => {
		it('produces drift for env vars missing from src/', () => {
			const result = renderMatrix({
				features: [{ name: 'Test', primaryEnv: 'NOT_A_REAL_VAR', secondaryEnv: [], default: 'false', statusKey: null, openapiPath: null, notes: '' }],
				envRefs: new Set(),
				openApiPaths: new Set(),
				statusKeys: new Set(),
				platformInjected: new Set(),
			});
			expect(result.drift).toHaveLength(1);
			expect(result.drift[0].issues[0]).toMatch(/NOT_A_REAL_VAR/);
		});

		it('returns zero drift for a well-formed entry', () => {
			const result = renderMatrix({
				features: [{
					name: 'Webhook alert',
					primaryEnv: 'WEBHOOK_API_KEY',
					secondaryEnv: [],
					default: 'unset',
					statusKey: 'dependencies.webhookAuth',
					openapiPath: '/api/webhook/alert',
					notes: 'ok',
				}],
				envRefs: new Set(['WEBHOOK_API_KEY']),
				openApiPaths: new Set(['/api/webhook/alert']),
				statusKeys: new Set(['dependencies.webhookAuth']),
				platformInjected: new Set(),
			});
			expect(result.drift).toHaveLength(0);
		});
	});

	describe('renderMarkdown', () => {
		it('emits a clean table when drift is empty', () => {
			const md = renderMarkdown({
				rows: [{
					name: 'Webhook alert',
					primaryEnv: 'WEBHOOK_API_KEY',
					secondaryEnv: [],
					default: 'unset',
					statusKey: 'dependencies.webhookAuth',
					openapiPath: '/api/webhook/alert',
					notes: 'ok',
				}],
				drift: [],
				envRefs: new Set(['WEBHOOK_API_KEY']),
				openApiPaths: new Set(['/api/webhook/alert']),
				statusKeys: new Set(['dependencies.webhookAuth']),
			});
			expect(md).toMatch(/Feature matrix/);
			expect(md).toMatch(/No drift detected/);
			expect(md).toMatch(/Environment variables referenced in source/);
		});

		it('includes drift section when issues exist', () => {
			const md = renderMarkdown({
				rows: [{ name: 'X', primaryEnv: 'MISSING_VAR', secondaryEnv: [], default: 'false', statusKey: null, openapiPath: null, notes: '' }],
				drift: [{ feature: 'X', issues: ['primary env var `MISSING_VAR` is not referenced in src/'] }],
				envRefs: new Set(),
				openApiPaths: new Set(),
				statusKeys: new Set(),
			});
			expect(md).toMatch(/Drift detected/);
			expect(md).toMatch(/MISSING_VAR/);
		});
	});

	describe('FEATURES catalog against real source', () => {
		it('every curated entry is backed by source code (zero drift on real repo)', () => {
			const envRefs = collectEnvReadsFromSource(REPO_ROOT);
			const openApiPaths = loadOpenApiPaths(path.join(REPO_ROOT, 'src', 'openapi', 'openapi.json'));
			const statusKeys = loadStatusKeys(path.join(REPO_ROOT, 'src', 'controllers', 'status.js'));
			const { drift } = renderMatrix({
				features: FEATURES,
				envRefs,
				openApiPaths,
				statusKeys,
				platformInjected: new Set(['RENDER_GIT_COMMIT']),
			});
			expect(drift).toEqual([]);
		});
	});
});