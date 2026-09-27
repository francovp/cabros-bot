'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNBOOK_PATH = path.join(REPO_ROOT, 'RUNBOOK.md');

const TELEGRAM_ERROR_CATEGORIES = new Set(['TIMEOUT', 'RATE_LIMITED', 'PAYLOAD_ERROR', 'PROVIDER_ERROR']);

const SENTRY_PROVIDER_TAGS = [
	'google-ai-studio',
	'greenapi',
	'discord-webhook',
	'binance-spot',
	'firestore-admin',
	'telegram-api',
];

const SENTRY_FEATURE_TAGS = [
	'telegram-bot',
	'tradingview-mcp',
	'signal-outcome',
	'scanner-preset-scheduler',
	'notification-redrive',
];

describe('RUNBOOK.md', () => {
	let runbook;

	beforeAll(() => {
		runbook = fs.readFileSync(RUNBOOK_PATH, 'utf8');
	});

	it('exists and stays under the 600-line cap', () => {
		const lineCount = runbook.split('\n').length;
		expect(lineCount).toBeGreaterThan(50);
		expect(lineCount).toBeLessThanOrEqual(600);
	});

	it('contains all 12 incident sections with the expected template', () => {
		for (let i = 1; i <= 12; i += 1) {
			const heading = new RegExp(`^## ${i}\\. `, 'm');
			expect(heading.test(runbook)).toBe(true);
		}

		// Each section must include the four template blocks.
		const sectionRegex = /^## (\d+)\. .+$/gm;
		const sections = [...runbook.matchAll(sectionRegex)];
		expect(sections.length).toBeGreaterThanOrEqual(12);

		const sectionBlocks = runbook.split(/^## \d+\. /m).slice(1);
		for (const [index, block] of sectionBlocks.entries()) {
			expect(block).toMatch(/\*\*Symptoms\*\*/);
			expect(block).toMatch(/\*\*First check[\s\S]*?\*\*/);
			expect(block).toMatch(/\*\*Mitigation[\s\S]*?\*\*/);
			expect(block).toMatch(/\*\*Verification\*\*/);
			expect(block).toMatch(/\*\*Postmortem prompt\*\*/);
		}
	});

	it('mentions every TelegramService errorCategory so paging stays in sync', () => {
		for (const category of TELEGRAM_ERROR_CATEGORIES) {
			expect(runbook).toContain(category);
		}
	});

	it('mentions every Sentry provider tag the runbook covers', () => {
		for (const tag of SENTRY_PROVIDER_TAGS) {
			expect(runbook).toContain(tag);
		}
		for (const tag of SENTRY_FEATURE_TAGS) {
			expect(runbook).toContain(tag);
		}
	});

	it('links from README.md and AGENTS.md', () => {
		const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
		expect(readme).toMatch(/RUNBOOK\.md/);
	});

	it('lists every section title in the appendix map', () => {
		const appendixStart = runbook.indexOf('## Appendix');
		expect(appendixStart).toBeGreaterThan(-1);
		const appendix = runbook.slice(appendixStart);
		for (let i = 1; i <= 12; i += 1) {
			expect(appendix).toMatch(new RegExp(`§${i}\\b`));
		}
	});
});
