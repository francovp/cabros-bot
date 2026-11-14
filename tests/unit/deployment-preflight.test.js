const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

describe('deployment preflight helper (scripts/preflight-deployment.sh)', () => {
	const repoRoot = path.resolve(__dirname, '../../');
	const scriptPath = path.join(repoRoot, 'scripts/preflight-deployment.sh');
	let tempDirs = [];

	const createTempDir = (prefix) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				// ignore cleanup errors in test teardown
			}
		}
		tempDirs = [];
	});

	test('script exists and is marked executable', () => {
		expect(fs.existsSync(scriptPath)).toBe(true);
		const stats = fs.statSync(scriptPath);
		// Check that owner executable bit is set (0o100)
		expect(stats.mode & 0o111).toBeTruthy();
	});

	test('displays usage with --help and exits 0', () => {
		const res = spawnSync('bash', [scriptPath, '--help'], { encoding: 'utf8' });
		expect(res.status).toBe(0);
		expect(res.stdout).toContain('Usage:');
		expect(res.stdout).toContain('preflight-deployment.sh');
		expect(res.stdout).toContain('--json');
		expect(res.stdout).toContain('--url');
		expect(res.stdout).toContain('--strict');
	});

	test('fails with exit code 2 on unknown arguments', () => {
		const res = spawnSync('bash', [scriptPath, '--invalid-flag'], { encoding: 'utf8' });
		expect(res.status).toBe(2);
		expect(res.stderr).toContain('unknown option');
	});

	test('fails with exit code 2 when --url is missing an argument value', () => {
		const res = spawnSync('bash', [scriptPath, '--url'], { encoding: 'utf8' });
		expect(res.status).toBe(2);
		expect(res.stderr).toContain('--url requires a value');
	});

	test('fails with exit code 2 when --target is missing an argument value', () => {
		const res = spawnSync('bash', [scriptPath, '--target'], { encoding: 'utf8' });
		expect(res.status).toBe(2);
		expect(res.stderr).toContain('--target requires a value');
	});

	test('exits 0 and outputs SKIPPED (render CLI unavailable) in human-readable mode', () => {
		// Run with empty PATH to ensure render is not found
		const res = spawnSync('bash', [scriptPath], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: '/bin:/usr/bin',
				RENDER_API_KEY: '',
			},
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toContain('[preflight]');
		expect(res.stdout).toMatch(/SKIPPED \(render CLI unavailable/);
	});

	test('emits valid machine-readable JSON matching the preflight schema with --json', () => {
		const res = spawnSync('bash', [scriptPath, '--json'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: '/bin:/usr/bin',
				RENDER_API_KEY: '',
			},
		});
		expect(res.status).toBe(0);
		const json = JSON.parse(res.stdout);
		expect(json).toHaveProperty('status');
		expect(['ready', 'skipped', 'blocked']).toContain(json.status);
		expect(json).toHaveProperty('activeInspection');
		expect(typeof json.activeInspection).toBe('boolean');
		expect(json).toHaveProperty('message');
		expect(json.message).toContain('render CLI');
		expect(json).toHaveProperty('renderCli');
		expect(json.renderCli.available).toBe(false);
		expect(json.renderCli.authenticated).toBe(false);
		expect(json).toHaveProperty('clis');
		expect(json.clis.render).toBeDefined();
		expect(json.clis.railway).toBeDefined();
		expect(json.clis.gh).toBeDefined();
		expect(json).toHaveProperty('fallbacks');
		expect(json.fallbacks.githubDeployments).toBeDefined();
		expect(json.fallbacks.healthcheck).toBeDefined();
	});

	test('configures healthcheck fallback url correctly with --url', () => {
		const res = spawnSync('bash', [scriptPath, '--url', 'https://example.com/app', '--json'], {
			encoding: 'utf8',
		});
		expect(res.status).toBe(0);
		const json = JSON.parse(res.stdout);
		expect(json.fallbacks.healthcheck.configured).toBe(true);
		expect(json.fallbacks.healthcheck.url).toBe('https://example.com/app/healthcheck');
	});

	test('does not duplicate /healthcheck suffix if already provided in --url', () => {
		const res = spawnSync('bash', [scriptPath, '--url', 'https://example.com/healthcheck', '--json'], {
			encoding: 'utf8',
		});
		expect(res.status).toBe(0);
		const json = JSON.parse(res.stdout);
		expect(json.fallbacks.healthcheck.configured).toBe(true);
		expect(json.fallbacks.healthcheck.url).toBe('https://example.com/healthcheck');
	});

	test('resolves production URL with --target production', () => {
		const res = spawnSync('bash', [scriptPath, '--target', 'production', '--json'], {
			encoding: 'utf8',
		});
		expect(res.status).toBe(0);
		const json = JSON.parse(res.stdout);
		expect(json.fallbacks.healthcheck.configured).toBe(true);
		expect(json.fallbacks.healthcheck.url).toContain('.onrender.com/healthcheck');
	});

	test('detects authenticated render CLI when present on PATH', () => {
		const mockBinDir = createTempDir('mock-render-bin-');
		const mockRenderScript = path.join(mockBinDir, 'render');
		fs.writeFileSync(mockRenderScript, '#!/usr/bin/env bash\nif [ "$1" = "version" ]; then echo "render v1.2.3"; exit 0; fi\nif [ "$1" = "whoami" ]; then echo "user@example.com"; exit 0; fi\nexit 0\n');
		fs.chmodSync(mockRenderScript, 0o755);

		const res = spawnSync('bash', [scriptPath, '--json'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${mockBinDir}:${process.env.PATH}`,
			},
		});

		expect(res.status).toBe(0);
		const json = JSON.parse(res.stdout);
		expect(json.status).toBe('ready');
		expect(json.activeInspection).toBe(true);
		expect(json.renderCli.available).toBe(true);
		expect(json.renderCli.authenticated).toBe(true);
		expect(json.renderCli.version).toContain('v1.2.3');
	});

	test('detects authenticated render CLI when RENDER_API_KEY is supplied', () => {
		const mockBinDir = createTempDir('mock-render-bin-');
		const mockRenderScript = path.join(mockBinDir, 'render');
		fs.writeFileSync(mockRenderScript, '#!/usr/bin/env bash\nif [ "$1" = "version" ]; then echo "render v2.0.0"; exit 0; fi\nexit 1\n');
		fs.chmodSync(mockRenderScript, 0o755);

		const res = spawnSync('bash', [scriptPath, '--json'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${mockBinDir}:${process.env.PATH}`,
				RENDER_API_KEY: 'rnd_secret_key',
			},
		});

		expect(res.status).toBe(0);
		const json = JSON.parse(res.stdout);
		expect(json.status).toBe('ready');
		expect(json.activeInspection).toBe(true);
		expect(json.renderCli.available).toBe(true);
		expect(json.renderCli.authenticated).toBe(true);
	});

	test('handles multiline render version output and special characters safely', () => {
		const mockBinDir = createTempDir('mock-render-multiline-');
		const mockRenderScript = path.join(mockBinDir, 'render');
		fs.writeFileSync(
			mockRenderScript,
			'#!/usr/bin/env bash\nif [ "$1" = "version" ]; then echo \'render "cli" v3.4.5\'; echo \'Extra build info line 2\'; echo \'Extra info line 3\'; exit 0; fi\nexit 0\n'
		);
		fs.chmodSync(mockRenderScript, 0o755);

		const res = spawnSync('bash', [scriptPath, '--json'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${mockBinDir}:${process.env.PATH}`,
				RENDER_API_KEY: 'rnd_secret_key',
			},
		});

		expect(res.status).toBe(0);
		// JSON.parse must succeed without syntax errors from raw newlines or unescaped quotes
		const json = JSON.parse(res.stdout);
		expect(json.status).toBe('ready');
		expect(json.renderCli.version).toBe('render "cli" v3.4.5');
		expect(json.clis.render.version).toBe('render "cli" v3.4.5');
	});

	test('reports blocked and exits 1 in strict mode when no verification channels are available', () => {
		const mockBinDir = createTempDir('mock-no-clis-');
		// Mask gh so ambient host gh CLI in CI runner cannot evaluate to authenticated
		const mockGhScript = path.join(mockBinDir, 'gh');
		fs.writeFileSync(mockGhScript, '#!/usr/bin/env bash\nexit 1\n');
		fs.chmodSync(mockGhScript, 0o755);

		const res = spawnSync('bash', [scriptPath, '--strict', '--json'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${mockBinDir}:/bin:/usr/bin`,
				RENDER_API_KEY: '',
				RAILWAY_TOKEN: '',
				GH_TOKEN: '',
				GITHUB_TOKEN: '',
			},
		});

		expect(res.status).toBe(1);
		const json = JSON.parse(res.stdout);
		expect(json.status).toBe('blocked');
		expect(json.message).toContain('BLOCKED');
	});

	test('does not exit 1 in non-strict mode when no verification channels are available (avoids false GLOBAL_BLOCKED)', () => {
		const mockBinDir = createTempDir('mock-no-clis-');
		const mockGhScript = path.join(mockBinDir, 'gh');
		fs.writeFileSync(mockGhScript, '#!/usr/bin/env bash\nexit 1\n');
		fs.chmodSync(mockGhScript, 0o755);

		const res = spawnSync('bash', [scriptPath, '--json'], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${mockBinDir}:/bin:/usr/bin`,
				RENDER_API_KEY: '',
				RAILWAY_TOKEN: '',
				GH_TOKEN: '',
				GITHUB_TOKEN: '',
			},
		});

		expect(res.status).toBe(0);
		const json = JSON.parse(res.stdout);
		expect(json.status).toBe('skipped');
		expect(json.message).toContain('SKIPPED');
	});
});
