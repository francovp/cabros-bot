const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

describe('worktree setup helper (scripts/setup-worktree.sh)', () => {
	const repoRoot = path.resolve(__dirname, '../../');
	const scriptPath = path.join(repoRoot, 'scripts/setup-worktree.sh');
	let tempDirs = [];

	const createTempDir = prefix => {
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
		expect(res.stdout).toContain('setup-worktree.sh');
	});

	test('fails gracefully when executed outside a git repository', () => {
		const nonGitDir = createTempDir('non-git-dir-');
		const res = spawnSync('bash', [scriptPath], {
			cwd: nonGitDir,
			encoding: 'utf8',
		});
		expect(res.status).not.toBe(0);
		expect(res.stderr + res.stdout).toMatch(/not inside a git/i);
	});

	test('is safe for primary repository and exits 0 without modifying anything', () => {
		const res = spawnSync('bash', [scriptPath], {
			cwd: repoRoot,
			encoding: 'utf8',
		});
		expect(res.status).toBe(0);
		expect(res.stdout).toMatch(/primary repository/i);
	});

	describe('isolated git worktree execution', () => {
		let fixtureRepo;
		let fixtureWorktree;

		beforeEach(() => {
			// Initialize an isolated git repository fixture in os.tmpdir()
			fixtureRepo = createTempDir('fixture-primary-');
			execSync('git init -b master', { cwd: fixtureRepo, stdio: 'pipe' });
			execSync('git config user.email "test@example.com"', { cwd: fixtureRepo, stdio: 'pipe' });
			execSync('git config user.name "Test Committer"', { cwd: fixtureRepo, stdio: 'pipe' });

			// Create dummy committed file
			fs.writeFileSync(path.join(fixtureRepo, 'README.md'), '# Test Primary Repo\n', 'utf8');
			execSync('git add README.md && git commit -m "initial commit"', {
				cwd: fixtureRepo,
				stdio: 'pipe',
			});

			// Create mock node_modules and .pnpm-store and .env
			fs.mkdirSync(path.join(fixtureRepo, 'node_modules/.bin'), { recursive: true });
			fs.writeFileSync(path.join(fixtureRepo, 'node_modules/dummy-pkg.txt'), 'dummy', 'utf8');
			fs.writeFileSync(path.join(fixtureRepo, 'node_modules/.bin/jest'), '#!/bin/sh\necho "mock jest"', {
				mode: 0o755,
			});
			fs.mkdirSync(path.join(fixtureRepo, '.pnpm-store'), { recursive: true });
			fs.writeFileSync(path.join(fixtureRepo, '.pnpm-store/store.txt'), 'store', 'utf8');
			fs.writeFileSync(path.join(fixtureRepo, '.env'), 'TEST_KEY=123\n', 'utf8');

			// Create a secondary worktree
			fixtureWorktree = path.join(createTempDir('fixture-wt-'), 'wt');
			execSync(`git worktree add "${fixtureWorktree}" -b feature-test`, {
				cwd: fixtureRepo,
				stdio: 'pipe',
			});
		});

		test('links node_modules, .pnpm-store, and .env into the worktree', () => {
			// Initially worktree should NOT have node_modules
			expect(fs.existsSync(path.join(fixtureWorktree, 'node_modules'))).toBe(false);

			// Run setup-worktree inside the worktree
			const res = spawnSync('bash', [scriptPath], {
				cwd: fixtureWorktree,
				encoding: 'utf8',
			});
			expect(res.status).toBe(0);
			expect(res.stdout).toContain('node_modules');

			// Verify symlinks exist and point to primary repo
			const nmStats = fs.lstatSync(path.join(fixtureWorktree, 'node_modules'));
			expect(nmStats.isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(path.join(fixtureWorktree, 'node_modules'))).toBe(
				fs.realpathSync(path.join(fixtureRepo, 'node_modules')),
			);

			const pnpmStats = fs.lstatSync(path.join(fixtureWorktree, '.pnpm-store'));
			expect(pnpmStats.isSymbolicLink()).toBe(true);
			expect(fs.realpathSync(path.join(fixtureWorktree, '.pnpm-store'))).toBe(
				fs.realpathSync(path.join(fixtureRepo, '.pnpm-store')),
			);

			const envStats = fs.lstatSync(path.join(fixtureWorktree, '.env'));
			expect(envStats.isSymbolicLink()).toBe(true);
			expect(fs.readFileSync(path.join(fixtureWorktree, '.env'), 'utf8')).toBe('TEST_KEY=123\n');
		});

		test('is idempotent when run repeatedly', () => {
			const res1 = spawnSync('bash', [scriptPath], { cwd: fixtureWorktree, encoding: 'utf8' });
			expect(res1.status).toBe(0);

			const res2 = spawnSync('bash', [scriptPath], { cwd: fixtureWorktree, encoding: 'utf8' });
			expect(res2.status).toBe(0);
			expect(res2.stdout).toMatch(/already linked/i);
		});

		test('--dry-run prints actions without modifying the filesystem', () => {
			const res = spawnSync('bash', [scriptPath, '--dry-run'], {
				cwd: fixtureWorktree,
				encoding: 'utf8',
			});
			expect(res.status).toBe(0);
			expect(res.stdout).toMatch(/\[dry-run\]/i);
			expect(fs.existsSync(path.join(fixtureWorktree, 'node_modules'))).toBe(false);
		});

		test('accepts explicit target directory argument from outside', () => {
			const res = spawnSync('bash', [scriptPath, fixtureWorktree], {
				cwd: fixtureRepo,
				encoding: 'utf8',
			});
			expect(res.status).toBe(0);
			expect(fs.lstatSync(path.join(fixtureWorktree, 'node_modules')).isSymbolicLink()).toBe(true);
		});

		test('fails with clear error if primary node_modules is missing', () => {
			// Remove primary node_modules
			fs.rmSync(path.join(fixtureRepo, 'node_modules'), { recursive: true, force: true });

			const res = spawnSync('bash', [scriptPath], {
				cwd: fixtureWorktree,
				encoding: 'utf8',
			});
			expect(res.status).not.toBe(0);
			expect(res.stderr + res.stdout).toMatch(/primary.*node_modules not found/i);
		});
	});
});
