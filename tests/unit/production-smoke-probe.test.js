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

	it('defaults to the live Render production host, not the decommissioned Railway host', () => {
		// The probe used to default to the retired Railway host, which answers 404.
		// That kept this repo's only authenticated production check permanently red
		// while probing a host that no longer exists.
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
      printf '{"service":{"commit":"abc"},"dependencies":{},"featureFlags":{}}' > "$out"
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
			WEBHOOK_API_KEY: 'topsecret',
			// Explicitly unset so an ambient value cannot mask the script default.
			PRODUCTION_BASE_URL: '',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir });
		const combinedOutput = (result.stdout || '') + (result.stderr || '');
		expect(combinedOutput).toContain('cabros-crypto-bot-telegram.onrender.com');
		expect(combinedOutput).not.toContain('railway.app');
	});

	it('names the probed base_url in HEALTHCHECK_FAILED so a wrong target is distinguishable', () => {
		// A 404 from a decommissioned host and a 404 from a broken service are
		// indistinguishable in the log unless the message names the target.
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
printf '%s' "404"
`;
		writeFileSync(curlStub, stubBody);
		chmodSync(curlStub, 0o755);

		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir }, [
			'--base-url',
			'https://retired-host.example',
		]);
		expect(result.status).toBe(3);
		expect(result.stderr).toContain('HEALTHCHECK_FAILED');
		expect(result.stderr).toContain('https://retired-host.example');
	});

	it('exits 7 FLAG_DISABLED when a required feature flag is not enabled in production', () => {
		// This is the acceptance criterion of issue #1109: a Blueprint-declared flag
		// must be observably true on the deployed service, not just in render.yaml.
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
      printf '{"service":{"commit":"abc"},"dependencies":{},"featureFlags":{"tradingViewConfluenceEnrichment":false,"langfusePrompts":true}}' > "$out"
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
		const result = runProbe({ ...env, _tempDir: tempDir }, [
			'--require-enabled-flags',
			'tradingViewConfluenceEnrichment,langfusePrompts',
		]);
		expect(result.status).toBe(7);
		expect(result.stderr).toContain('FLAG_DISABLED');
		// The disabled flag is named; the satisfied one is not reported as a failure.
		expect(result.stderr).toContain('tradingViewConfluenceEnrichment');
		expect(result.stderr).not.toContain('langfusePrompts');
	});

	it('reports an absent feature flag as disabled rather than passing silently', () => {
		// A flag the deployed build does not expose is NOT enabled; treating absence
		// as success would let a stale build look compliant.
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
      printf '{"service":{"commit":"abc"},"dependencies":{},"featureFlags":{}}' > "$out"
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
		const result = runProbe({ ...env, _tempDir: tempDir }, [
			'--require-enabled-flags',
			'tradingViewConfluenceEnrichment',
		]);
		expect(result.status).toBe(7);
		expect(result.stderr).toContain('tradingViewConfluenceEnrichment');
	});

	it('treats a flag ABSENT from the deployed build as disabled (exit 7)', () => {
		// This is the invariant, asserted as behaviour rather than as a jq default.
		// Mutating `// false` to `// empty` used to leave this whole suite green,
		// because absence was never covered: the `!= "true"` comparison is what
		// rejects it, not the jq alternative operator.
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
      printf '{"service":{"commit":"abc"},"dependencies":{},"featureFlags":{"langfusePrompts":true}}' > "$out"
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
		const result = runProbe({ ...env, _tempDir: tempDir }, [
			'--require-enabled-flags',
			'tradingViewConfluenceEnrichment',
		]);
		expect(result.status).toBe(7);
		expect(result.stderr).toContain('FLAG_DISABLED');
		expect(result.stderr).toContain('tradingViewConfluenceEnrichment');
	});

	it('reports an absent flag without claiming the deployed build is broken', () => {
		// The diagnostic must name the flag and the probed target so an operator can
		// tell "this build is old" apart from "this feature is deliberately off".
		const curlStub = join(tempDir, 'curl');
		const stubBody = `#!/usr/bin/env bash
set -euo pipefail
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    -*) shift ;;
    *) shift ;;
  esac
done
if [ -n "$out" ]; then
  printf '{"service":{"commit":"abc"},"dependencies":{},"featureFlags":{}}' > "$out"
fi
printf '%s' "200"
`;
		writeFileSync(curlStub, stubBody);
		chmodSync(curlStub, 0o755);

		const env = {
			STUB_HEADERS_LOG: headersLog,
			STUB_INVOCATION_LOG: invocationLog,
			WEBHOOK_API_KEY: 'topsecret',
			PATH: tempDir,
		};
		const result = runProbe({ ...env, _tempDir: tempDir }, [
			'--base-url',
			'https://example.test',
			'--require-enabled-flags',
			'someFlagTheBuildDoesNotHave',
		]);
		expect(result.stderr).toContain('someFlagTheBuildDoesNotHave(value=false)');
		expect(result.stderr).toContain('https://example.test');
	});

	it('exits 0 when every required feature flag is enabled', () => {
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
      printf '{"service":{"commit":"abc"},"dependencies":{},"featureFlags":{"tradingViewConfluenceEnrichment":true,"langfusePrompts":true}}' > "$out"
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
		const result = runProbe({ ...env, _tempDir: tempDir }, [
			'--require-enabled-flags',
			'tradingViewConfluenceEnrichment,langfusePrompts',
		]);
		expect(result.status).toBe(0);
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

	it('defaults the base URL to the live Render host, not the retired Railway host', () => {
		// No PRODUCTION_BASE_URL repository variable exists, so this env fallback is
		// what actually runs; a stale value silently disables every production check.
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('cabros-crypto-bot-telegram.onrender.com');
		expect(content).not.toContain('cabros-bot-production.up.railway.app');
	});

	it('wires the PRODUCTION_REQUIRE_ENABLED_FLAGS repo-variable override', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('PRODUCTION_REQUIRE_ENABLED_FLAGS');
		expect(content).toMatch(/vars\.PRODUCTION_REQUIRE_ENABLED_FLAGS/);
	});

	it('never echoes the API key on the flag-check path', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).not.toMatch(/api-key=/i);
		expect(content).not.toMatch(/x-api-key=/i);
	});

	it('uses jq to handle JSON parsing', () => {
		const content = readFileSync(workflowPath, 'utf8');
		expect(content).toContain('jq');
	});

	it('does not claim a Telegram page it does not implement', () => {
		// This workflow has no paging step: a non-zero exit fails the scheduled job
		// and GitHub's own notification is the alert channel. The header used to
		// promise admin paging and the env block carried three variables nothing
		// read, which reads as "paging is configured" to any operator scanning it.
		const content = readFileSync(workflowPath, 'utf8');

		// Scope to the job env block: prose may legitimately name a removed variable
		// to explain why it was removed, but wiring one back in is the defect.
		const envBlock = content.slice(content.indexOf('    env:\n'));
		expect(envBlock).toBeDefined();
		for (const dead of [
			'TELEGRAM_BOT_TOKEN',
			'TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID',
			'PRODUCTION_PROBE_FAILURE_COOLDOWN_MINUTES',
		]) {
			expect(envBlock).not.toContain(`${dead}:`);
			expect(content).not.toMatch(new RegExp(`secrets\\.${dead}\\b`));
			expect(content).not.toMatch(new RegExp(`vars\\.${dead}\\b`));
		}

		// The header must not promise paging, and must still name the real channel.
		expect(content).not.toMatch(/pag(e|es|ing)\s+(the\s+)?operators/i);
		expect(content).toMatch(/no paging step/i);
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
});