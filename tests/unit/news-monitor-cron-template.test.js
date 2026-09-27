'use strict';

const fs = require('fs');
const path = require('path');

describe('News monitor cron workflow template (.github/workflows/news-monitor-cron.yml.example)', () => {
	const templatePath = path.join(__dirname, '../../.github/workflows/news-monitor-cron.yml.example');
	let content;

	beforeAll(() => {
		content = fs.readFileSync(templatePath, 'utf8');
	});

	it('exists and is readable', () => {
		expect(content).toBeDefined();
		expect(content.length).toBeGreaterThan(0);
	});

	it('includes x-api-key header sourced from secrets.WEBHOOK_API_KEY', () => {
		expect(content).toContain('-H "x-api-key: ${{ secrets.WEBHOOK_API_KEY }}"');
	});

	it('never puts api keys in URLs or query parameters', () => {
		expect(content).not.toMatch(/api-key=/i);
		expect(content).not.toMatch(/\${{\s*secrets\.WEBHOOK_API_KEY\s*}}.*\/api\//);
	});

	it('defaults to server-side symbol configuration instead of hardcoded overrides', () => {
		expect(content).toContain('PAYLOAD=\'{}\'');
		expect(content).toContain('-d "$PAYLOAD"');
	});

	it('documents secret requirements and optional override syntax in comments', () => {
		expect(content).toContain('WEBHOOK_API_KEY');
		expect(content).toContain('NEWS_MONITOR_BASE_URL');
		expect(content).toContain('dryRun');
	});
});
