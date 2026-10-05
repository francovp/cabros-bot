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

	it('reports a transport failure as a single 000 rather than concatenating the fallback', () => {
		// curl emits '000' via --write-out *and* exits non-zero, which is what makes
		// the script's `|| echo '000'` fallback render "HTTP 000000".
		const curlStub = join(tempDir, 'curl');
		const stubBody = `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "000"
exit 6
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
		expect(result.stderr).toContain('HTTP 000 (probed ');
		expect(result.stderr).not.toContain('000000');
	});

	// Regression coverage: an invalid or rotated WEBHOOK_API_KEY used to exit 4,
	// which the workflow classifies as `down` — a production outage — while
	// production was healthy and delivering alerts. A 401/403 proves the server
	// answered and rejected the credential, so it needs its own code, and that code
	// is 8 because issue #1360 already shipped 7 as FLAG_DISABLED.
	describe('AUTH_REJECTED (a rotated secret is not a production outage)', () => {
		function installStatusCodeStub(code) {
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
    if [ -n "$out" ]; then printf '{"error":"Invalid API key"}' > "$out"; fi
    printf '%s' "${code}" ;;
esac
`;
			writeFileSync(curlStub, stubBody);
			chmodSync(curlStub, 0o755);
		}

		it.each(['401', '403'])(
			'exits 8 with AUTH_REJECTED (not 4) when /api/status returns %s',
			(code) => {
				installStatusCodeStub(code);

				const env = {
					STUB_HEADERS_LOG: headersLog,
					STUB_INVOCATION_LOG: invocationLog,
					WEBHOOK_API_KEY: 'rotated-and-no-longer-valid',
					PATH: tempDir,
				};
				const result = runProbe({ ...env, _tempDir: tempDir });
				expect(result.status).toBe(8);
				expect(result.status).not.toBe(4);
				expect(result.status).not.toBe(7);
				const output = (result.stdout || '') + (result.stderr || '');
				expect(output).toContain('AUTH_REJECTED');
				expect(output).toContain(code);
				// Must not claim production is unreachable.
				expect(output).not.toContain('STATUS_UNREACHABLE');
			},
		);

		it('never leaks the rejected key while reporting AUTH_REJECTED', () => {
			installStatusCodeStub('403');
			const env = {
				STUB_HEADERS_LOG: headersLog,
				STUB_INVOCATION_LOG: invocationLog,
				WEBHOOK_API_KEY: 'rotated-and-no-longer-valid',
				PATH: tempDir,
			};
			const result = runProbe({ ...env, _tempDir: tempDir });
			const output = (result.stdout || '') + (result.stderr || '');
			expect(output).not.toContain('rotated-and-no-longer-valid');
		});

		it.each(['500', '503', '404', '000'])(
			'still exits 4 for /api/status HTTP %s so real failures keep paging',
			(code) => {
				installStatusCodeStub(code);
				const env = {
					STUB_HEADERS_LOG: headersLog,
					STUB_INVOCATION_LOG: invocationLog,
					WEBHOOK_API_KEY: 'topsecret',
					PATH: tempDir,
				};
				const result = runProbe({ ...env, _tempDir: tempDir });
				expect(result.status).toBe(4);
				expect(result.stderr).toContain('STATUS_UNREACHABLE');
			},
		);

		it('still exits 3 when /healthcheck itself returns 403', () => {
			// /healthcheck is unauthenticated by design, so a 401/403 there is a
			// gateway/server response, not a credential failure.
			const curlStub = join(tempDir, 'curl');
			const stubBody = `#!/usr/bin/env bash
set -euo pipefail
printf '%s' "403"
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
		});
	});
});

describe('Production Smoke Probe workflow YAML', () => {
	const workflowPath = join(
		__dirname,
		'../../.github/workflows/production-smoke-probe.yml',
	);
	const notifyScriptPath = join(
		__dirname,
		'../../ops/production-smoke-probe-notify.sh',
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

		// A present-but-unusable script must produce the same explicit
		// script_missing outcome as an absent one, rather than dying on a bare 126.
		it('reports script_missing when the scripts stay non-executable', () => {
			const content = readFileSync(workflowPath, 'utf8');
			const lines = content.split('\n');
			const stepIndex = lines.findIndex((line) => /^\s*id:\s*preflight\s*$/.test(line));
			expect(stepIndex).toBeGreaterThan(-1);
			const runIndex = lines.findIndex(
				(line, index) => index > stepIndex && line.trim() === 'run: |',
			);
			expect(runIndex).toBeGreaterThan(-1);
			const indent = lines[runIndex].replace(/\S.*$/, '');
			const bodyIndent = `${indent}  `;
			const body = [];
			for (let i = runIndex + 1; i < lines.length; i += 1) {
				if (lines[i].trim() && !lines[i].startsWith(bodyIndent)) break;
				body.push(lines[i].startsWith(bodyIndent) ? lines[i].slice(bodyIndent.length) : lines[i]);
			}

			const dir = mkdtempSync(join(tmpdir(), 'cabros-preflight-'));
			const scriptDir = join(dir, 'ops');
			require('fs').mkdirSync(scriptDir, { recursive: true });
			for (const name of ['production-smoke-probe.sh']) {
				writeFileSync(join(scriptDir, name), '#!/usr/bin/env bash\ntrue\n', { mode: 0o644 });
			}
			const outputFile = join(dir, 'github-output');
			writeFileSync(outputFile, '');

			// A `chmod` that reports success without changing the mode: the checkout
			// is read-only, so the script remains unusable.
			const binDir = join(dir, 'bin');
			require('fs').mkdirSync(binDir, { recursive: true });
			writeFileSync(join(binDir, 'chmod'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

			const result = spawnSync('bash', ['-c', body.join('\n')], {
				cwd: dir,
				env: {
					...process.env,
					PATH: `${binDir}:${process.env.PATH}`,
					GITHUB_OUTPUT: outputFile,
				},
				timeout: 10000,
				encoding: 'utf8',
			});
			expect(result.status).not.toBe(0);
			expect(result.stdout + result.stderr).toContain('probe_script_missing');
			expect(result.stdout + result.stderr).toMatch(/NOT a production outage/i);
			expect(readFileSync(outputFile, 'utf8')).toContain('outcome=script_missing');
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

	// The string-matching assertions above cannot tell whether an exit code is
	// classified correctly; they passed while a 403 was mapped to `down` and paged
	// a healthy production as an outage. These tests execute the workflow's own
	// `case "$rc" in` block in bash and read back the resulting outcome, so a
	// misclassification fails here instead of in an operator's Telegram chat.
	describe('exit-code classifier behaves as documented', () => {
		function classify(rc) {
			const content = readFileSync(workflowPath, 'utf8');
			const lines = content.split('\n');
			const startIndex = lines.findIndex(
				(line) => /^\s*case "\$rc" in\s*$/.test(line),
			);
			expect(startIndex).toBeGreaterThan(-1);
			const indent = lines[startIndex].match(/^\s*/)[0];
			const endIndex = lines.findIndex(
				(line, index) => index > startIndex && line === `${indent}esac`,
			);
			expect(endIndex).toBeGreaterThan(-1);
			const caseBlock = lines.slice(startIndex, endIndex + 1).join('\n');

			const script = [
				'set -uo pipefail',
				`rc=${rc}`,
				'detail="SIMULATED_DETAIL"',
				caseBlock,
				'printf \'classified=%s\\n\' "$outcome"',
			].join('\n');
			const scriptPath = join(
				mkdtempSync(join(tmpdir(), 'cabros-classifier-')),
				'classify.sh',
			);
			writeFileSync(scriptPath, script);
			const result = spawnSync('bash', [scriptPath], {
				timeout: 10000,
				encoding: 'utf8',
			});
			const match = (result.stdout || '').match(/classified=(\S+)/);
			return { outcome: match ? match[1] : null, stderr: result.stderr || '' };
		}

		it.each([
			[0, 'ok'],
			[2, 'unconfigured'],
			[3, 'down'],
			[4, 'down'],
			[5, 'stale'],
			[6, 'degraded'],
			[7, 'flag_disabled'],
			[8, 'auth_rejected'],
			[64, 'invalid_args'],
			[126, 'script_missing'],
			[127, 'script_missing'],
			[1, 'unknown'],
			[9, 'unknown'],
		])('maps probe exit %i to outcome=%s', (rc, expected) => {
			expect(classify(rc).outcome).toBe(expected);
		});

		it('never classifies an exit code as down unless production really failed', () => {
			// `down` is the only verdict that claims alerts stopped flowing. Everything
			// a broken CI setup can produce must land elsewhere, or an operator reads a
			// repository or secret problem as a production outage.
			for (const rc of [2, 7, 8, 64, 126, 127, 1, 9]) {
				expect(classify(rc).outcome).not.toBe('down');
			}
		});

		it('reports a rotated secret as a CI problem in its own annotation', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toMatch(/8\)[\s\S]{0,400}?outcome=auth_rejected/);
			expect(content).toContain('probe_auth_rejected');
		});
	});

	// Issue #1360 assigned Telegram paging to the secretless external uptime
	// monitor, which pages once on a DOWN transition and once on recovery. A
	// second pager in this workflow would duplicate the DOWN page for a single
	// outage and drop the recovery signal — the alert fatigue both #1107 and
	// #971 were filed about. These assertions lock that decision in so the next
	// agent to find a "missing" pager reads why it is absent.
	describe('no duplicate pager (issue #1360 supersedes the #971 paging step)', () => {
		it('declares no Telegram secrets', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).not.toContain('TELEGRAM_BOT_TOKEN');
			expect(content).not.toContain('TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID');
		});

		it('has no cooldown latch, because nothing latches', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).not.toContain('PRODUCTION_PROBE_FAILURE_COOLDOWN_MINUTES');
			expect(content).not.toContain('actions/cache/');
		});

		it('does not reference a paging helper script', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).not.toContain('production-smoke-probe-notify.sh');
			expect(existsSync(notifyScriptPath)).toBe(false);
		});

		it('states in the header where paging actually lives', () => {
			const content = readFileSync(workflowPath, 'utf8');
			expect(content).toContain('external-uptime-monitor.yml');
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