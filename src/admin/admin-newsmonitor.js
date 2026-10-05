'use strict';

/* global window */

// News monitor operations view (issue #1290).
//
// The five news-monitor admin endpoints had no UI, which left the pause kill switch
// reachable only by curl and gave no signal that the monitor was paused at all — after
// #1177, where it ran for 90 days and sent zero alerts.
//
// The console serves plain static scripts with no module loader, so this file attaches
// itself to `window` and receives admin.js's DOM/request helpers through `deps` rather
// than importing them. admin.js stays the single owner of `sendRequest`, so this view
// cannot grow its own auth or error path: the adminWrite/admin.operator gate, the
// confirm-before-mutation contract and the shared error envelope all still come from
// there.
(function exposeNewsMonitor(root, factory) {
	const api = factory();

	if (typeof module === 'object' && module.exports) {
		module.exports = api;
		return;
	}

	root.CabrosAdminNewsMonitor = api;
}(typeof window === 'undefined' ? globalThis : window, () => {
	// The one closed code this view special-cases. Defensive rather than reachable from these
	// five endpoints today: `POST /api/news-monitor` answers 503 with this shape while the
	// kill switch is engaged, and it is a *state*, not a fault, so the operator needs to be
	// told which action unblocks it if a read ever returns it.
	const NEWS_MONITOR_PAUSED_CODE = 'NEWS_MONITOR_PAUSED';
	const PAUSED_HEADLINE = 'The news monitor is paused — resume to continue.';
	const PAUSED_EXPLANATION = 'While it stays paused, analysis requests are rejected and background sweeps skip execution, so the news monitor produces no alerts at all.';

	const STATUS_DEFINITION = { method: 'GET', path: '/api/news-monitor/status', label: 'News monitor status', requiredRole: 'admin.viewer' };
	const SUMMARY_DEFINITION = { method: 'GET', path: '/api/news-monitor/summary', label: 'News analysis summary', requiredRole: 'admin.viewer' };
	const ANALYSES_DEFINITION = { method: 'GET', path: '/api/news-monitor/analyses', label: 'Recorded news analyses', requiredRole: 'admin.viewer' };
	// Pause and resume need the operator role. `confirm` is what drives the shared
	// confirm-before-mutation contract inside sendRequest, so the dialog cannot be
	// skipped by calling the helper directly.
	const PAUSE_DEFINITION = {
		method: 'POST', path: '/api/news-monitor/pause', label: 'Pause news monitor', requiredRole: 'admin.operator',
		confirm: 'Pause the news monitor? Background sweeps stop and no news alerts are produced until it is resumed.',
	};
	const RESUME_DEFINITION = {
		method: 'POST', path: '/api/news-monitor/resume', label: 'Resume news monitor', requiredRole: 'admin.operator',
		confirm: 'Resume the news monitor? Analysis requests and background sweeps start again immediately.',
	};

	const VIEW_NAME = 'newsMonitor';
	const ANALYSES_SCOPE = `${VIEW_NAME}.analyses`;
	const SUMMARY_SCOPE = `${VIEW_NAME}.summary`;

	const isPausedError = (body) => Boolean(body)
		&& typeof body === 'object'
		&& body.code === NEWS_MONITOR_PAUSED_CODE;

	const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

	const asCount = (value) => {
		const numeric = Number(value);
		return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
	};

	// `Number(null)` and `Number('')` are both 0, so a missing measurement would format as
	// a real 0% — the failure mode where an absent value reads as a reported zero. An absent
	// value stays absent.
	const asFiniteNumber = (value) => {
		if (value === null || value === undefined || value === '') return null;
		const numeric = Number(value);
		return Number.isFinite(numeric) ? numeric : null;
	};

	// A bare 0 is a real, reportable answer ("nothing cleared the threshold"), so it must
	// never collapse into an em dash the way an absent value does.
	const formatPercent = (value) => {
		const numeric = asFiniteNumber(value);
		if (numeric === null) return '—';
		return `${Number.isInteger(numeric) ? numeric : Number(numeric.toFixed(2))}%`;
	};

	// For 0-1 fractions (confidence, thresholds), where a percent sign would misread 0.7 as
	// 0.007.
	const formatFraction = (value) => {
		const numeric = asFiniteNumber(value);
		return numeric === null ? '—' : numeric.toFixed(2);
	};

	const formatCount = (value) => asCount(value).toLocaleString();

	// Rounded the same way the service rounds its own percentages, so a client-derived rate
	// and a server-derived one are formatted identically.
	const ratioPercent = (numerator, denominator) => (denominator > 0
		? Math.round((asCount(numerator) / asCount(denominator)) * 10000) / 100
		: null);

	const isPausedPayload = (payload) => asObject(payload).paused === true;

	const createNewsMonitorView = (deps) => {
		const {
			sendRequest, element, getElement, createMetricCard, createEmptyState, createTimestamp,
			showError, addField, registerFilterScope, reportWindowDefaults, toIsoTimestamp,
			canPerformMutation, charts, authState,
		} = deps;

		const view = element('div', { className: 'dashboard' });

		// Every request in this view goes through here so the paused state is never left to
		// the generic error renderer, which would present an expected state as a failure.
		// `sendRequest` returns undefined for every non-2xx, so the body is captured through
		// captureResponseData and the notice is written after sendRequest has finished
		// populating the output block.
		const callApi = async (options) => {
			let pausedBody = null;
			const data = await sendRequest({
				...options,
				captureResponseData: (body) => {
					if (isPausedError(body)) pausedBody = body;
				},
			});
			if (pausedBody) {
				const { output } = options;
				output.className = 'response-block response-error';
				output.replaceChildren(
					element('strong', { text: PAUSED_HEADLINE }),
					element('p', { text: PAUSED_EXPLANATION }),
				);
				const detail = asObject(pausedBody);
				const reason = typeof detail.reason === 'string' && detail.reason.trim() ? detail.reason.trim() : null;
				if (reason) output.append(element('p', { text: `Recorded reason: ${reason}` }));
				if (detail.pausedAt) {
					const stamp = element('p');
					stamp.append(element('span', { text: 'Paused at ' }), createTimestamp(detail.pausedAt));
					output.append(stamp);
				}
			}
			return data;
		};

		const hasCredentials = () => Boolean(getElement('api-key')?.value) || Boolean(authState && authState.enabled && authState.user);

		// --- hero -------------------------------------------------------------------------
		const hero = element('section', { className: 'dashboard-hero' });
		const heroCopy = element('div');
		const lastChecked = element('p', { className: 'request-state', text: 'Waiting for live status…' });
		heroCopy.append(
			element('p', { className: 'eyebrow', text: 'News monitoring' }),
			element('h2', { text: 'News monitor' }),
			element('p', { text: 'Pause state, delivery analytics and recorded analyses for the news analysis pipeline.' }),
			lastChecked,
		);
		const refreshButton = element('button', { className: 'button-primary', text: 'Refresh' });
		refreshButton.type = 'button';
		hero.append(heroCopy, refreshButton);
		view.append(hero);

		// --- state card ------------------------------------------------------------------
		// `banner-error` is what makes a paused monitor read as a warning rather than as one
		// more neutral panel: the monitor being silent is the single most important fact here.
		const stateSection = element('section', { className: 'dashboard-section' });
		stateSection.append(element('h3', { text: 'Monitor state' }));
		const stateCard = element('article', { className: 'status-card' });
		const stateCopy = element('div');
		const stateTitle = element('strong');
		const stateMeta = element('small');
		stateCopy.append(stateTitle, stateMeta);
		const stateBadge = element('span', { className: 'status-badge status-ready' });
		stateCard.append(stateCopy, stateBadge);
		const stateDetail = element('dl', { className: 'status-detail-list' });
		stateSection.append(stateCard, stateDetail);

		const renderPausedState = (payload) => {
			const detail = asObject(payload);
			const paused = isPausedPayload(detail);
			const pausedAt = typeof detail.pausedAt === 'string' && detail.pausedAt ? detail.pausedAt : null;
			const reason = typeof detail.reason === 'string' && detail.reason.trim() ? detail.reason.trim() : null;

			stateSection.className = paused ? 'dashboard-section banner-error' : 'dashboard-section';
			stateBadge.className = `status-badge ${paused ? 'status-danger' : 'status-ready'}`;
			stateBadge.textContent = paused ? 'Paused' : 'Running';
			stateTitle.textContent = paused ? 'No news alerts are being produced' : 'Running normally';
			stateMeta.textContent = paused
				? 'Background sweeps skip execution and analysis requests are rejected.'
				: 'Background sweeps and manual analysis requests are accepted.';

			stateDetail.replaceChildren();
			const rows = [
				['Paused at', pausedAt ? createTimestamp(pausedAt) : element('span', { text: '—' })],
				['Reason', reason ? element('span', { text: reason }) : element('span', { text: '—' })],
			];
			rows.forEach(([label, value]) => {
				const dd = element('dd');
				dd.append(value);
				stateDetail.append(element('dt', { text: label }), dd);
			});
		};

		// An unread state is never reported as a healthy one: a failed read means the pause
		// state is unknown, which is the opposite of "running normally".
		const renderUnavailableState = () => {
			stateSection.className = 'dashboard-section';
			stateBadge.className = 'status-badge status-misconfigured';
			stateBadge.textContent = 'Unavailable';
			stateTitle.textContent = 'News monitor state unavailable';
			stateMeta.textContent = 'The pause state could not be read, so it is unknown rather than running.';
			stateDetail.replaceChildren();
		};

		// --- kill switch -----------------------------------------------------------------
		const killSwitch = element('section', { className: 'dashboard-section' });
		killSwitch.append(element('h3', { text: 'Kill switch' }));
		const reasonInput = element('input', { placeholder: 'Optional: why you are pausing' });
		reasonInput.name = 'news-monitor-pause-reason';
		const reasonLabel = element('label', { text: 'Pause reason (optional)' });
		reasonLabel.append(reasonInput);
		const pauseButton = element('button', { className: 'button-primary', text: 'Pause news monitor' });
		pauseButton.type = 'button';
		const resumeButton = element('button', { className: 'button-ghost', text: 'Resume news monitor' });
		resumeButton.type = 'button';
		const killActions = element('div', { className: 'preset-actions' });
		killActions.append(pauseButton, resumeButton);
		const killOutput = element('div', { className: 'response-block', text: 'No request sent.' });
		killSwitch.append(reasonLabel, killActions, killOutput);
		view.append(stateSection, killSwitch);

		// --- summary ---------------------------------------------------------------------
		const summarySection = element('section', { className: 'dashboard-section' });
		summarySection.append(element('h3', { text: 'Delivery analytics' }));
		const summaryRoute = element('code', { text: 'GET /api/news-monitor/summary' });
		const summaryFilters = element('div', { className: 'status-filter-bar' });
		const summaryForm = element('form');
		const summaryDefaults = reportWindowDefaults();
		const summaryFrom = addField(summaryForm, 'From', 'summary-from', { type: 'datetime-local', value: summaryDefaults.from });
		const summaryTo = addField(summaryForm, 'To', 'summary-to', { type: 'datetime-local', value: summaryDefaults.to });
		const summaryThreshold = addField(summaryForm, 'Alert threshold', 'summary-threshold', { type: 'number', min: 0, max: 1, step: 'any', value: 0.7 });
		const summaryButton = element('button', { className: 'button-primary', text: 'Load analytics' });
		summaryButton.type = 'submit';
		summaryForm.append(summaryButton);
		summaryFilters.append(summaryForm);
		registerFilterScope(SUMMARY_SCOPE, { from: summaryFrom, to: summaryTo, threshold: summaryThreshold });
		const summaryOutput = element('div', { className: 'response-block', text: 'No analytics requested yet.' });
		const kpiGrid = element('div', { className: 'metric-grid' });
		kpiGrid.append(element('p', { className: 'request-state', text: 'Loading delivery analytics…' }));
		summarySection.append(summaryRoute, summaryFilters, summaryOutput, kpiGrid);
		// The breakdowns are their own dashboard sections rather than unclassed wrappers
		// inside the analytics panel: an unclassed grid item keeps min-width auto and would
		// adopt a 36rem chart's width instead of letting the chart scroll inside its box.
		const symbolSection = element('section', { className: 'dashboard-section' });
		const categorySection = element('section', { className: 'dashboard-section' });
		const proxySection = element('section', { className: 'dashboard-section' });
		view.append(summarySection, symbolSection, categorySection, proxySection);

		// The two breakdowns genuinely disagree on the count key: `bySymbol` counts with
		// `totalAnalyses` and `byEventCategory` with `total`. Neither supplies a per-row
		// alert rate, so it is derived from the two fields both do supply.
		const breakdownRows = (value, countKey) => Object.entries(asObject(value))
			.map(([key, detail]) => {
				const row = asObject(detail);
				const count = asCount(row[countKey]);
				return {
					name: key,
					count,
					alertsSent: asCount(row.alertsSent),
					alertRatePercent: ratioPercent(asCount(row.alertsSent), count),
					averageConfidence: asFiniteNumber(row.averageConfidence),
				};
			})
			.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));

		const renderKpis = (summary) => {
			const totalAnalyses = asCount(summary.totalAnalyses);
			const totalAlertsSent = asCount(summary.totalAlertsSent);
			// The summary payload carries no top-level alert rate, so it is derived from the
			// two counts it does carry rather than read from a field that never arrives.
			const alertRate = ratioPercent(totalAlertsSent, totalAnalyses);
			const proxy = asObject(summary.falsePositiveProxy);
			const proxyRate = asFiniteNumber(proxy.ratePercent);

			const alertRateMeta = totalAnalyses > 0
				// Zero alerts over a populated window is the #1177 shape, so it is spelled out
				// rather than left to a bare "0%" that reads like a missing measurement.
				? `${formatPercent(alertRate)} of analyses became alerts (${formatCount(totalAlertsSent)} of ${formatCount(totalAnalyses)})`
				: 'No analyses recorded in this window';
			const proxyMeta = asCount(proxy.totalEvaluated) > 0
				? `${formatCount(asCount(proxy.noFollowupCount))} of ${formatCount(asCount(proxy.totalEvaluated))} delivered alerts had no follow-up within 24h`
				: 'No delivered alerts at or above the threshold were evaluated';

			kpiGrid.replaceChildren(
				createMetricCard('Analyses', formatCount(totalAnalyses), 'Recorded in the selected window'),
				createMetricCard('Alerts sent', formatCount(totalAlertsSent), 'Alerts that actually reached a channel'),
				createMetricCard('Alert rate', formatPercent(alertRate), alertRateMeta),
				createMetricCard('False-positive proxy', formatPercent(proxyRate), proxyMeta),
			);

			// Sparklines need more than one point to say anything, so they are only attached
			// when the breakdown has a real series to draw.
			const attachSparkline = (card, values, label) => {
				if (!charts || typeof charts.sparkline !== 'function') return;
				if (values.length < 2) return;
				card.append(charts.sparkline(values, { label, formatValue: (value) => String(value) }));
			};
			const symbolCounts = breakdownRows(summary.bySymbol, 'totalAnalyses').map((row) => row.count);
			const categoryCounts = breakdownRows(summary.byEventCategory, 'total').map((row) => row.count);
			attachSparkline(kpiGrid.children[0], symbolCounts, 'Analyses by symbol');
			attachSparkline(kpiGrid.children[1], categoryCounts, 'Analyses by event category');
		};

		// Each header is [label, read], so callers pass records rather than projecting cells.
		// `read` may return a node (an absolute+relative timestamp) instead of a string.
		const breakdownTable = (caption, headers, records) => {
			const scroll = element('div', { className: 'table-scroll', attributes: { tabindex: '0', role: 'region', 'aria-label': caption } });
			const table = element('table', { className: 'data-table' });
			const head = element('tr');
			headers.forEach(([label]) => head.append(element('th', { text: label, attributes: { scope: 'col' } })));
			table.append(head);
			records.forEach((record) => {
				const row = element('tr');
				headers.forEach(([, read]) => {
					const cell = element('td');
					const value = read(record);
					if (value !== null && typeof value === 'object') cell.append(value);
					else cell.textContent = value === undefined || value === null ? '—' : String(value);
					row.append(cell);
				});
				table.append(row);
			});
			scroll.append(table);
			return scroll;
		};

		const renderBreakdown = (container, { title, rows, headers, valueKey, chartLabel, emptyText }) => {
			container.replaceChildren();
			container.append(element('h3', { text: title }));
			if (!rows.length) {
				container.append(createEmptyState(emptyText));
				return;
			}
			const chart = charts && typeof charts.barChart === 'function'
				? charts.barChart(rows.map((row) => ({ label: row.name, [valueKey]: row.count })), {
					label: chartLabel,
					valueKey,
					formatValue: (value) => formatCount(value),
				})
				: null;
			if (chart) {
				const scroller = element('div', { className: 'chart-scroll' });
				scroller.append(chart);
				container.append(scroller);
			}
			container.append(breakdownTable(title, headers, rows));
		};

		const renderProxy = (proxy) => {
			const detail = asObject(proxy);
			proxySection.replaceChildren(element('h3', { text: 'False-positive proxy' }));
			const list = element('dl', { className: 'status-detail-list' });
			const rows = [
				['Threshold', formatFraction(detail.threshold)],
				['Delivered alerts evaluated', formatCount(detail.totalEvaluated)],
				['With no follow-up', formatCount(detail.noFollowupCount)],
				['Rate', formatPercent(detail.ratePercent)],
			];
			rows.forEach(([label, value]) => list.append(element('dt', { text: label }), element('dd', { text: value })));
			proxySection.append(list);
			proxySection.append(element('p', {
				className: 'request-state',
				text: 'Measured over delivered alerts only. An alert counts as a false positive when no further alert for the same symbol followed within 24h.',
			}));
		};

		const loadSummary = async () => {
			let query;
			try {
				query = Object.fromEntries(Object.entries({
					from: toIsoTimestamp(summaryFrom.value, 'From'),
					to: toIsoTimestamp(summaryTo.value, 'To'),
					threshold: summaryThreshold.value,
				}).filter(([, value]) => value !== undefined && value !== ''));
			} catch (error) {
				showError(summaryOutput, error.message);
				return undefined;
			}
			const data = await callApi({
				definition: SUMMARY_DEFINITION,
				path: SUMMARY_DEFINITION.path,
				query,
				button: summaryButton,
				output: summaryOutput,
				// Without this the response block re-renders the whole breakdown as a raw
				// result tree, duplicating the KPI cards and tables above it.
				formatResponse: ({ summary, status, elapsed }) => `${summary}\nHTTP ${status} · ${elapsed} ms`,
			});
			if (!data || typeof data !== 'object') {
				kpiGrid.replaceChildren(createEmptyState('Delivery analytics unavailable.'));
				return undefined;
			}
			renderKpis(data);
			const confidenceHeader = ['Avg confidence', (row) => formatFraction(row.averageConfidence)];
			renderBreakdown(symbolSection, {
				title: 'Analyses by symbol',
				rows: breakdownRows(data.bySymbol, 'totalAnalyses'),
				headers: [
					['Symbol', (row) => row.name],
					['Analyses', (row) => formatCount(row.count)],
					['Alerts sent', (row) => formatCount(row.alertsSent)],
					['Alert rate', (row) => formatPercent(row.alertRatePercent)],
					confidenceHeader,
				],
				valueKey: 'count',
				chartLabel: 'Analyses by symbol',
				emptyText: 'No analyses recorded in this window.',
			});
			renderBreakdown(categorySection, {
				title: 'Analyses by event category',
				rows: breakdownRows(data.byEventCategory, 'total'),
				headers: [
					['Event category', (row) => row.name],
					['Analyses', (row) => formatCount(row.count)],
					['Alerts sent', (row) => formatCount(row.alertsSent)],
					['Alert rate', (row) => formatPercent(row.alertRatePercent)],
					confidenceHeader,
				],
				valueKey: 'count',
				chartLabel: 'Analyses by event category',
				emptyText: 'No event categories recorded in this window.',
			});
			renderProxy(data.falsePositiveProxy);
			return data;
		};

		// --- analyses list ----------------------------------------------------------------
		const analysesSection = element('section', { className: 'dashboard-section' });
		analysesSection.append(element('h3', { text: 'Recorded analyses' }));
		const analysesRoute = element('code', { text: 'GET /api/news-monitor/analyses' });
		const analysesForm = element('form', { className: 'form-fields' });
		analysesForm.append(analysesRoute);
		const analysesDefaults = reportWindowDefaults();
		const analysesFrom = addField(analysesForm, 'From', 'from', { type: 'datetime-local', value: analysesDefaults.from });
		const analysesTo = addField(analysesForm, 'To', 'to', { type: 'datetime-local', value: analysesDefaults.to });
		const analysesLimit = addField(analysesForm, 'Limit', 'limit', { type: 'number', min: 1, max: 100, value: 50 });
		const analysesSymbol = addField(analysesForm, 'Symbol', 'symbol', { placeholder: 'BTCUSDT' });
		const analysesCategory = addField(analysesForm, 'Event category', 'eventCategory', { placeholder: 'price_surge' });
		registerFilterScope(ANALYSES_SCOPE, {
			from: analysesFrom, to: analysesTo, limit: analysesLimit, symbol: analysesSymbol, eventCategory: analysesCategory,
		});
		const analysesLoad = element('button', { className: 'button-primary', text: 'Load analyses' });
		analysesLoad.type = 'submit';
		const analysesPrev = element('button', { className: 'button-ghost', text: 'Previous page' });
		analysesPrev.type = 'button';
		analysesPrev.disabled = true;
		const analysesNext = element('button', { className: 'button-ghost', text: 'Next page' });
		analysesNext.type = 'button';
		analysesNext.disabled = true;
		const analysesOutput = element('div', { className: 'response-block', text: 'No analyses requested yet.' });
		const analysesResults = element('section', { className: 'dashboard-section' });
		const analysesResultsHeading = element('h3', { text: 'Analysis results' });
		analysesResults.append(analysesResultsHeading);
		analysesForm.append(analysesLoad, analysesPrev, analysesNext);
		analysesSection.append(analysesRoute, analysesForm, analysesOutput);
		view.append(analysesSection, analysesResults);

		const renderAnalyses = (rows, count) => {
			analysesResults.replaceChildren(analysesResultsHeading);
			if (!rows.length) {
				analysesResults.append(createEmptyState('No recorded analyses match these filters.'));
				return;
			}
			const headers = [
				['Symbol', (row) => String(row.symbol)],
				['Event category', (row) => formatFraction(row.eventCategory)],
				['Alert sent', (row) => (row.alertSent === true ? 'yes' : 'no')],
				['Confidence', (row) => formatFraction(row.confidence)],
				['Sentiment', (row) => formatFraction(row.sentiment)],
				// createdAt, not an "analyzedAt" the payload never carries, and rendered as an
				// absolute time plus the relative one instead of a raw string.
				['Analyzed', (row) => createTimestamp(row.createdAt)],
			];
			analysesResults.append(breakdownTable(`Recorded news analyses (${count ?? rows.length})`, headers, rows));
		};

		const normaliseRecord = (record) => {
			const detail = asObject(record);
			return {
				symbol: detail.symbol === undefined || detail.symbol === null ? '—' : detail.symbol,
				eventCategory: detail.eventCategory === undefined || detail.eventCategory === null ? null : String(detail.eventCategory),
				alertSent: detail.alertSent === true,
				confidence: asFiniteNumber(detail.confidence),
				sentiment: asFiniteNumber(detail.sentiment),
				createdAt: detail.createdAt === undefined || detail.createdAt === null ? '' : String(detail.createdAt),
			};
		};

		let nextCursor;
		let backCursors = [];
		let pageGeneration = 0;

		const requestAnalyses = async (cursor) => {
			const generation = ++pageGeneration;
			analysesPrev.disabled = true;
			analysesNext.disabled = true;
			let query;
			try {
				query = Object.fromEntries(Object.entries({
					from: toIsoTimestamp(analysesFrom.value, 'From'),
					to: toIsoTimestamp(analysesTo.value, 'To'),
					limit: analysesLimit.value,
					before: cursor,
					symbol: analysesSymbol.value,
					eventCategory: analysesCategory.value,
				}).filter(([, value]) => value !== undefined && value !== ''));
			} catch (error) {
				showError(analysesOutput, error.message);
				return false;
			}
			const data = await callApi({
				definition: ANALYSES_DEFINITION,
				path: ANALYSES_DEFINITION.path,
				query,
				button: analysesLoad,
				output: analysesOutput,
				isCurrent: () => generation === pageGeneration,
				formatResponse: ({ summary, status, elapsed }) => `${summary}\nHTTP ${status} · ${elapsed} ms`,
			});
			if (generation !== pageGeneration) return false;
			if (!data || !Array.isArray(data.analyses)) {
				nextCursor = undefined;
				analysesNext.disabled = true;
				analysesPrev.disabled = !backCursors.length;
				renderAnalyses([], 0);
				return false;
			}
			renderAnalyses(data.analyses.map(normaliseRecord), data.analyses.length);
			nextCursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : undefined;
			analysesNext.disabled = !nextCursor;
			analysesPrev.disabled = !backCursors.length;
			return true;
		};

		// --- status ----------------------------------------------------------------------
		// Both mutations re-read the status afterwards instead of trusting their own response
		// body, so what the operator sees is the monitor's actual state rather than an echo of
		// what we asked for.
		const loadStatus = async () => {
			const data = await callApi({
				definition: STATUS_DEFINITION,
				path: STATUS_DEFINITION.path,
				button: refreshButton,
				output: killOutput,
			});
			if (data && typeof data === 'object') {
				renderPausedState(data);
				lastChecked.textContent = `Last checked ${new Date().toLocaleTimeString()}`;
			} else {
				renderUnavailableState();
				lastChecked.textContent = 'Status unavailable.';
			}
			return data;
		};

		const toggleKillSwitch = async ({ definition, button, body }) => {
			if (!canPerformMutation()) {
				showError(killOutput, 'Your admin role cannot pause or resume the news monitor.');
				return undefined;
			}
			const data = await callApi({ definition, path: definition.path, body, button, output: killOutput });
			await loadStatus();
			return data;
		};

		refreshButton.addEventListener('click', () => { loadStatus(); });
		summaryForm.addEventListener('submit', (event) => {
			event.preventDefault();
			loadSummary();
		});
		// Editing a filter invalidates the cursor chain: the previous page boundaries were
		// taken under the old filters and would skip or repeat rows.
		[analysesFrom, analysesTo, analysesLimit, analysesSymbol, analysesCategory].forEach((field) => {
			field.addEventListener('input', () => {
				pageGeneration += 1;
				nextCursor = undefined;
				backCursors = [];
				analysesPrev.disabled = true;
				analysesNext.disabled = true;
				analysesOutput.textContent = 'Filters changed — load analyses to refresh.';
				renderAnalyses([], 0);
			});
			field.addEventListener('change', () => {
				pageGeneration += 1;
				nextCursor = undefined;
				backCursors = [];
				analysesPrev.disabled = true;
				analysesNext.disabled = true;
				analysesOutput.textContent = 'Filters changed — load analyses to refresh.';
				renderAnalyses([], 0);
			});
		});
		analysesForm.addEventListener('submit', (event) => {
			event.preventDefault();
			backCursors = [];
			requestAnalyses(undefined);
		});
		const syncPagingButtons = () => {
			analysesNext.disabled = !nextCursor;
			analysesPrev.disabled = !backCursors.length;
		};

		analysesNext.addEventListener('click', async () => {
			if (!nextCursor) return;
			const entry = nextCursor;
			if (await requestAnalyses(entry)) {
				backCursors.push(entry);
				syncPagingButtons();
			}
		});
		analysesPrev.addEventListener('click', async () => {
			if (!backCursors.length) return;
			const target = backCursors[backCursors.length - 1];
			if (await requestAnalyses(target)) {
				backCursors.pop();
				syncPagingButtons();
			}
		});
		pauseButton.addEventListener('click', () => {
			// Snapshot the field before the await so a late response cannot overwrite what the
			// operator typed afterwards.
			const reason = String(reasonInput.value || '').trim();
			toggleKillSwitch({
				definition: PAUSE_DEFINITION,
				button: pauseButton,
				body: reason ? { reason } : {},
			});
		});
		resumeButton.addEventListener('click', () => {
			toggleKillSwitch({ definition: RESUME_DEFINITION, button: resumeButton });
		});

		if (hasCredentials()) {
			loadStatus();
			loadSummary();
		} else {
			// Nothing has been read yet, so the card must not claim the monitor is running.
			renderUnavailableState();
			lastChecked.textContent = 'Enter an API key or sign in to load the news monitor state.';
		}
		return view;
	};

	return {
		ANALYSES_SCOPE,
		NEWS_MONITOR_PAUSED_CODE,
		PAUSED_HEADLINE,
		SUMMARY_SCOPE,
		VIEW_NAME,
		createNewsMonitorView,
		formatPercent,
		isPausedError,
	};
}));