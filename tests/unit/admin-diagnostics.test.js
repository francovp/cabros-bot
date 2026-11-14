'use strict';

const {
	evidenceEntries,
	freshnessNotice,
	orderChecks,
	checkTone,
	overallTone,
	summaryText,
} = require('../../src/admin/admin-diagnostics');

describe('admin diagnostics evidence flattening', () => {
	it('renders a bare scalar evidence value as one labelled row', () => {
		expect(evidenceEntries('permission_denied')).toEqual([{ label: 'Evidence', text: 'permission_denied' }]);
	});

	it('walks nested objects and keeps the ancestor trail on each row', () => {
		const entries = evidenceEntries({ topicRoutes: { webhookSignal: 7 }, topUp: true });

		expect(entries).toEqual([
			{ label: 'Evidence · Topic Routes · Webhook Signal', text: '7' },
			{ label: 'Evidence · Top Up', text: 'true' },
		]);
	});

	it('indexes array items instead of collapsing them', () => {
		expect(evidenceEntries({ allowedChatIds: ['-1001', '-1002'] })).toEqual([
			{ label: 'Evidence · Allowed Chat Ids 1', text: '-1001' },
			{ label: 'Evidence · Allowed Chat Ids 2', text: '-1002' },
		]);
	});

	it('says so for empty containers rather than rendering nothing', () => {
		expect(evidenceEntries({ sources: [], routes: {} })).toEqual([
			{ label: 'Evidence · Sources', text: 'No items' },
			{ label: 'Evidence · Routes', text: '—' },
		]);
	});

	it('returns no rows for absent evidence', () => {
		expect(evidenceEntries(null)).toEqual([]);
		expect(evidenceEntries(undefined)).toEqual([]);
	});

	it('cuts a circular reference instead of recursing forever', () => {
		const payload = { name: 'loop' };
		payload.self = payload;

		expect(evidenceEntries(payload)).toEqual([
			{ label: 'Evidence · Name', text: 'loop' },
			{ label: 'Evidence · Self', text: 'Circular reference' },
		]);
	});

	it('stops at the depth bound instead of walking an unbounded payload', () => {
		let payload = { leaf: 'bottom' };
		for (let depth = 0; depth < 12; depth += 1) payload = { nested: payload };

		const rows = evidenceEntries(payload);

		expect(rows.length).toBeLessThan(6);
		expect(rows.some((row) => row.text === 'bottom')).toBe(false);
		expect(rows.at(-1).text).toMatch(/fields$/);
	});
});

describe('admin diagnostics check ordering', () => {
	it('sorts failures and unknowns ahead of warnings, passes and skips', () => {
		const ordered = orderChecks([
			{ id: 'pass', status: 'pass' },
			{ id: 'skip', status: 'skipped' },
			{ id: 'warn', status: 'warn' },
			{ id: 'fail', status: 'fail' },
			{ id: 'mystery', status: 'unknown' },
		]);

		expect(ordered.map((check) => check.id)).toEqual(['fail', 'mystery', 'warn', 'pass', 'skip']);
	});

	it('treats a status it cannot interpret as needing attention rather than as a pass', () => {
		const ordered = orderChecks([
			{ id: 'pass', status: 'pass' },
			{ id: 'weird', status: 'halfway' },
		]);

		expect(ordered.map((check) => check.id)).toEqual(['weird', 'pass']);
	});

	it('breaks ties on the check id so the order is stable between renders', () => {
		const ordered = orderChecks([
			{ id: 'zeta', status: 'pass' },
			{ id: 'alpha', status: 'pass' },
		]);

		expect(ordered.map((check) => check.id)).toEqual(['alpha', 'zeta']);
	});

	it('ignores malformed entries instead of throwing', () => {
		expect(orderChecks(null)).toEqual([]);
		expect(orderChecks([null, 'nope', { id: 'ok', status: 'pass' }])).toEqual([{ id: 'ok', status: 'pass' }]);
	});
});

describe('admin diagnostics verdict vocabulary', () => {
	it('maps every contract status to the Status view badge tones', () => {
		expect(checkTone('pass')).toBe('ready');
		expect(checkTone('warn')).toBe('active');
		expect(checkTone('fail')).toBe('danger');
		expect(checkTone('skipped')).toBe('disabled');
		expect(overallTone('pass')).toBe('ready');
		expect(overallTone('fail')).toBe('danger');
	});

	it('falls back to the unknown tone for a status outside the contract', () => {
		expect(checkTone('halfway')).toBe('unknown');
		expect(overallTone(undefined)).toBe('unknown');
		expect(overallTone('HALF-WAY')).toBe('unknown');
	});

	it('reports counts in words, not only numbers', () => {
		expect(summaryText({ pass: 2, warn: 1, fail: 0, skipped: 3 }))
			.toBe('2 passed · 1 warning · 0 failed · 3 skipped');
		expect(summaryText(null)).toBe('—');
	});
});

describe('admin diagnostics freshness wording', () => {
	it('names an expired result as no longer current', () => {
		expect(freshnessNotice({ cached: true, expired: true })).toContain('no longer current');
	});

	it('marks a cached result without calling it expired', () => {
		const notice = freshnessNotice({ cached: true });

		expect(notice).toContain('Cached result');
		expect(notice).not.toContain('no longer current');
	});

	it('says nothing for a fresh run', () => {
		expect(freshnessNotice({ cached: false })).toBe('');
		expect(freshnessNotice(null)).toBe('');
	});
});
