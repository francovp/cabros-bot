const { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');

const fetchCapabilities = join(
	__dirname,
	'../../.agents/skills/detect-unused-features/scripts/fetch-capabilities.sh',
);
const skillPath = join(
	__dirname,
	'../../.agents/skills/detect-unused-features/SKILL.md',
);

function runFetch(apiKey) {
	const tempDir = mkdtempSync(join(tmpdir(), 'detect-unused-features-'));
	const curlArgsPath = join(tempDir, 'curl-args');
	const curlStdinPath = join(tempDir, 'curl-stdin');
	const curlPath = join(tempDir, 'curl');

	writeFileSync(
		curlPath,
		'#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CURL_ARGS_FILE"\ncat > "$CURL_STDIN_FILE"\nprintf \'%s\\n\' \'{"featureFlags":{}}\'\n',
	);
	chmodSync(curlPath, 0o755);

	const env = { ...process.env, CAPABILITIES_URL: 'https://example.test/api/capabilities' };
	delete env.WEBHOOK_API_KEY;
	if (apiKey) env.WEBHOOK_API_KEY = apiKey;
	env.PATH = `${tempDir}:${env.PATH}`;
	env.CURL_ARGS_FILE = curlArgsPath;
	env.CURL_STDIN_FILE = curlStdinPath;

	const result = spawnSync('bash', [fetchCapabilities], { env, encoding: 'utf8' });
	const curlArgs = existsSync(curlArgsPath) ? readFileSync(curlArgsPath, 'utf8') : '';
	const curlStdin = existsSync(curlStdinPath) ? readFileSync(curlStdinPath, 'utf8') : '';
	rmSync(tempDir, { recursive: true, force: true });

	return { ...result, curlArgs, curlStdin };
}

describe('detect-unused-features capabilities fetch', () => {
	it('sends WEBHOOK_API_KEY as x-api-key without printing the secret', () => {
		const result = runFetch('test-key');

		expect(result.status).toBe(0);
		expect(result.stdout).toBe('{"featureFlags":{}}\n');
		expect(result.stdout).not.toContain('test-key');
		expect(result.stderr).not.toContain('test-key');
		expect(result.curlArgs).not.toContain('--location');
		expect(result.curlArgs).toContain('@-');
		expect(result.curlArgs).not.toContain('test-key');
		expect(result.curlStdin).toBe('x-api-key: test-key\n');
	});

	it('stops before curl when WEBHOOK_API_KEY is missing', () => {
		const result = runFetch();

		expect(result.status).toBe(78);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('AUTH_BLOCKED');
		expect(result.stderr).toContain('WEBHOOK_API_KEY is not set');
		expect(result.curlArgs).toBe('');
		expect(result.curlStdin).toBe('');
	});

	it('derives audit findings from fresh capabilities and repository files', () => {
		const skill = readFileSync(skillPath, 'utf8');

		expect(skill).toContain('select(.value == false)');
		expect(skill).toContain('.dependencies.sentry.profiling');
		expect(skill).toContain('comm -23');
		expect(skill).not.toContain('Reference: Production featureFlags (as of June 2026)');
		expect(skill).not.toContain('### Known gaps (env vars used in code but NOT in status.js featureFlags)');
		expect(skill).not.toContain('The production response shows:');
	});
});
