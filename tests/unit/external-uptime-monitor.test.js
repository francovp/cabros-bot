/**
 * Unit tests for ops/external-uptime-monitor.js
 *
 * The external uptime monitor (GitHub issue #1107) is a SECRETLESS, platform
 * independent liveness detector. It probes the public `/healthcheck` route from
 * outside the hosting platform, so it can still report DOWN after the platform
 * itself removes the deployment (Railway trial expiry, account suspension,
 * domain loss) — the failure class that no in-repo CI check can observe.
 *
 * Covered here:
 *  - closed exit-code enum and its stdout JSON contract
 *  - healthcheck reachability vs. body-contract mismatch (a 200 that is not the
 *    app must never read as UP)
 *  - optional /docs secondary probe
 *  - AbortController timeout path
 *  - unexpected internal failures never exit 0
 *  - base URL sanitization (credential-bearing URLs are rejected)
 *  - the shouldPage() transition decision (page on down-transition and on
 *    recovery, stay silent while an outage continues)
 *  - fail-open, secret-free Telegram paging
 *  - GitHub step summary output
 *  - the monitor can never read WEBHOOK_API_KEY (it must not be hollow-able by
 *    an unset secret, the #971 failure class)
 *
 * `global.fetch` is always replaced by an in-memory stub: no test performs real
 * network I/O and nothing is written inside the repository working tree.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MONITOR_PATH = path.join(__dirname, '../../ops/external-uptime-monitor.js');

function loadMonitor() {
	jest.resetModules();

	return require(MONITOR_PATH);
}

function jsonResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => JSON.stringify(body),
	};
}

function htmlResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => body,
	};
}

function textResponse(body, status = 200) {
	return {
		ok: status >= 200 && status < 300,
		status,
		text: async () => body,
	};
}

function abortingFetch() {
	const impl = jest.fn((url, init) => new Promise((resolve, reject) => {
		const signal = init && init.signal;
		if (!signal) {
			resolve(jsonResponse({ uptime: 1 }));
			return;
		}
		signal.addEventListener('abort', () => {
			const error = new Error('This operation was aborted');
			error.name = 'AbortError';
			reject(error);
		});
	}));
	return impl;
}

function createWritable() {
	const chunks = [];
	return {
		write(chunk) {
			chunks.push(String(chunk));
			return true;
		},
		text() {
			return chunks.join('');
		},
	};
}

function parseSingleJsonLine(stdoutText) {
	const lines = stdoutText.split('\n').filter((line) => line.trim().length > 0);
	expect(lines).toHaveLength(1);
	return JSON.parse(lines[0]);
}

const HEALTHCHECK_OK = jsonResponse({ uptime: 42.5 });
const DOCS_OK = htmlResponse('<!doctype html><html><body>swagger-ui</body></html>');

function routerFetch(handlers) {
	return jest.fn(async (url) => {
		const key = Object.keys(handlers).find((candidate) => String(url).endsWith(candidate));
		const handler = key ? handlers[key] : jsonResponse({ error: 'not stubbed', path: String(url) }, 500);
		if (typeof handler === 'function') {
			return handler(String(url));
		}
		return handler;
	});
}

describe('ops/external-uptime-monitor.js', () => {
	let monitor;

	beforeEach(() => {
		monitor = loadMonitor();
	});

	describe('exit code contract', () => {
		it('exposes the closed exit-code enum the workflow depends on', () => {
			expect(monitor.EXIT_CODES).toEqual({
				UP: 0,
				HEALTHCHECK_UNREACHABLE: 3,
				HEALTHCHECK_BODY_UNEXPECTED: 4,
				DOCS_UNREACHABLE: 5,
				BASE_URL_INVALID: 6,
				MONITOR_INTERNAL_ERROR: 7,
			});
		});
	});

	describe('up / healthcheck reachable', () => {
		it('exits 0 when /healthcheck returns 200 with the app payload', async () => {
			const fetchImpl = routerFetch({
				'/healthcheck': HEALTHCHECK_OK,
				'/docs': DOCS_OK,
			});
			const result = await monitor.run({ baseUrl: 'https://prod.test' }, { fetchImpl });

			expect(result.status).toBe('up');
			expect(result.reason).toBe('UP');
			expect(result.exitCode).toBe(0);
			expect(result.baseUrl).toBe('https://prod.test');
			expect(result.checks).toHaveLength(2);
			expect(result.checks[0]).toMatchObject({ path: '/healthcheck', httpStatus: 200, ok: true });
			expect(typeof result.durationMs).toBe('number');
			expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it('fills defaults for a partial options object instead of probing an undefined path', async () => {
			const fetchImpl = routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': DOCS_OK });
			const result = await monitor.run({ baseUrl: 'https://prod.test' }, { fetchImpl });

			expect(result.exitCode).toBe(0);
			expect(result.checks.map((check) => check.path)).toEqual(['/healthcheck', '/docs']);
			expect(fetchImpl.mock.calls[0][0]).toBe('https://prod.test/healthcheck');
		});

		it('defaults the probe target to the canonical production URL', () => {
			expect(monitor.parseArgs([], {}).baseUrl).toBe('https://cabros-bot-production.up.railway.app');
			expect(monitor.parseArgs([], {}).checkDocs).toBe(true);
			expect(monitor.parseArgs([], {}).previousConclusion).toBe('none');
		});
	});

	describe('down / healthcheck unreachable', () => {
		it('exits 3 on a connection rejection', async () => {
			const fetchImpl = jest.fn(async () => {
				throw new TypeError('fetch failed');
			});
			const result = await monitor.run({ baseUrl: 'https://prod.test' }, { fetchImpl });

			expect(result.status).toBe('down');
			expect(result.reason).toBe('HEALTHCHECK_UNREACHABLE');
			expect(result.exitCode).toBe(3);
			expect(result.checks[0].httpStatus).toBeNull();
		});

		it('exits 3 on the platform-removed 404 body Railway returns today', async () => {
			const removed = jsonResponse({ status: 'error', code: 404, message: 'Application not found' }, 404);
			const result = await monitor.run(
				{ baseUrl: 'https://cabros-bot-production.up.railway.app' },
				{ fetchImpl: routerFetch({ '/healthcheck': removed }) },
			);

			expect(result.exitCode).toBe(3);
			expect(result.reason).toBe('HEALTHCHECK_UNREACHABLE');
			expect(result.checks[0].httpStatus).toBe(404);
		});

		it('exits 3 on 5xx', async () => {
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test' },
				{ fetchImpl: routerFetch({ '/healthcheck': jsonResponse({ error: 'boom' }, 503) }) },
			);

			expect(result.exitCode).toBe(3);
			expect(result.checks[0].httpStatus).toBe(503);
		});

		it('exits 3 and reports the timeout when the deadline elapses', async () => {
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test', timeoutMs: 5, checkDocs: false },
				{ fetchImpl: abortingFetch() },
			);

			expect(result.exitCode).toBe(3);
			expect(result.reason).toBe('HEALTHCHECK_UNREACHABLE');
			expect(result.checks[0].reason).toMatch(/timeout/i);
		});
	});

	describe('down / healthcheck body contract', () => {
		it('exits 4 when a 200 answer is not the application healthcheck', async () => {
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test', checkDocs: false },
				{ fetchImpl: routerFetch({ '/healthcheck': htmlResponse('<html>maintenance</html>') }) },
			);

			expect(result.exitCode).toBe(4);
			expect(result.reason).toBe('HEALTHCHECK_BODY_UNEXPECTED');
			expect(result.checks[0].ok).toBe(false);
			expect(result.checks[0].httpStatus).toBe(200);
		});

		it('exits 4 when the body is not JSON at all', async () => {
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test', checkDocs: false },
				{ fetchImpl: routerFetch({ '/healthcheck': textResponse('not json') }) },
			);

			expect(result.exitCode).toBe(4);
		});
	});

	describe('down / docs secondary probe', () => {
		it('exits 5 when /healthcheck is up but /docs is not reachable', async () => {
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test', checkDocs: true },
				{ fetchImpl: routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': jsonResponse({}, 404) }) },
			);

			expect(result.exitCode).toBe(5);
			expect(result.reason).toBe('DOCS_UNREACHABLE');
			expect(result.checks[0].ok).toBe(true);
			expect(result.checks[1].ok).toBe(false);
		});

		it('exits 5 when /docs answers 200 without serving the API docs', async () => {
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test', checkDocs: true },
				{ fetchImpl: routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': htmlResponse('<html>hi</html>') }) },
			);

			expect(result.exitCode).toBe(5);
		});

		it('never probes /docs when the docs check is disabled, and stays UP', async () => {
			const fetchImpl = routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': jsonResponse({}, 404) });
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test', checkDocs: false },
				{ fetchImpl },
			);

			expect(result.exitCode).toBe(0);
			expect(result.checks).toHaveLength(1);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		});
	});

	describe('base url handling', () => {
		it('exits 6 for a missing or non-http base url', async () => {
			const result = await monitor.run({ baseUrl: 'ftp://prod.test' }, { fetchImpl: routerFetch({}) });

			expect(result.exitCode).toBe(6);
			expect(result.reason).toBe('BASE_URL_INVALID');
		});

		it('refuses a credential-bearing base url without leaking the credential', async () => {
			const stdout = createWritable();
			const exitCode = await monitor.main({
				argv: ['--base-url=https://prod.test/?api-key=super-secret-value'],
				env: {},
				fetchImpl: routerFetch({}),
				stdout,
			});

			expect(exitCode).toBe(6);
			expect(stdout.text()).not.toContain('super-secret-value');
		});

		it('normalizes a trailing slash and reports only the origin', async () => {
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test/' },
				{ fetchImpl: routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': DOCS_OK }) },
			);

			expect(result.baseUrl).toBe('https://prod.test');
		});
	});

	describe('unexpected internal failures', () => {
		it('never reports UP when the response body cannot be read', async () => {
			const exploding = {
				ok: true,
				status: 200,
				text: async () => {
					throw new Error('stream closed unexpectedly');
				},
			};
			const result = await monitor.run(
				{ baseUrl: 'https://prod.test', checkDocs: false },
				{ fetchImpl: jest.fn(async () => exploding) },
			);

			// An unreadable payload means the contract could not be verified, so the
			// monitor must report DOWN. It must never fall through to exit 0.
			expect(result.status).toBe('down');
			expect(result.exitCode).toBe(3);
			expect(result.exitCode).not.toBe(0);
			expect(result.reason).toBe('HEALTHCHECK_UNREACHABLE');
		});

		it('exits 7 when the injected clock throws', async () => {
			await expect(monitor.run(
				{ baseUrl: 'https://prod.test' },
				{
					fetchImpl: routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': DOCS_OK }),
					now: () => {
						throw new Error('clock unavailable');
					},
				},
			)).resolves.toMatchObject({ exitCode: 7, reason: 'MONITOR_INTERNAL_ERROR' });
		});
	});

	describe('unparseable invocation still reports DOWN', () => {
		it('never emits status "up" alongside an internal-error verdict', async () => {
			// A monitor that cannot read its own argv has proven nothing about the
			// target. The catch block's recovery probe may legitimately observe a
			// healthy endpoint, but that probe is not the verdict: reporting it as
			// one would put status 'up' beside a MONITOR_INTERNAL_ERROR.
			const stdout = createWritable();
			const exitCode = await monitor.main({
				argv: ['--bogus-flag'],
				env: {},
				fetchImpl: routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': DOCS_OK }),
				stdout,
			});

			const emitted = parseSingleJsonLine(stdout.text());
			expect(exitCode).toBe(7);
			expect(emitted.exitCode).toBe(7);
			expect(emitted.reason).toBe('MONITOR_INTERNAL_ERROR');
			expect(emitted.status).toBe('down');
		});

		it('announces DOWN, not a recovery, when it does page', async () => {
			// previousConclusion is hardcoded 'unknown' on this path, so paging
			// stays enabled and the verdict it announces must be the down verdict.
			// A status of 'up' here silently suppressed the page entirely.
			const stdout = createWritable();
			const pageBodies = [];
			const healthy = routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': DOCS_OK });
			const exitCode = await monitor.main({
				argv: ['--bogus-flag'],
				env: {
					TELEGRAM_BOT_TOKEN: 'test-token',
					TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: '-100999',
				},
				fetchImpl: async (url, init) => {
					if (String(url).includes('api.telegram.org')) {
						pageBodies.push(String(init && init.body));
						return jsonResponse({ ok: true });
					}
					return healthy(url, init);
				},
				stdout,
			});

			const emitted = parseSingleJsonLine(stdout.text());
			expect(exitCode).toBe(7);
			expect(emitted.paging.attempted).toBe(true);
			expect(emitted.paging.delivered).toBe(true);
			expect(pageBodies).toHaveLength(1);
			expect(pageBodies[0]).toContain('Uptime monitor: DOWN');
			expect(pageBodies[0]).toContain('MONITOR_INTERNAL_ERROR');
			expect(pageBodies[0]).not.toContain('RECOVERED');
		});
	});

	describe('shouldPage transition decision', () => {
		it('pages when production goes down and the previous run was healthy', () => {
			expect(monitor.shouldPage({ ok: false, previousConclusion: 'success' })).toBe('down');
		});

		it('pages on the very first failing run', () => {
			expect(monitor.shouldPage({ ok: false, previousConclusion: 'none' })).toBe('down');
			expect(monitor.shouldPage({ ok: false, previousConclusion: 'unknown' })).toBe('down');
		});

		it('stays silent while the outage continues (GitHub already notifies)', () => {
			expect(monitor.shouldPage({ ok: false, previousConclusion: 'failure' })).toBeNull();
			expect(monitor.shouldPage({ ok: false, previousConclusion: 'timed_out' })).toBeNull();
		});

		it('pages exactly once on recovery', () => {
			expect(monitor.shouldPage({ ok: true, previousConclusion: 'failure' })).toBe('recovered');
			expect(monitor.shouldPage({ ok: true, previousConclusion: 'startup_failure' })).toBe('recovered');
			expect(monitor.shouldPage({ ok: true, previousConclusion: 'success' })).toBeNull();
			expect(monitor.shouldPage({ ok: true, previousConclusion: 'none' })).toBeNull();
		});

		it('treats an unrecognized previous conclusion as unknown, never as a failure', () => {
			expect(monitor.shouldPage({ ok: false, previousConclusion: 'garbage-value' })).toBe('down');
		});
	});

	describe('fail-open Telegram paging', () => {
		const telegramEnv = {
			TELEGRAM_BOT_TOKEN: '123456:bot-token-value',
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: '-1001234567890',
		};

		it('pages on a down transition and never exposes the bot token', async () => {
			const fetchImpl = jest.fn(async (url) => {
				if (String(url).startsWith('https://api.telegram.org/')) {
					return jsonResponse({ ok: true, result: { message_id: 7 } });
				}
				return jsonResponse({ status: 'error', code: 404, message: 'Application not found' }, 404);
			});
			const stdout = createWritable();

			const exitCode = await monitor.main({
				argv: ['--base-url=https://prod.test', '--previous-conclusion=success'],
				env: telegramEnv,
				fetchImpl,
				stdout,
			});

			expect(exitCode).toBe(3);
			const result = parseSingleJsonLine(stdout.text());
			expect(result.paging).toMatchObject({ attempted: true, delivered: true, reason: 'page_sent' });
			expect(stdout.text()).not.toContain('bot-token-value');

			const telegramCall = fetchImpl.mock.calls.find(([url]) => String(url).startsWith('https://api.telegram.org/'));
			expect(telegramCall).toBeDefined();
			expect(telegramCall[0]).toContain('bot123456:bot-token-value/sendMessage');
			const payload = JSON.parse(telegramCall[1].body);
			expect(payload.chat_id).toBe('-1001234567890');
			expect(payload.text).toMatch(/DOWN/i);
		});

		it('pages on recovery', async () => {
			const stdout = createWritable();
			const exitCode = await monitor.main({
				argv: ['--base-url=https://prod.test', '--previous-conclusion=failure'],
				env: telegramEnv,
				fetchImpl: jest.fn(async (url) => {
					if (String(url).startsWith('https://api.telegram.org/')) {
						return jsonResponse({ ok: true });
					}
					return String(url).endsWith('/docs') ? DOCS_OK : HEALTHCHECK_OK;
				}),
				stdout,
			});

			expect(exitCode).toBe(0);
			expect(parseSingleJsonLine(stdout.text()).paging.reason).toBe('page_sent');
		});

		it('does not re-page while the outage continues', async () => {
			const stdout = createWritable();
			await monitor.main({
				argv: ['--base-url=https://prod.test', '--previous-conclusion=failure'],
				env: telegramEnv,
				fetchImpl: jest.fn(async (url) => {
					if (String(url).startsWith('https://api.telegram.org/')) {
						return jsonResponse({ ok: true });
					}
					return jsonResponse({}, 404);
				}),
				stdout,
			});

			expect(parseSingleJsonLine(stdout.text()).paging.attempted).toBe(false);
		});

		it('reports paging_not_configured without changing the probe verdict', async () => {
			const stdout = createWritable();
			const exitCode = await monitor.main({
				argv: ['--base-url=https://prod.test', '--previous-conclusion=success'],
				env: {},
				fetchImpl: routerFetch({ '/healthcheck': jsonResponse({}, 404) }),
				stdout,
			});

			expect(exitCode).toBe(3);
			expect(parseSingleJsonLine(stdout.text()).paging).toMatchObject({
				attempted: false,
				delivered: false,
				reason: 'paging_not_configured',
			});
		});

		it('keeps the exit code when Telegram itself fails', async () => {
			const stdout = createWritable();
			const exitCode = await monitor.main({
				argv: ['--base-url=https://prod.test', '--previous-conclusion=success'],
				env: telegramEnv,
				fetchImpl: jest.fn(async (url) => {
					if (String(url).startsWith('https://api.telegram.org/')) {
						throw new Error('telegram unreachable');
					}
					return jsonResponse({}, 404);
				}),
				stdout,
			});

			expect(exitCode).toBe(3);
			const result = parseSingleJsonLine(stdout.text());
			expect(result.paging).toMatchObject({ attempted: true, delivered: false, reason: 'paging_failed' });
			expect(stdout.text()).not.toContain('bot-token-value');
		});

		it('honours the explicit paging opt-out used by workflow_dispatch', async () => {
			const fetchImpl = jest.fn(async () => jsonResponse({}, 404));
			const stdout = createWritable();
			await monitor.main({
				argv: ['--base-url=https://prod.test', '--previous-conclusion=success', '--no-page'],
				env: telegramEnv,
				fetchImpl,
				stdout,
			});

			expect(parseSingleJsonLine(stdout.text()).paging.reason).toBe('paging_disabled');
			expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('api.telegram.org'))).toBe(false);
		});
	});

	describe('GitHub step summary', () => {
		it('writes a bounded summary table and keeps secrets out of it', async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-summary-'));
			const summaryFile = path.join(dir, 'summary.md');
			fs.writeFileSync(summaryFile, '');
			const stdout = createWritable();

			await monitor.main({
				argv: ['--base-url=https://prod.test'],
				env: { GITHUB_STEP_SUMMARY: summaryFile, UPTIME_MONITOR_DISABLE_PAGE: '1' },
				fetchImpl: routerFetch({
					'/healthcheck': HEALTHCHECK_OK,
					'/docs': jsonResponse({}, 502),
				}),
				stdout,
			});

			const summary = fs.readFileSync(summaryFile, 'utf8');
			expect(summary).toContain('External uptime monitor');
			expect(summary).toContain('/healthcheck');
			expect(summary).toContain('DOCS_UNREACHABLE');
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it('never writes to the repository working tree when GITHUB_STEP_SUMMARY is unset', async () => {
			const stdout = createWritable();
			const before = fs.readdirSync(MONITOR_PATH.replace(/external-uptime-monitor\.js$/, ''));
			await monitor.main({
				argv: ['--base-url=https://prod.test'],
				env: { UPTIME_MONITOR_DISABLE_PAGE: '1' },
				fetchImpl: routerFetch({ '/healthcheck': HEALTHCHECK_OK, '/docs': DOCS_OK }),
				stdout,
			});
			expect(fs.readdirSync(MONITOR_PATH.replace(/external-uptime-monitor\.js$/, ''))).toEqual(before);
		});
	});

	describe('CLI entrypoint', () => {
		// The mocked tests above all inject `argv` explicitly, so they cannot see
		// an entrypoint that ignores the command line. These spawn the real CLI
		// against a loopback HTTP server (no external network) to prove the flags
		// are honoured and the process exit code carries the verdict.
		let server;
		let origin;

		beforeEach(async () => {
			const http = require('http');
			server = http.createServer((req, res) => {
				if (req.url.startsWith('/healthcheck')) {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify({ uptime: 7.5 }));
					return;
				}
				if (req.url.startsWith('/docs')) {
					res.writeHead(200, { 'content-type': 'text/html' });
					res.end('<html>swagger-ui</html>');
					return;
				}
				res.writeHead(404, { 'content-type': 'application/json' });
				res.end(JSON.stringify({ status: 'error', code: 404, message: 'Application not found' }));
			});
			await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
			origin = `http://127.0.0.1:${server.address().port}`;
		});

		afterEach(async () => {
			await new Promise((resolve) => server.close(resolve));
		});

		function runCli(args) {
			return new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [MONITOR_PATH, ...args], {
					env: { PATH: process.env.PATH, UPTIME_MONITOR_DISABLE_PAGE: '1' },
				});
				let stdout = '';
				let stderr = '';
				child.stdout.on('data', (chunk) => {
					stdout += chunk;
				});
				child.stderr.on('data', (chunk) => {
					stderr += chunk;
				});
				child.on('error', reject);
				child.on('close', (code) => resolve({ code, stdout, stderr }));
			});
		}

		it('honours --base-url and exits 0 against a healthy target', async () => {
			const outcome = await runCli([`--base-url=${origin}`, '--timeout-ms=5000']);

			expect(outcome.code).toBe(0);
			const result = parseSingleJsonLine(outcome.stdout);
			expect(result.status).toBe('up');
			expect(result.baseUrl).toBe(origin);
			expect(result.paging.reason).toBe('paging_disabled');
		}, 15000);

		it('honours --healthcheck-path against a target whose root 404s', async () => {
			const outcome = await runCli([`--base-url=${origin}/nowhere`, '--healthcheck-path=/healthcheck', '--timeout-ms=5000']);

			expect(outcome.code).toBe(0);
			expect(parseSingleJsonLine(outcome.stdout).checks[0].path).toBe('/healthcheck');
		}, 15000);

		it('exits non-zero when the target does not serve the healthcheck', async () => {
			const outcome = await runCli([`--base-url=${origin}/missing`, '--healthcheck-path=/absent', '--timeout-ms=5000']);

			expect(outcome.code).toBe(3);
			expect(parseSingleJsonLine(outcome.stdout).reason).toBe('HEALTHCHECK_UNREACHABLE');
		}, 15000);
	});

	describe('secret hygiene', () => {
		it('never references WEBHOOK_API_KEY — the monitor must stay secretless', () => {
			const source = fs.readFileSync(MONITOR_PATH, 'utf8');
			expect(source).not.toContain('WEBHOOK_API_KEY');
		});

		it('never sends an API key header to any endpoint', () => {
			const source = fs.readFileSync(MONITOR_PATH, 'utf8');
			expect(source).not.toMatch(/headers\s*:\s*\{[^}]*api[-_]?key/i);
			expect(source).not.toMatch(/setRequestHeader/i);
		});

		it('still rejects credential-bearing base URLs', () => {
			expect(monitor.CREDENTIAL_QUERY_MARKERS).toEqual(
				expect.arrayContaining(['api-key=', 'x-api-key=', 'token=']),
			);
		});

		it('depends on no third-party or application module', () => {
			const source = fs.readFileSync(MONITOR_PATH, 'utf8');
			const required = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
			expect(required.every((name) => name === 'fs' || name === 'node:fs')).toBe(true);
		});
	});
});