/**
 * Regression tests binding the probed preview URL to the commit it actually
 * serves (issue #1129).
 *
 * Before the fix, `verify-preview.sh` resolved the URL by walking deployments
 * newest-first until it found a `success`/`active` status, but validated
 * `EXPECTED_SHA` against `deployments?...&per_page=1` — the *newest* deployment
 * regardless of its status. So with the newest deployment still `pending` and a
 * previous deployment `success`, the SHA check passed against the pending
 * commit while the health checks probed the older deployment's URL. The merge
 * gate could therefore bless a stale build.
 *
 * These tests pin:
 *  - `get-pr-deployment-url.sh --details` reports the sha/state/url of the SAME
 *    deployment record, so a caller cannot pair a URL with another commit.
 *  - `verify-preview.sh` rejects the newest-pending + previous-successful case
 *    with exit 2 when the selected URL is not serving `EXPECTED_SHA`.
 *  - `verify-preview.sh` cross-checks the served build via `/api/status`
 *    (`service.commit`) and fails closed on a proven mismatch.
 *  - Backward compatibility: default `get-pr-deployment-url.sh` output is still
 *    the bare URL.
 *  - Secret hygiene: `WEBHOOK_API_KEY` never reaches a URL, log line, or the
 *    curl invocation log.
 *
 * Everything is driven by fake `gh`/`curl` binaries on PATH, so the suite never
 * touches the network or the real gh auth state.
 */

const {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} = require('fs');
const { spawnSync } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');

const SCRIPTS_DIR = join(__dirname, '../../.agents/skills/issue-automator/scripts');
const GET_URL_SCRIPT = join(SCRIPTS_DIR, 'get-pr-deployment-url.sh');
const VERIFY_SCRIPT = join(SCRIPTS_DIR, 'verify-preview.sh');

const HEAD_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const STALE_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// --- Fake gh -------------------------------------------------------------
// The stub branches on the caller's `--jq` projection so both the current and
// the fixed code path see a realistic API response:
//   `.[] | "\(.id)\t\(.sha // "")"` → `id<TAB>sha` rows, newest first (fixed script)
//   `.[].id`                       → bare ids, newest first (legacy resolver)
//   `.[0].sha // empty`            → only the newest deployment's sha (legacy check)
// That separation is what reproduces the bug: the legacy SHA check reads the
// newest deployment while the URL resolver walks past it to an older one.
const GH_STUB = `#!/usr/bin/env bash
ARGS="$*"

case "$ARGS" in
  *"auth status"*)
    echo "github.com"
    echo "  - Logged in to github.com account francovp (keyring)"
    exit 0
    ;;
  *"auth switch"*) exit 0 ;;
  *"headRefName"*) printf '%s\\n' "$STUB_PR_BRANCH"; exit 0 ;;
esac

if [ "$1" = "api" ]; then
  ENDPOINT=""
  JQ=""
  EXPECT_JQ=0
  for arg in "$@"; do
    case "$arg" in
      repos/*) ENDPOINT="$arg" ;;
    esac
    if [ "$EXPECT_JQ" = "1" ]; then JQ="$arg"; EXPECT_JQ=0; fi
    if [ "$arg" = "--jq" ]; then EXPECT_JQ=1; fi
  done

  case "$ENDPOINT" in
    *"/statuses"*)
      DEP_ID="$(printf '%s' "$ENDPOINT" | sed -n 's#.*/deployments/\\([0-9][0-9]*\\)/statuses.*#\\1#p')"
      case "$DEP_ID" in
        1) printf '%s\\n' "$STUB_STATUS_1" ;;
        2) printf '%s\\n' "$STUB_STATUS_2" ;;
        3) printf '%s\\n' "$STUB_STATUS_3" ;;
        *) exit 1 ;;
      esac
      exit 0
      ;;
    *"/deployments/"*)
      # Single-deployment lookup used only to recover a missing sha.
      DEP_ID="$(printf '%s' "$ENDPOINT" | sed -n 's#.*/deployments/\\([0-9][0-9]*\\)$#\\1#p')"
      case "$DEP_ID" in
        1) printf '%s\\n' "$STUB_SHA_1" ;;
        2) printf '%s\\n' "$STUB_SHA_2" ;;
        3) printf '%s\\n' "$STUB_SHA_3" ;;
        *) exit 1 ;;
      esac
      exit 0
      ;;
    *"/deployments"*)
      case "$JQ" in
        *'\\(.id)'*) printf '%b\\n' "$STUB_DEPLOYMENT_ROWS"; exit 0 ;;
        *'.[].id'*) printf '%b\\n' "$STUB_DEPLOYMENT_IDS"; exit 0 ;;
        *'.[0].sha'*) printf '%s\\n' "$STUB_NEWEST_SHA"; exit 0 ;;
      esac
      exit 1
      ;;
  esac
fi

exit 1
`;

// --- Fake curl -----------------------------------------------------------
// Emits `<body>\\n<status>` to mirror real `curl -s -w '\\n%{http_code}'`.
const CURL_STUB = `#!/usr/bin/env bash
url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -w|--write-out) shift 2 ;;
    -H|--header) shift 2 ;;
    -o|--output) shift 2 ;;
    -w*|--write-out*) shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done

case "$url" in
  */healthcheck) printf '%s\\n%s' '{"status":"ok"}' '200' ;;
  */openapi.json) printf '%s\\n%s' '{"openapi":"3.1.0"}' '200' ;;
  */api/status) printf '%s\\n%s' "$STUB_SERVED_STATUS_BODY" "$STUB_SERVED_STATUS_CODE" ;;
  *) printf '%s\\n%s' '{"error":"not found"}' '404' ;;
esac
`;

function writeStub(tempDir, name, body) {
	const stubPath = join(tempDir, name);
	writeFileSync(stubPath, body);
	chmodSync(stubPath, 0o755);
	return stubPath;
}

/**
 * @param {object} options
 * @param {string} options.deploymentRows - `id\tsha` rows, newest first.
 * @param {Record<string,string>} options.statuses - deployment id -> status JSON.
 * @param {Record<string,string>} options.shas - deployment id -> sha (single lookup).
 * @param {string} [options.servedStatusBody] - body served at /api/status.
 * @param {string} [options.servedStatusCode] - status code served at /api/status.
 * @param {Record<string,string>} [options.env] - extra env for the child process.
 */
function runScript(scriptPath, args, options) {
	const tempDir = mkdtempSync(join(tmpdir(), 'verify-preview-binding-'));
	const invocationLog = join(tempDir, 'curl-invocations.log');
	const rows = options.deploymentRows || '';

	try {
		writeStub(tempDir, 'gh', GH_STUB);
		writeFileSync(join(tempDir, 'curl'), CURL_STUB.replace(
			'url=""',
			'url=""\necho "$@" >> "$STUB_CURL_INVOCATION_LOG"',
		));
		chmodSync(join(tempDir, 'curl'), 0o755);

		const result = spawnSync('bash', [scriptPath, ...args], {
			env: {
				...process.env,
				PATH: `${tempDir}:${process.env.PATH}`,
				REPO: 'francovp/cabros-bot',
				STUB_PR_BRANCH: 'swarm/issue-1129-ada',
				STUB_DEPLOYMENT_ROWS: rows,
				STUB_DEPLOYMENT_IDS: rows.split('\n').filter(Boolean).map((row) => row.split('\t')[0]).join('\n'),
				STUB_NEWEST_SHA: rows ? rows.split('\n')[0].split('\t')[1] : '',
				STUB_SERVED_STATUS_BODY: options.servedStatusBody || '{"service":{"commit":"' + HEAD_SHA + '"}}',
				STUB_SERVED_STATUS_CODE: options.servedStatusCode || '200',
				STUB_CURL_INVOCATION_LOG: invocationLog,
				// Keep the retry loop snappy under test; defaults are 3 / 5s.
				VERIFY_PREVIEW_MAX_ATTEMPTS: '1',
				VERIFY_PREVIEW_RETRY_DELAY_SECONDS: '0',
				...(options.statuses
					? Object.fromEntries(Object.entries(options.statuses).map(([id, body]) => [`STUB_STATUS_${id}`, body]))
					: {}),
				...(options.shas
					? Object.fromEntries(Object.entries(options.shas).map(([id, sha]) => [`STUB_SHA_${id}`, sha]))
					: {}),
				...(options.env || {}),
			},
			encoding: 'utf8',
			timeout: 20000,
		});

		return {
			...result,
			invocationLog: existsSync(invocationLog) ? readFileSync(invocationLog, 'utf8') : '',
		};
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

// Newest deployment is still `pending`; the previous one succeeded. This is the
// exact shape that used to slip through: URL from deployment 1, SHA from
// deployment 2.
const PENDING_THEN_SUCCESS_ROWS = `2\t${HEAD_SHA}\n1\t${STALE_SHA}`;
const PENDING_THEN_SUCCESS_STATUSES = {
	2: JSON.stringify({ state: 'pending', url: 'https://newest-pending.up.railway.app' }),
	1: JSON.stringify({ state: 'success', url: 'https://previous-successful.up.railway.app' }),
};

describe('get-pr-deployment-url.sh --details', () => {
	it('binds sha, state and url to the same deployment record', () => {
		const result = runScript(GET_URL_SCRIPT, ['1129', '--details'], {
			deploymentRows: PENDING_THEN_SUCCESS_ROWS,
			statuses: PENDING_THEN_SUCCESS_STATUSES,
		});

		expect(result.status).toBe(0);
		const details = JSON.parse(result.stdout.trim());
		// Deployment 2 is `pending`, so the resolver must skip it and select
		// deployment 1 — and report *deployment 1's* commit, not the newest.
		expect(details).toMatchObject({
			deployment_id: '1',
			sha: STALE_SHA,
			state: 'success',
			url: 'https://previous-successful.up.railway.app',
			source: 'github-deployment',
		});
	});

	it('keeps the default stdout contract as a bare URL', () => {
		const result = runScript(GET_URL_SCRIPT, ['1129'], {
			deploymentRows: PENDING_THEN_SUCCESS_ROWS,
			statuses: PENDING_THEN_SUCCESS_STATUSES,
		});

		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe('https://previous-successful.up.railway.app');
	});

	it('reports an empty sha and a railway-fallback source when no deployment qualifies', () => {
		const result = runScript(GET_URL_SCRIPT, ['1129', '--details'], {
			deploymentRows: `2\t${HEAD_SHA}`,
			statuses: { 2: JSON.stringify({ state: 'pending', url: null }) },
		});

		expect(result.status).toBe(0);
		const details = JSON.parse(result.stdout.trim());
		expect(details.source).toBe('railway-fallback');
		expect(details.sha).toBe('');
		expect(details.url).toBe('https://cabros-bot-cabros-bot-pr-1129.up.railway.app');
		expect(result.stderr).toContain('Falling back to Railway URL');
	});

	it('rejects unknown flags', () => {
		const result = runScript(GET_URL_SCRIPT, ['1129', '--nope'], {
			deploymentRows: PENDING_THEN_SUCCESS_ROWS,
			statuses: PENDING_THEN_SUCCESS_STATUSES,
		});

		expect(result.status).toBe(64);
		expect(result.stderr).toContain('Usage:');
	});
});

describe('verify-preview.sh deployment/SHA binding', () => {
	it('fails with exit 2 when the selected URL is an older deployment than EXPECTED_SHA', () => {
		// EXPECTED_SHA is the newest (still pending) commit. The URL resolver can
		// only select the previous successful deployment, so the probed build is
		// stale even though the newest deployment carries the expected commit.
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA], {
			deploymentRows: PENDING_THEN_SUCCESS_ROWS,
			statuses: PENDING_THEN_SUCCESS_STATUSES,
		});

		expect(result.status).toBe(2);
		const output = `${result.stdout}${result.stderr}`;
		expect(output).toContain('Stale deploy detected');
		expect(output).toContain(HEAD_SHA);
		expect(output).toContain(STALE_SHA);
		// It must bail out before probing the stale URL.
		expect(result.invocationLog).not.toContain('previous-successful.up.railway.app');
	});

	it('passes the bound-SHA check when EXPECTED_SHA matches the selected deployment', () => {
		const result = runScript(VERIFY_SCRIPT, ['1129', '', STALE_SHA], {
			deploymentRows: PENDING_THEN_SUCCESS_ROWS,
			statuses: PENDING_THEN_SUCCESS_STATUSES,
			// The probed URL really does serve the selected deployment's commit.
			servedStatusBody: JSON.stringify({ service: { commit: STALE_SHA } }),
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('SHA match');
		expect(result.stdout).toContain('Success: Deployment PR #1129 is live and healthy');
	});

	it('accepts a short EXPECTED_SHA that prefixes the bound sha', () => {
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA.slice(0, 10)], {
			deploymentRows: `2\t${HEAD_SHA}`,
			statuses: { 2: JSON.stringify({ state: 'success', url: 'https://newest-ok.up.railway.app' }) },
			servedStatusBody: JSON.stringify({ service: { commit: HEAD_SHA } }),
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('SHA match');
	});

	it('fails with exit 2 when the bound sha matches but the URL serves another commit', () => {
		// GitHub says the selected deployment is the expected commit, but the
		// deployment that actually answers is an older build.
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA], {
			deploymentRows: `2\t${HEAD_SHA}`,
			statuses: { 2: JSON.stringify({ state: 'success', url: 'https://bound-but-old.up.railway.app' }) },
			servedStatusBody: JSON.stringify({ service: { commit: STALE_SHA } }),
			env: { WEBHOOK_API_KEY: 'super-secret-do-not-leak' },
		});

		expect(result.status).toBe(2);
		const output = `${result.stdout}${result.stderr}`;
		expect(output).toContain('Stale deploy detected');
		expect(output).toContain('Served SHA');
		expect(output).toContain(STALE_SHA);
	});

	it('proves the served build through /api/status without leaking the API key', () => {
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA], {
			deploymentRows: `2\t${HEAD_SHA}`,
			statuses: { 2: JSON.stringify({ state: 'success', url: 'https://bound-ok.up.railway.app' }) },
			servedStatusBody: JSON.stringify({ service: { commit: HEAD_SHA } }),
			env: { WEBHOOK_API_KEY: 'super-secret-do-not-leak' },
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Served-build match');
		// The key travels in the x-api-key header, never in the URL or output.
		expect(result.invocationLog).toContain('-H x-api-key: super-secret-do-not-leak');
		expect(result.invocationLog).not.toMatch(/api-key=[^ ]/);
		expect(`${result.stdout}${result.stderr}`).not.toContain('super-secret-do-not-leak');
	});

	it('warns but does not fail when the served commit cannot be proven', () => {
		// /api/status is auth-gated: absence of evidence is not evidence of a
		// stale deploy, so the bound-SHA result stands on its own.
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA], {
			deploymentRows: `2\t${HEAD_SHA}`,
			statuses: { 2: JSON.stringify({ state: 'success', url: 'https://bound-ok.up.railway.app' }) },
			servedStatusCode: '403',
			servedStatusBody: '{"error":"Forbidden"}',
			env: { WEBHOOK_API_KEY: 'super-secret-do-not-leak' },
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toContain('served-commit check skipped');
		expect(result.stdout).toContain('Success: Deployment PR #1129 is live and healthy');
	});

	it('warns but does not fail when WEBHOOK_API_KEY is unavailable', () => {
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA], {
			deploymentRows: `2\t${HEAD_SHA}`,
			statuses: { 2: JSON.stringify({ state: 'success', url: 'https://bound-ok.up.railway.app' }) },
			env: { WEBHOOK_API_KEY: '' },
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toContain('WEBHOOK_API_KEY is unset');
		// Nothing may be requested without a key.
		expect(result.invocationLog).not.toContain('/api/status');
	});

	it('warns but does not fail when /api/status omits service.commit', () => {
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA], {
			deploymentRows: `2\t${HEAD_SHA}`,
			statuses: { 2: JSON.stringify({ state: 'success', url: 'https://bound-ok.up.railway.app' }) },
			servedStatusBody: JSON.stringify({ service: { name: 'cabros-bot', commit: null } }),
			env: { WEBHOOK_API_KEY: 'super-secret-do-not-leak' },
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toContain('did not report service.commit');
	});

	it('still validates the served commit on the Railway-pattern fallback path', () => {
		// No GitHub deployment exists, so there is no bound sha to check. The
		// served-build probe is the only remaining evidence.
		const result = runScript(VERIFY_SCRIPT, ['1129', '', HEAD_SHA], {
			deploymentRows: '',
			statuses: {},
			servedStatusBody: JSON.stringify({ service: { commit: STALE_SHA } }),
			env: { WEBHOOK_API_KEY: 'super-secret-do-not-leak' },
		});

		expect(result.status).toBe(2);
		expect(`${result.stdout}${result.stderr}`).toContain('Stale deploy detected');
		expect(result.stderr).toContain('could not determine the commit of the selected deployment');
	});

	it('keeps production verification free of SHA checks', () => {
		const result = runScript(VERIFY_SCRIPT, ['production'], {
			deploymentRows: '',
			statuses: {},
			env: { PRODUCTION_URL: 'https://cabros-bot-production.up.railway.app' },
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Verifying deployment for production');
		expect(result.stdout).toContain('Success: Deployment production is live and healthy');
		expect(result.invocationLog).not.toContain('/api/status');
	});
});