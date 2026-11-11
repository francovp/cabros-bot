'use strict';

/* global document, window */

// Diagnostics renderer for GET /api/selftest and POST /api/selftest/run.
//
// This floor's characteristic failure is silence, so the module is deliberately
// conservative: an unrecognised status is treated as needing attention, an
// evidence value is always flattened into labelled rows rather than dumped as
// JSON, and anything malformed renders as an explicit explanation instead of an
// empty grid that would read as "everything is fine".
(function exposeDiagnostics(root, factory) {
	const api = factory();

	if (typeof module === 'object' && module.exports) {
		module.exports = api;
		return;
	}

	root.CabrosAdminDiagnostics = api;
}(typeof window === 'undefined' ? globalThis : window, () => {
	const MISSING = '—';
	const MAX_EVIDENCE_DEPTH = 6;
	const SUMMARY_KEYS = ['pass', 'warn', 'fail', 'skipped'];
	const SUMMARY_LABELS = { pass: 'passed', warn: 'warning', fail: 'failed', skipped: 'skipped' };

	// Badge tones reuse the Status view vocabulary (admin.css status-* classes) so an
	// operator reads one legend across both views instead of learning a second one.
	const CHECK_TONES = {
		pass: 'ready',
		warn: 'active',
		fail: 'danger',
		skipped: 'disabled',
		unknown: 'unknown',
	};
	const OVERALL_TONES = {
		pass: 'ready',
		warn: 'active',
		fail: 'danger',
		skipped: 'disabled',
		unknown: 'unknown',
	};
	const CHECK_LABELS = {
		pass: 'Pass',
		warn: 'Warning',
		fail: 'Fail',
		skipped: 'Skipped',
		unknown: 'Unknown',
	};

	// Attention-first, mirroring renderStatusDependencies' priority function: a failure
	// outranks an unknown, an unknown outranks a warning, and a skipped check sinks.
	// An unrecognised status ranks with the unknowns rather than the passes, because a
	// status this console cannot interpret is not evidence of health.
	const CHECK_PRIORITY = { fail: 0, unknown: 1, warn: 2, pass: 3, skipped: 4 };
	const UNKNOWN_PRIORITY = 1;

	const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

	const normalizeStatus = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

	const displayLabel = (value) => String(value ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]/g, ' ')
		.replace(/\b\w/g, (letter) => letter.toUpperCase());

	const element = (tag, options = {}) => {
		const node = document.createElement(tag);
		if (options.className) node.className = options.className;
		if (options.text !== undefined) node.textContent = options.text;
		if (options.attributes) {
			Object.entries(options.attributes).forEach(([name, value]) => node.setAttribute(name, value));
		}
		return node;
	};

	const checkTone = (status) => CHECK_TONES[normalizeStatus(status)] || 'unknown';

	const overallTone = (status) => OVERALL_TONES[normalizeStatus(status)] || 'unknown';

	const checkLabel = (status) => CHECK_LABELS[normalizeStatus(status)] || displayLabel(status || 'Unknown');

	const badge = (label, tone) => element('span', { className: `status-badge status-${tone}`, text: label });

	const formatDuration = (value) => (value !== null && value !== undefined && Number.isFinite(Number(value))
		? `${Number(value)} ms`
		: MISSING);

	const formatTimestamp = (value) => {
		if (!value) return MISSING;
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
	};

	// Number(null) and Number('') are both 0, so a missing counter would otherwise render
	// as a real "0 passed". Only a value that is actually present and numeric is counted.
	const summaryText = (summary) => {
		const totals = asObject(summary);
		const parts = SUMMARY_KEYS
			.map((key) => [key, totals[key]])
			.filter(([, count]) => count !== null && count !== undefined && count !== ''
				&& Number.isFinite(Number(count)));
		if (!parts.length) return MISSING;
		return parts.map(([key, count]) => `${count} ${SUMMARY_LABELS[key]}`).join(' · ');
	};

	const freshnessNotice = (result) => {
		const data = asObject(result);
		if (data.expired === true) {
			return 'Cached result: this self-test has expired and is no longer current. Run the self-test again for a live verdict.';
		}
		if (data.cached === true) {
			return 'Cached result: this is the last self-test result held in memory, not a live run. Run the self-test again for a live verdict.';
		}
		return '';
	};

	const valueText = (value) => {
		if (Array.isArray(value)) return `${value.length} items`;
		if (value && typeof value === 'object') return `${Object.keys(value).length} fields`;
		if (value === true) return 'Yes';
		if (value === false) return 'No';
		return String(value);
	};

	// Flattens free-form evidence into labelled rows. Objects and arrays are walked
	// rather than serialised, cycles are cut, and depth is bounded, so a provider
	// payload can neither throw the renderer nor bury the operator in raw JSON. Each
	// row keeps its ancestor trail so a nested value is still attributable.
	const evidenceEntries = (evidence, rootLabel = 'Evidence') => {
		const entries = [];
		const open = new WeakSet();
		const walk = (value, key, depth, trail) => {
			const label = trail.length ? [...trail, key].join(' · ') : key;
			if (value === null || value === undefined) return;
			const type = typeof value;
			if (type !== 'object') {
				entries.push({ label, text: String(value) });
				return;
			}
			if (depth >= MAX_EVIDENCE_DEPTH) {
				entries.push({ label, text: valueText(value) });
				return;
			}
			if (open.has(value)) {
				entries.push({ label, text: 'Circular reference' });
				return;
			}
			if (Array.isArray(value)) {
				if (!value.length) {
					entries.push({ label, text: 'No items' });
					return;
				}
				open.add(value);
				value.forEach((item, index) => walk(item, `${key} ${index + 1}`, depth + 1, trail));
				open.delete(value);
				return;
			}
			const keys = Object.keys(value);
			if (!keys.length) {
				entries.push({ label, text: MISSING });
				return;
			}
			open.add(value);
			const nested = [...trail, key];
			keys.forEach((child) => walk(value[child], displayLabel(child), depth + 1, nested));
			open.delete(value);
		};
		walk(evidence, rootLabel, 0, []);
		return entries;
	};

	const orderChecks = (checks) => (Array.isArray(checks) ? checks : [])
		.filter((check) => check && typeof check === 'object')
		.slice()
		.sort((left, right) => {
			const priority = (check) => CHECK_PRIORITY[normalizeStatus(check.status)] ?? UNKNOWN_PRIORITY;
			return priority(left) - priority(right)
				|| String(left.id ?? '').localeCompare(String(right.id ?? ''));
		});

	const metricCard = (label, value, meta) => {
		const card = element('article', { className: 'metric-card' });
		card.append(
			element('p', { className: 'metric-label', text: label }),
			element('strong', { className: 'metric-value', text: String(value) }),
			element('p', { className: 'metric-meta', text: meta || '' }),
		);
		return card;
	};

	const definitionList = (rows, className) => {
		const list = element('dl', { className });
		rows.forEach(({ label, text }) => {
			list.append(
				element('dt', { text: label }),
				element('dd', { text: String(text) }),
			);
		});
		return list;
	};

	const createCheckCard = (check) => {
		const status = normalizeStatus(check.status);
		const card = element('article', { className: 'status-card selftest-check' });
		const copy = element('div');
		const checkId = check.id === undefined || check.id === null ? 'unnamed check' : String(check.id);
		copy.append(
			element('strong', { text: displayLabel(checkId) }),
			element('small', { text: check.message ? String(check.message) : 'No message reported.' }),
		);
		const meta = element('div', { className: 'selftest-check-meta' });
		meta.append(
			badge(checkLabel(status), checkTone(status)),
			element('span', { className: 'selftest-duration', text: formatDuration(check.durationMs) }),
		);
		const head = element('div', { className: 'section-heading' });
		head.append(copy, meta);
		card.append(head);
		card.append(element('p', { className: 'mono-line', text: checkId }));
		const entries = evidenceEntries(check.evidence);
		if (entries.length) {
			card.append(definitionList(entries, 'evidence-list status-detail-list'));
		}
		return card;
	};

	const createServiceBlock = (service) => {
		const rows = [
			{ label: 'Name', text: service.name },
			{ label: 'Version', text: service.version },
			{ label: 'Commit', text: service.commit },
			{ label: 'Node', text: service.nodeVersion },
			{ label: 'Uptime', text: service.uptimeSec === null || service.uptimeSec === undefined ? undefined : `${service.uptimeSec} s` },
		].filter((row) => row.text !== undefined && row.text !== null && row.text !== '');
		if (!rows.length) return null;
		const block = element('div', { className: 'detail-block' });
		block.append(
			element('h4', { text: 'Service' }),
			definitionList(rows, 'selftest-service status-detail-list'),
		);
		return block;
	};

	const createVerdict = (result) => {
		const status = normalizeStatus(result.status);
		const wrap = element('div', { className: 'selftest-verdict' });
		wrap.append(
			element('p', { className: 'eyebrow', text: 'Self-test verdict' }),
			badge(checkLabel(status), overallTone(status)),
		);
		return wrap;
	};

	// Renders one SelfTestResult. An absent or empty checks array is reported as a
	// plain explanation, never as an empty grid.
	const renderSelfTest = (result) => {
		const data = asObject(result);
		const report = element('article', { className: 'operation-card selftest-report' });
		report.append(createVerdict(data));
		report.append(element('p', { className: 'selftest-totals', text: summaryText(data.summary) }));

		const metrics = element('div', { className: 'metric-grid' });
		metrics.append(
			metricCard('Started', formatTimestamp(data.startedAt), 'Suite start'),
			metricCard('Finished', formatTimestamp(data.finishedAt), 'Suite end'),
			metricCard('Duration', formatDuration(data.durationMs), 'Wall clock'),
		);
		report.append(metrics);

		const notice = freshnessNotice(data);
		if (notice) {
			report.append(element('p', {
				className: 'request-state selftest-notice',
				text: notice,
				attributes: { role: 'status' },
			}));
		}
		if (typeof data.message === 'string' && data.message.trim()) {
			report.append(element('p', { className: 'request-state', text: data.message }));
		}

		const service = createServiceBlock(asObject(data.service));
		if (service) report.append(service);
		if (data.requestId) {
			report.append(element('p', { className: 'request-state', text: `Request ${String(data.requestId)}` }));
		}

		report.append(element('h3', { text: 'Checks' }));
		const checks = orderChecks(data.checks);
		const grid = element('div', { className: 'status-grid' });
		if (!checks.length) {
			grid.append(element('p', {
				className: 'empty-state',
				text: 'This response reported no individual checks. Run the self-test to get per-check evidence.',
			}));
		} else {
			checks.forEach((check) => grid.append(createCheckCard(check)));
		}
		report.append(grid);
		return report;
	};

	const renderUnavailable = (message) => {
		const report = element('article', { className: 'operation-card selftest-report' });
		const wrap = element('div', { className: 'selftest-verdict' });
		wrap.append(
			element('p', { className: 'eyebrow', text: 'Self-test verdict' }),
			badge('Unavailable', 'misconfigured'),
		);
		report.append(wrap);
		report.append(element('p', { className: 'selftest-unavailable', text: message }));
		report.append(element('p', {
			className: 'request-state',
			text: 'No check results are shown because none were returned. Treat this as unknown, not as a pass.',
		}));
		return report;
	};

	return {
		CHECK_LABELS,
		CHECK_TONES,
		MAX_EVIDENCE_DEPTH,
		OVERALL_TONES,
		checkLabel,
		checkTone,
		displayLabel,
		evidenceEntries,
		freshnessNotice,
		orderChecks,
		overallTone,
		renderSelfTest,
		renderUnavailable,
		summaryText,
	};
}));