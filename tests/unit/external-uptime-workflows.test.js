/**
 * Contract tests for the external uptime monitoring workflows (#1107).
 *
 * The six-day production outage happened because a scheduled monitor was hollow:
 * it died before making a request (issue #971) and nothing in CI failed when it
 * stopped working. These assertions are the guard rail that keeps the two
 * workflows from being edited back into that shape — a future change that drops
 * the checkout, swallows the exit code, reintroduces a secret, or re-phases the
 * watchdog onto the monitor's own cron must fail `pnpm test`, not production.
 *
 * No YAML dependency exists in this repository, so the assertions are made
 * against the file text. That is deliberate: these tests check the guarantees a
 * YAML parse would not enforce anyway (pinned refs, absence of `|| true`,
 * presence of specific env wiring).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { EXIT_CODES } = require('../../ops/external-uptime-monitor.js');

const WORKFLOWS_DIR = path.join(__dirname, '../../.github/workflows');
const MONITOR_FILE = path.join(WORKFLOWS_DIR, 'external-uptime-monitor.yml');
const WATCHDOG_FILE = path.join(WORKFLOWS_DIR, 'external-uptime-watchdog.yml');
const MONITOR_SCRIPT = 'ops/external-uptime-monitor.js';
const DEFAULT_BASE_URL = 'https://cabros-bot-production.up.railway.app';
const DEFAULT_CHECK_DOCS = 'true';
const DEFAULT_TIMEOUT_MS = '10000';
const PINNED_CHECKOUT = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';

function readWorkflow(filePath) {
	return fs.readFileSync(filePath, 'utf8');
}

// Absence assertions run against comment-stripped YAML: these workflows
// document their own guarantees in comments, and a comment that says
// "no continue-on-error here" must not be mistaken for a violation.
function stripComments(content) {
	return content
		.split('\n')
		.map((line) => line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''))
		.join('\n');
}

function stepBlock(content, stepName) {
	const start = content.indexOf(`- name: ${stepName}`);
	if (start === -1) {
		return null;
	}
	const next = content.indexOf('\n      - ', start + 1);
	return next === -1 ? content.slice(start) : content.slice(start, next);
}

function scheduleCron(content) {
	const scheduleBlock = content.slice(content.indexOf('schedule:'), content.indexOf('workflow_dispatch'));
	const match = scheduleBlock.match(/cron:\s*'([^']+)'/);
	return match ? match[1] : null;
}

describe('external uptime monitor workflow', () => {
	let content;

	beforeAll(() => {
		content = readWorkflow(MONITOR_FILE);
	});

	it('exists on the default branch so the schedule actually fires', () => {
		expect(fs.existsSync(MONITOR_FILE)).toBe(true);
		expect(content).toContain('name: External Uptime Monitor');
		expect(content).toMatch(/^on:$/m);
	});

	it('polls every five minutes and stays manually dispatchable', () => {
		expect(scheduleCron(content)).toBe('*/5 * * * *');
		expect(content).toContain('workflow_dispatch');
	});

	it('checks out the repository with a SHA-pinned action and no persisted credentials', () => {
		// Without checkout the job dies at exit 127 before probing anything:
		// the #971 hollow-monitor failure.
		expect(content).toContain(PINNED_CHECKOUT);
		expect(content).toContain('persist-credentials: false');
	});

	it('runs the monitor script from the checked-out repository', () => {
		expect(content).toContain(`node ${MONITOR_SCRIPT}`);
	});

	it('never swallows a failing verdict', () => {
		const code = stripComments(content);
		expect(code).not.toContain('continue-on-error');
		const probeStep = stepBlock(code, 'Run the external uptime monitor');
		expect(probeStep).not.toBeNull();
		expect(probeStep).not.toContain('|| true');
		expect(probeStep).not.toContain('set +e');
		expect(probeStep).not.toContain('exit 0');
	});

	it('degrades to a documented default rather than failing when the run history is unreadable', () => {
		const historyStep = stepBlock(stripComments(content), 'Read the previous run conclusion');
		expect(historyStep).toContain('::notice::');
		expect(historyStep).toContain('conclusion="none"');
	});

	it('reads the previous run conclusion to drive down/recovery paging', () => {
		expect(content).toContain('actions: read');
		expect(content).toContain('--previous-conclusion');
		expect(content).toContain('UPTIME_MONITOR_PREVIOUS_CONCLUSION');
	});

	it('wires every documented repository variable with a default', () => {
		expect(content).toContain('vars.UPTIME_MONITOR_BASE_URL');
		expect(content).toContain('vars.UPTIME_MONITOR_CHECK_DOCS');
		expect(content).toContain('vars.UPTIME_MONITOR_TIMEOUT_MS');
		// A missing variable must degrade to the documented default rather than to
		// an empty target that silently reports DOWN.
		expect(content).toContain(`|| '${DEFAULT_BASE_URL}'`);
		expect(content).toContain(`|| '${DEFAULT_CHECK_DOCS}'`);
		expect(content).toContain(`|| '${DEFAULT_TIMEOUT_MS}'`);
	});

	it('exposes the optional Telegram paging secrets only as secret references', () => {
		expect(content).toContain('secrets.TELEGRAM_BOT_TOKEN');
		expect(content).toContain('secrets.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID');
	});

	it('stays secretless — no API key may reach a third-party monitor', () => {
		expect(stripComments(content)).not.toContain('WEBHOOK_API_KEY');
		expect(content).not.toMatch(/x-api-key/);
		expect(content).not.toMatch(/secrets\.[A-Z_]*API_KEY/);
	});

	it('defaults manual runs to no paging so an operator test cannot page the admin chat', () => {
		expect(content).toContain('UPTIME_MONITOR_DISABLE_PAGE');
		expect(content).toContain('force_page');
	});

	it('still allows scheduled runs to page', () => {
		// `inputs` is empty on a schedule event, so a condition keyed only on
		// `inputs.force_page` would evaluate to "disabled" and silently switch the
		// paging channel off for every scheduled run.
		const code = stripComments(content);
		expect(code).toContain('github.event_name == \'workflow_dispatch\'');
		expect(code).toMatch(/UPTIME_MONITOR_DISABLE_PAGE:.*event_name[^\n]*&&[^\n]*&& '1' \|\| '0'/);
	});

	it('documents exactly the exit codes the script implements', () => {
		Object.entries(EXIT_CODES).forEach(([name, code]) => {
			expect(content).toContain(`${code} ${name}`);
		});
	});

	it('never cancels an in-flight probe', () => {
		expect(content).toContain('cancel-in-progress: false');
	});
});

describe('external uptime watchdog workflow', () => {
	let content;

	beforeAll(() => {
		content = readWorkflow(WATCHDOG_FILE);
	});

	it('exists and declares the read-only permissions it needs', () => {
		expect(fs.existsSync(WATCHDOG_FILE)).toBe(true);
		expect(content).toContain('name: External Uptime Watchdog');
		expect(content).toContain('actions: read');
	});

	it('inspects the monitor workflow by filename', () => {
		expect(content).toContain('external-uptime-monitor.yml');
	});

	it('runs on a different phase than the monitor so it is not sampled in lockstep', () => {
		const watchdogCron = scheduleCron(content);
		const monitorCron = scheduleCron(readWorkflow(MONITOR_FILE));
		expect(watchdogCron).not.toBeNull();
		expect(watchdogCron).not.toBe(monitorCron);
	});

	it('does not check out the repository, so it survives a broken checkout', () => {
		expect(content).not.toContain('actions/checkout');
	});

	it('fails when the monitor has no recent run, naming the age limit', () => {
		const code = stripComments(content);
		expect(code).toContain('::error::');
		expect(code).toContain('UPTIME_WATCHDOG_MAX_AGE_MINUTES');
		expect(code).toContain('GITHUB_STEP_SUMMARY');
	});

	it('reports the last run in the step summary for triage', () => {
		expect(content).toContain('Monitor last run:');
		expect(content).toContain('html_url');
	});
});

describe('monitor documentation', () => {
	let monitoring;

	beforeAll(() => {
		monitoring = fs.readFileSync(path.join(__dirname, '../../docs/monitoring.md'), 'utf8');
	});

	it('documents both workflows and the probe script', () => {
		expect(monitoring).toContain('external-uptime-monitor.yml');
		expect(monitoring).toContain('external-uptime-watchdog.yml');
		expect(monitoring).toContain('ops/external-uptime-monitor.js');
	});

	it('documents every repository variable the workflows read', () => {
		['UPTIME_MONITOR_BASE_URL', 'UPTIME_MONITOR_CHECK_DOCS', 'UPTIME_MONITOR_TIMEOUT_MS', 'UPTIME_WATCHDOG_MAX_AGE_MINUTES']
			.forEach((name) => {
				expect(monitoring).toContain(name);
			});
	});

	it('documents every exit code the script implements', () => {
		Object.entries(EXIT_CODES).forEach(([name, code]) => {
			expect(monitoring).toContain(`\`${code}\``);
			expect(monitoring).toContain(name);
		});
	});

	it('makes platform migration a checklist item so monitoring cannot drop silently', () => {
		expect(monitoring).toMatch(/re-activation checklist/i);
	});
});