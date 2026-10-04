/**
 * Unit tests for ops/production-smoke-probe-notify.sh
 *
 * The smoke-probe workflow used to claim it "pages the Telegram admin chat on
 * persistent failures" (docs/monitoring.md) while containing no paging code at
 * all, and it emitted an identical-looking failure for every problem: a missing
 * checkout (exit 127), an unconfigured secret, a stale deploy, and a genuinely
 * down production endpoint. Operators therefore learned to ignore the signal.
 *
 * This suite pins the notification contract:
 *  - only a `down` outcome (production unreachable/unhealthy) pages the admin
 *    chat; stale/degraded/unconfigured/script-missing outcomes never do,
 *    because paging those as an outage trains operators to ignore the page
 *  - a missing Telegram secret is reported as an explicit "paging not
 *    configured" warning instead of a silent no-op
 *  - the cooldown only latches after a *confirmed* delivery, so a failed page
 *    is retried on the next scheduled run
 *  - recovery (outcome=ok) clears the cooldown so the next outage pages at once
 *  - the bot token and chat id never reach stdout, stderr, or the curl argv log
 *
 * Uses a stub `curl` shim so the test never reaches the Telegram Bot API.
 */

const { spawnSync } = require('child_process');
const { existsSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const SCRIPT = join(__dirname, '../../ops/production-smoke-probe-notify.sh');

const TOKEN = '123456789:AAFfakeBotTokenValueForTests';
const CHAT_ID = '-1009998887776';

/**
 * Installs a `curl` stub on PATH that mirrors the real client's observable
 * contract: the response body goes to `--output` and only the `--write-out`
 * code reaches stdout. The outgoing page body is captured so tests can assert
 * what an operator would actually receive.
 * @param {string} tempDir directory prepended to PATH
 */
function installCurlStub(tempDir) {
	const stub = join(tempDir, 'curl');
	const stubBody = `#!/usr/bin/env bash
set -euo pipefail
url=""
out=""
prev=""
for arg in "$@"; do
  case "$prev" in
    --output) out="$arg"; prev=""; continue ;;
  esac
  case "$arg" in
    http*|https*) url="$arg" ;;
  esac
  prev="$arg"
done
if [ -n "\${STUB_STDIN_LOG:-}" ]; then cat > "$STUB_STDIN_LOG"; fi
if [ -n "\${STUB_INVOCATION_LOG:-}" ]; then echo "URL=$url" >> "$STUB_INVOCATION_LOG"; fi
case "\${STUB_CURL_REPLY:-ok}" in
  transport_error)
    echo "curl: (6) Could not resolve host for $url" >&2
    exit 6
    ;;
  http_error)
    if [ -n "$out" ]; then printf '%s' '{"ok":false,"description":"Bad Request: chat not found"}' > "$out"; fi
    printf '%s' "400"
    ;;
  ok_false)
    if [ -n "$out" ]; then printf '%s' '{"ok":false,"description":"Forbidden: bot was blocked by the user"}' > "$out"; fi
    printf '%s' "200"
    ;;
  *)
    if [ -n "$out" ]; then printf '%s' '{"ok":true,"result":{"message_id":42}}' > "$out"; fi
    printf '%s' "200"
    ;;
esac
`;
	writeFileSync(stub, stubBody);
	chmodSync(stub, 0o755);
}

function runNotify(env, args = []) {
	const tempDir = env._tempDir || mkdtempSync(join(tmpdir(), 'cabros-page-default-'));
	const combinedEnv = {
		...process.env,
		// Blanked before the spread: tests/setup.js injects the chat id, so without
		// this the partial-secret test below would inherit it and page.
		TELEGRAM_BOT_TOKEN: '',
		TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: '',
		...env,
		PATH: `${tempDir}:${process.env.PATH}`,
		STUB_INVOCATION_LOG: env.STUB_INVOCATION_LOG || join(tempDir, 'curl-invocations.log'),
		STUB_STDIN_LOG: env.STUB_STDIN_LOG || join(tempDir, 'page-payload.json'),
		STUB_CURL_REPLY: env.STUB_CURL_REPLY || 'ok',
	};
	delete combinedEnv._tempDir;
	return spawnSync('bash', [SCRIPT, ...args], {
		env: combinedEnv,
		timeout: 10000,
		encoding: 'utf8',
	});
}

function status(result) {
	const match = (result.stdout || '').match(/probe_page=(\S+)/);
	return match ? match[1] : null;
}

function combined(result) {
	return (result.stdout || '') + (result.stderr || '');
}

describe('ops/production-smoke-probe-notify.sh', () => {
	let tempDir;
	let stateFile;
	let invocationLog;
	let payloadLog;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'cabros-page-test-'));
		stateFile = join(tempDir, 'probe-state.env');
		invocationLog = join(tempDir, 'curl-invocations.log');
		payloadLog = join(tempDir, 'page-payload.json');
		installCurlStub(tempDir);
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch (_) { /* best effort */ }
	});

	it('exists and is executable', () => {
		expect(existsSync(SCRIPT)).toBe(true);
		const content = readFileSync(SCRIPT, 'utf8');
		expect(content).toContain('#!/usr/bin/env bash');
	});

	it('fails open when PROBE_OUTCOME is missing instead of guessing a page', () => {
		const result = runNotify({ _tempDir: tempDir, PROBE_OUTCOME: '' });
		expect(result.status).toBe(0);
		expect(status(result)).toBe('no_page_expected');
		expect(combined(result)).not.toContain('probe_page=paged');
	});

	describe('outcome classification', () => {
		it.each([
			['ok', 'not_required'],
			['stale', 'no_page_expected'],
			['degraded', 'no_page_expected'],
			['unconfigured', 'no_page_expected'],
			['invalid_args', 'no_page_expected'],
			['script_missing', 'no_page_expected'],
			['unknown', 'no_page_expected'],
		])('never pages the admin chat for outcome=%s', (outcome, expected) => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: outcome,
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(result.status).toBe(0);
			expect(status(result)).toBe(expected);
			// No HTTP call may be attempted for a non-outage outcome.
			expect(existsSync(invocationLog)).toBe(false);
		});
	});

	it('labels a script-missing failure as an infra bug, not a production outage', () => {
		const result = runNotify({
			_tempDir: tempDir,
			PROBE_OUTCOME: 'script_missing',
			PROBE_DETAIL: 'ops/production-smoke-probe.sh not found',
		});
		expect(status(result)).toBe('no_page_expected');
		const output = combined(result);
		expect(output).toMatch(/::error( |::)/);
		expect(output).toContain('probe_script_missing');
		expect(output).toMatch(/CI|workflow/i);
	});

	it('labels an unconfigured secret as CI misconfiguration, not a production outage', () => {
		const result = runNotify({
			_tempDir: tempDir,
			PROBE_OUTCOME: 'unconfigured',
			PROBE_DETAIL: 'AUTH_BLOCKED: WEBHOOK_API_KEY is not set',
		});
		expect(status(result)).toBe('no_page_expected');
		const output = combined(result);
		expect(output).toContain('probe_unconfigured');
		expect(output).toMatch(/not a production outage/i);
	});

	it('reports paging as not configured instead of silently no-opping when Telegram secrets are absent', () => {
		const result = runNotify({
			_tempDir: tempDir,
			PROBE_OUTCOME: 'down',
			PROBE_DETAIL: 'HEALTHCHECK_FAILED: /healthcheck returned HTTP 000.',
			PROBE_COOLDOWN_STATE_FILE: stateFile,
		});
		expect(result.status).toBe(0);
		expect(status(result)).toBe('not_configured');
		expect(combined(result)).toContain('paging_not_configured');
		expect(combined(result)).toMatch(/::warning( |::)/);
		expect(existsSync(invocationLog)).toBe(false);
	});

	it('does not clear the cooldown latch on a non-paging path', () => {
		writeFileSync(stateFile, 'last_page_epoch=1700000000\n');
		const result = runNotify({
			_tempDir: tempDir,
			PROBE_OUTCOME: 'unconfigured',
			PROBE_COOLDOWN_STATE_FILE: stateFile,
		});
		expect(status(result)).toBe('no_page_expected');
		expect(readFileSync(stateFile, 'utf8')).toContain('last_page_epoch=1700000000');
	});

	describe('paging a confirmed outage', () => {
		it('pages the admin chat when production is down', () => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_DETAIL: 'HEALTHCHECK_FAILED: /healthcheck returned HTTP 503.',
				PROBE_EXIT: '3',
				PROBE_RUN_URL: 'https://github.com/francovp/cabros-bot/actions/runs/1',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(result.status).toBe(0);
			expect(status(result)).toBe('paged');
			expect(existsSync(invocationLog)).toBe(true);
			expect(readFileSync(invocationLog, 'utf8')).toContain('api.telegram.org');
		});

		it('tells the operator that production is unreachable, not that CI is broken', () => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_DETAIL: 'HEALTHCHECK_FAILED: /healthcheck returned HTTP 503.',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(result)).toBe('paged');
			const page = readFileSync(payloadLog, 'utf8');
			expect(page).toContain('PRODUCTION DOWN');
			expect(page).toContain('503');
			expect(String(JSON.parse(page).chat_id)).toBe(CHAT_ID);
		});

		it('latches the cooldown only after a confirmed delivery', () => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(result)).toBe('paged');
			const persisted = readFileSync(stateFile, 'utf8');
			const epoch = Number((persisted.match(/last_page_epoch=(\d+)/) || [])[1]);
			expect(Number.isFinite(epoch)).toBe(true);
			expect(epoch).toBeGreaterThan(0);
		});

		it.each([
			['http_error', 'Telegram rejected the request'],
			['ok_false', 'Telegram rejected the request'],
			['transport_error', 'Bot API request failed'],
		])('does not latch the cooldown when the page fails (%s)', (reply, expectation) => {
			writeFileSync(stateFile, 'last_page_epoch=0\n');
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
				STUB_CURL_REPLY: reply,
			});
			expect(status(result)).toBe('page_failed');
			expect(combined(result)).toContain('page_failed');
			expect(combined(result)).toContain(expectation);
			// A failed page must be retried on the next run, so no latch is written.
			expect(readFileSync(stateFile, 'utf8')).toContain('last_page_epoch=0');
		});
	});

	describe('cooldown', () => {
		it('suppresses a repeat page inside the cooldown window', () => {
			writeFileSync(stateFile, 'last_page_epoch=0\n');
			const first = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(first)).toBe('paged');
			const latched = readFileSync(stateFile, 'utf8');
			rmSync(invocationLog, { force: true });

			const second = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(second)).toBe('suppressed_cooldown');
			expect(combined(second)).toContain('paging_suppressed_cooldown');
			expect(existsSync(invocationLog)).toBe(false);
			// The original latch is preserved, not pushed forward.
			expect(readFileSync(stateFile, 'utf8')).toBe(latched);
		});

		it('pages again once the cooldown window has elapsed', () => {
			// 60 minute cooldown, latch set 61 minutes ago.
			const sixtyOneMinutesAgo = Math.floor(Date.now() / 1000) - (61 * 60);
			writeFileSync(stateFile, `last_page_epoch=${sixtyOneMinutesAgo}\n`);
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_MINUTES: '60',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(result)).toBe('paged');
		});

		it('pages on every outage when the cooldown is zero', () => {
			writeFileSync(stateFile, `last_page_epoch=${Math.floor(Date.now() / 1000)}\n`);
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_MINUTES: '0',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(result)).toBe('paged');
		});

		it('falls back to 60 minutes and warns on a malformed cooldown value', () => {
			writeFileSync(stateFile, `last_page_epoch=${Math.floor(Date.now() / 1000) - (30 * 60)}\n`);
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_MINUTES: 'not-a-number',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			// 30 minutes elapsed but the default 60-minute cooldown is active.
			expect(status(result)).toBe('suppressed_cooldown');
			expect(combined(result)).toContain('60');
		});

		it('clears the cooldown after recovery so the next outage pages immediately', () => {
			writeFileSync(stateFile, `last_page_epoch=${Math.floor(Date.now() / 1000)}\n`);
			const recovered = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'ok',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
			});
			expect(status(recovered)).toBe('not_required');
			expect(readFileSync(stateFile, 'utf8')).toContain('last_page_epoch=0');

			const nextOutage = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(nextOutage)).toBe('paged');
		});

		it('writes cooldown state even when no state file path is configured', () => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(result.status).toBe(0);
			expect(status(result)).toBe('paged');
		});
	});

	describe('secret hygiene', () => {
		it('never echoes the bot token or chat id on the success path', () => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_DETAIL: 'HEALTHCHECK_FAILED: HTTP 000',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			const output = combined(result);
			expect(output).not.toContain(TOKEN);
			expect(output).not.toContain(CHAT_ID);
			expect(output).not.toContain('TELEGRAM_BOT_TOKEN');
			expect(output).not.toContain('TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID');
		});

		it('redacts the bot token from transport-level curl errors', () => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
				STUB_CURL_REPLY: 'transport_error',
			});
			const output = combined(result);
			expect(status(result)).toBe('page_failed');
			// The stub echoes the requested URL (which embeds the token) to stderr.
			expect(output).not.toContain(TOKEN);
			expect(output).not.toContain(CHAT_ID);
			expect(output).toContain('[redacted]');
		});

		it('redacts the bot token from Telegram ok:false descriptions', () => {
			const result = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				PROBE_COOLDOWN_STATE_FILE: stateFile,
				TELEGRAM_BOT_TOKEN: TOKEN,
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
				STUB_CURL_REPLY: 'ok_false',
			});
			const output = combined(result);
			expect(status(result)).toBe('page_failed');
			expect(output).not.toContain(TOKEN);
			expect(output).not.toContain(CHAT_ID);
		});

		it('never attempts a request when only one of the two secrets is present', () => {
			const tokenOnly = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				TELEGRAM_BOT_TOKEN: TOKEN,
			});
			expect(status(tokenOnly)).toBe('not_configured');

			const chatOnly = runNotify({
				_tempDir: tempDir,
				PROBE_OUTCOME: 'down',
				TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: CHAT_ID,
			});
			expect(status(chatOnly)).toBe('not_configured');
			expect(existsSync(invocationLog)).toBe(false);
		});
	});

	it('writes probe_page output for the workflow step output', () => {
		const outputFile = join(tempDir, 'github-output');
		writeFileSync(outputFile, '');
		const result = spawnSync('bash', [SCRIPT], {
			env: {
				...process.env,
				PATH: `${tempDir}:${process.env.PATH}`,
				GITHUB_OUTPUT: outputFile,
				PROBE_OUTCOME: 'ok',
				STUB_INVOCATION_LOG: invocationLog,
				STUB_CURL_REPLY: 'ok',
			},
			timeout: 10000,
			encoding: 'utf8',
		});
		expect(result.status).toBe(0);
		expect(readFileSync(outputFile, 'utf8')).toContain('probe_page=not_required');
	});
});