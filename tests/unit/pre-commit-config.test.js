'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const PRE_COMMIT_PATH = path.join(ROOT, '.pre-commit-config.yaml');
const GITLEAKS_CONFIG_PATH = path.join(ROOT, '.gitleaks.toml');

describe('Pre-commit hooks configuration', () => {
	it('exists at the repository root', () => {
		expect(fs.existsSync(PRE_COMMIT_PATH)).toBe(true);
	});

	it('registers both the eslint and gitleaks hooks', () => {
		const content = fs.readFileSync(PRE_COMMIT_PATH, 'utf8');

		// eslint hook must remain untouched for backward compatibility.
		expect(content).toContain('id: eslint');
		expect(content).toContain('npm run lint');

		// gitleaks hook must be registered.
		expect(content).toContain('id: gitleaks');
	});

	it('gitleaks hook runs against staged files only and uses the repo config', () => {
		const content = fs.readFileSync(PRE_COMMIT_PATH, 'utf8');

		// The hook must invoke the staged-files mode and reference .gitleaks.toml
		// so the existing allowlists are honored.
		expect(content).toMatch(/gitleaks\s+protect\s+--staged/);
		expect(content).toContain('--config .gitleaks.toml');
	});

	it('gitleaks hook falls back to a warning when the binary is missing locally', () => {
		const content = fs.readFileSync(PRE_COMMIT_PATH, 'utf8');

		// The hook must NOT hard-fail when gitleaks is not installed; CI still
		// scans every push/PR via .github/workflows/secret-scan.yml.
		expect(content).toMatch(/command\s+-v\s+gitleaks/);
		expect(content).toMatch(/gitleaks not installed locally/);
		expect(content).toContain('secret-scan.yml');
	});

	it('gitleaks config file exists with the documented Firebase allowlist', () => {
		expect(fs.existsSync(GITLEAKS_CONFIG_PATH)).toBe(true);
		const config = fs.readFileSync(GITLEAKS_CONFIG_PATH, 'utf8');

		// The allowlist must narrowly target render.yaml — anything looser
		// would silence real findings. The path is regex-escaped (`render\.yaml`)
		// because gitleaks uses TOML literal-string paths.
		expect(config).toMatch(/render\\\.yaml/);
		expect(config).toMatch(/AIzaSy[0-9A-Za-z_-]+/);
	});

	it('does not reference the Python pre-commit framework repos', () => {
		const content = fs.readFileSync(PRE_COMMIT_PATH, 'utf8');

		// The repo wires the Node `pre-commit` package which consumes the same
		// YAML schema. None of the hooks should reach for the upstream Python
		// pre-commit repo identifiers (https://github.com/pre-commit/...) which
		// would require Python on the developer machine.
		expect(content).not.toMatch(/https:\/\/github\.com\/pre-commit\//);
	});
});