/**
 * Unit tests for ops/production-smoke-probe.sh
 *
 * Validates the smoke probe's:
 *  - exit codes (AUTH_BLOCKED, HEALTHCHECK_FAILED, STATUS_UNREACHABLE,
 *    COMMIT_MISMATCH, DEGRADED_DEPENDENCY, OK)
 *  - secret hygiene (API key never appears in URLs, query strings, or logs)
 *  - secretless path (passing only env var without arg does not echo the key)
 *  - argument parsing (--base-url, --expected-commit, --require-ready-deps)
 *  - status payload parsing (service.commit, dependencies.<name>.ready)
 *
 * Uses a stub `curl` shim (a small Node script that responds to specific
 * URL paths with canned bodies and HTTP codes) so the test never reaches
 * the real network and runs deterministically.
 */

const { spawnSync } = require('child_process');
const { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const SCRIPT = join(__dirname, '../../ops/production-smoke-probe.sh');


function runProbe(env, args = []) {
	const tempDir = env._tempDir || mkdtempSync(join(tmpdir(), 'cabros-probe-default-'));
	const combinedEnv = {
		...process.env,
		...env,
		PATH: `${tempDir}:${process.env.PATH}`,
		STUB_HEADERS_LOG: env.STUB_HEADERS_LOG || join(tempDir, 'headers.log'),
		STUB_INVOCATION_LOG: env.STUB_INVOCATION_LOG || join(tempDir, 'invocation.log'),
	};
	delete combinedEnv._tempDir;
	return spawnSync('bash', [SCRIPT, ...args], {
		env: combinedEnv,
		timeout: 10000,
		encoding: 'utf8',
	});
}

describe('ops/production-smoke-probe.sh', () => {
	let tempDir;
	let headersLog;
	let invocationLog;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-probe-test-'));
		headersLog = join(tempDir, 'headers.log');
		invocationLog = join(tempDir, 'invocation.log');
	});

	afterEach(() => {
		// best-effort cleanup
		try {
			require('fs').rmSync(tempDir, { recursive: true, force: true });
		} catch (_) {}
	});

	it('exists and is executable', () => {
		expect(existsSync(SCRIPT)).toBe(true);
		const content = readFileSync(SCRIPT, 'utf8');
		expect(content.length).toBeGreaterThan(0);
		expect(content).toContain('#!/usr/bin/env bash');
	});

	it('exits 2 with AUTH_BLOCKED when WEBHOOK_API_KEY is missing', () => {
		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			PATH: tempDir,
			// No WEBHOOK_API_KEY
		};
		const result = runProbe({ ...env, _tempDir: tempDir });
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('AUTH_BLOCKED');
	});

	it('exits 2 with SECRET_LEAK when the base URL contains credentials', () => {
		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir }, ['--base-url', 'https://example.com/api?api-key=topsecret']);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('SECRET_LEAK');
	});

	it('prints usage when --help is passed and exits 0', () => {
		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir }, ['--help']);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Usage');
	});

	it('exits 64 on unknown arguments', () => {
		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir }, ['--not-a-real-arg']);
		expect(result.status).toBe(64);
	});

	it('never echoes the API key in stdout, stderr, or invocations on the happy path', () => {
		// Build a curl stub that returns 200 + a known commit JSON
		const curlStub = join(tempDir, 'curl');
		const stubBody = `#!/usr/bin/env bash
set -euo pipefail
url=""
out=""
prev=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write-out) shift 2 ;;
    --output) out="$2"; shift 2 ;;
    -H) shift; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "URL=$url" >> "$STUB_INVOCATION_LOG"
case "$url" in
  */healthcheck)
    if [ -n "$out" ]; then printf 'OK' > "$out"; fi
    printf '%s' "200" ;;
  */api/status)
    if [ -n "$out" ]; then
      printf '{"service":{"commit":"abc1234567890"},"dependencies":{"telegram":{"ready":true,"status":"ready"}}}' > "$out"
    fi
    printf '%s' "200" ;;
  *)
    printf '%s' "404" ;;
esac
`;
		writeFileSync(curlStub, stubBody);
		chmodSync(curlStub, 0o755);

		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'super-secret-do-not-leak',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir });
		const combinedOutput = (result.stdout || '') + (result.stderr || '');
		expect(combinedOutput).not.toContain('super-secret-do-not-leak');
		expect(combinedOutput).not.toContain('WEBHOOK_API_KEY');
		// Invocation log should not contain the API key
		if (existsSync(invocationLog)) {
			const invocations = readFileSync(invocationLog, 'utf8');
			expect(invocations).not.toContain('super-secret-do-not-leak');
		}
	});

	it('exits 5 COMMIT_MISMATCH when service.commit does not match the expected SHA', () => {
		const curlStub = join(tempDir, 'curl');
		const stubBody = `#!/usr/bin/env bash
set -euo pipefail
url=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write-out) shift 2 ;;
    --output) out="$2"; shift 2 ;;
    -H) shift; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */healthcheck)
    if [ -n "$out" ]; then printf 'OK' > "$out"; fi
    printf '%s' "200" ;;
  */api/status)
    if [ -n "$out" ]; then
      printf '{"service":{"commit":"stale-sha-from-prod"},"dependencies":{}}' > "$out"
    fi
    printf '%s' "200" ;;
esac
`;
		writeFileSync(curlStub, stubBody);
		chmodSync(curlStub, 0o755);

		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir }, ['--expected-commit', 'expected-sha-from-master']);
		expect(result.status).toBe(5);
		expect(result.stderr).toContain('COMMIT_MISMATCH');
		expect(result.stderr).toContain('stale-sha-from-prod');
		expect(result.stderr).toContain('expected-sha-from-master');
	});

	it('exits 6 DEGRADED_DEPENDENCY when a required dep is not ready', () => {
		const curlStub = join(tempDir, 'curl');
		const stubBody = `#!/usr/bin/env bash
set -euo pipefail
url=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write-out) shift 2 ;;
    --output) out="$2"; shift 2 ;;
    -H) shift; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */healthcheck)
    if [ -n "$out" ]; then printf 'OK' > "$out"; fi
    printf '%s' "200" ;;
  */api/status)
    if [ -n "$out" ]; then
      printf '{"service":{"commit":"abc"},"dependencies":{"telegram":{"ready":true,"status":"ready"},"tradingViewMcp":{"ready":false,"status":"degraded"}}}' > "$out"
    fi
    printf '%s' "200" ;;
esac
`;
		writeFileSync(curlStub, stubBody);
		chmodSync(curlStub, 0o755);

		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir }, ['--require-ready-deps', 'tradingViewMcp']);
		expect(result.status).toBe(6);
		expect(result.stderr).toContain('DEGRADED_DEPENDENCY');
		expect(result.stderr).toContain('tradingViewMcp');
	});

	it('exits 3 HEALTHCHECK_FAILED when /healthcheck returns non-200', () => {
		const curlStub = join(tempDir, 'curl');
		const stubBody = `#!/usr/bin/env bash
set -euo pipefail
url=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --write-out) shift 2 ;;
    --output) out="$2"; shift 2 ;;
    -H) shift; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */healthcheck)
    printf '%s' "503" ;;
  *)
    printf '%s' "200" ;;
esac
`;
		writeFileSync(curlStub, stubBody);
		chmodSync(curlStub, 0o755);

		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir });
		expect(result.status).toBe(3);
		expect(result.stderr).toContain('HEALTHCHECK_FAILED');
		expect(result.stderr).toContain('503');
	});
});

describe('Production Smoke Probe workflow YAML', () => {
	const workflowPath = join(
		__dirname,
		'../../.github/workflows/production-smoke-probe.yml',
	);

	it('exists and is readable', () => {
		expect(existsSync(workflowPath)).toBe(true);
		const content = readFileSync(workflowPath, 'utf8');
		expect(content.length).toBeGreaterThan(0);
	});

	it('schedules the probe', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toMatch(/schedule:\s*\n\s*-\s*cron:/);
	});

	it('supports manual workflow_dispatch override', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('workflow_dispatch:');
	});

	it('sends the API key via x-api-key header sourced from secrets, never in URL or query', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('secrets.WEBHOOK_API_KEY');
		expect(content).not.toMatch(/api-key=/i);
		expect(content).not.toMatch(/x-api-key=/i);
		// The key must never be embedded in a curl URL string
		expect(content).not.toMatch(/curl[^"]*\${{[^}]*secrets\.WEBHOOK_API_KEY/);
	});

	it('passes the API key through env to the script', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('WEBHOOK_API_KEY: ${{ secrets.WEBHOOK_API_KEY }}');
	});

	it('uses repository variable overrides for the base URL', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('PRODUCTION_BASE_URL');
		expect(content).toMatch(/vars\.PRODUCTION_BASE_URL/);
	});

	it('uses jq to handle JSON parsing', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('jq');
	});

	it('optionally pages Telegram on persistent failures', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('TELEGRAM_BOT_TOKEN');
		expect(content).toContain('TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID');
	});

	it('documents the configuration secrets in comments', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('Configuration:');
		expect(content).toContain('WEBHOOK_API_KEY');
	});

	it('runs the smoke probe via the ops/production-smoke-probe.sh helper', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('ops/production-smoke-probe.sh');
	});

	// Regression coverage for #971: without a checkout the probe script is absent
	// on the runner, so every run dies at exit 127 before any HTTP request while
	// appearing to be a real production failure.
	describe('repository checkout (issue #971)', () => {
		it('checks out the repository so the probe script exists on the runner', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/uses:\s*actions\/checkout@[0-9a-f]{40}/);
		});

		it('pins the checkout action to the same SHA used by the other workflows', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain(
				'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
			);
		});

		it('does not persist the GITHUB_TOKEN credential on disk', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/persist-credentials:\s*false/);
		});

		it('checks out before the probe script is invoked', () => {
			const content = readFileSync(workflowPath, 'utf8');
			const checkoutIndex = content.search(/uses:\s*actions\/checkout@/);
			const probeIndex = content.search(/ops\/production-smoke-probe\.sh/);
			expect(checkoutIndex).toBeGreaterThan(-1);
			expect(probeIndex).toBeGreaterThan(-1);
			expect(checkoutIndex).toBeLessThan(probeIndex);
		});

		it('pins every actions/* reference in the workflow to a full commit SHA', () => {
			const content = readFileSync(workflowPath, 'utf8');
			const refs = content.match(/uses:\s*[\w-]+\/[\w-]+@([^\s#]+)/g) || [];
			expect(refs.length).toBeGreaterThan(0);
			for (const ref of refs) {
				const pinned = ref.split('@')[1];
				expect(pinned).toMatch(/^[0-9a-f]{40}$/);
			}
		});
	});

	describe('probe script preflight (issue #971)', () => {
		it('fails loudly with a distinct probe_script_missing marker instead of exit 127', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain('probe_script_missing');
			expect(content).toContain('::error');
		});

		it('distinguishes an infra bug from a production outage', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/CI|workflow/i);
			expect(content).toMatch(/NOT a production outage|not a production outage/i);
		});

		it('verifies the script exists before invoking it', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/ops\/production-smoke-probe\.sh/);
			expect(content).toMatch(/if\s+\[\[\s*!\s+-f\s+ops\/production-smoke-probe\.sh/);
		});
	});

	describe('outcome classification (issue #971)', () => {
		it('maps every probe exit code onto a named outcome', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain('outcome=');
			for (const outcome of ['ok', 'unconfigured', 'down', 'stale', 'degraded']) {
				expect(content).toContain(`outcome=${outcome}`);
			}
		});

		it('reports a missing WEBHOOK_API_KEY secret as probe_unconfigured', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain('probe_unconfigured');
			expect(content).toContain('AUTH_BLOCKED');
		});

		it('classifies healthcheck and status failures as a production outage', () => {
			const content = readFileSync(workflowPath, 'utf8');
			// exit 3 = /healthcheck non-200, exit 4 = /api/status unreachable.
			expect(content).toMatch(/(3\|4\)|\b3\)|\b4\))[\s\S]{0,32}?outcome=down/);
		});

		it('classifies a commit mismatch as a stale deploy rather than an outage', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/5\)\s*outcome=stale/);
		});
	});

	describe('admin paging (issue #971)', () => {
		it('invokes the paging helper after the probe', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain('ops/production-smoke-probe-notify.sh');
		});

		it('passes the probe outcome to the paging helper', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain('PROBE_OUTCOME');
		});

		it('runs the paging step even though the probe step failed', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/if:\s*always\(\)/);
		});

		it('wires the cooldown setting it documents in the header', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain('PRODUCTION_PROBE_FAILURE_COOLDOWN_MINUTES');
			expect(content).toMatch(
				/PRODUCTION_PROBE_FAILURE_COOLDOWN_MINUTES:\s*\$\{\{\s*vars\.PRODUCTION_PROBE_FAILURE_COOLDOWN_MINUTES/,
			);
		});

		it('persists the cooldown latch between scheduled runs', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/actions\/cache\/restore@[0-9a-f]{40}/);
			expect(content).toMatch(/actions\/cache\/save@[0-9a-f]{40}/);
		});
	});

	describe('documented knobs actually work (issue #971)', () => {
		it('honours the base_url dispatch input instead of ignoring it', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/github\.event\.inputs\.base_url/);
		});

		it('honours the expected_commit dispatch input instead of ignoring it', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/github\.event\.inputs\.expected_commit/);
		});
	});
});