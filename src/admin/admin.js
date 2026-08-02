'use strict';

/* global document, window */

const VIEWS = {
	status: [{ method: 'GET', path: '/api/status', label: 'Refresh status' }],
	presets: [
		{ method: 'GET', path: '/api/scanner-presets', label: 'Load presets' },
		{ method: 'POST', path: '/api/scanner-presets', label: 'Create preset' },
	],
	jobs: [{ method: 'POST', path: '/api/jobs/tradingview-analysis', label: 'Create job' }],
	analysis: [
		{ method: 'POST', path: '/api/webhook/expanded-analysis-alert', label: 'Expanded analysis' },
		{ method: 'POST', path: '/api/webhook/market-scanner-alert', label: 'Market scanner' },
		{ method: 'POST', path: '/api/webhook/volume-confirmation', label: 'Volume confirmation' },
		{ method: 'POST', path: '/api/news-monitor', label: 'News monitor' },
	],
};

const VIEW_ACTIONS = {
	alerts: [
		{ method: 'GET', path: '/api/alerts/{alertId}', label: 'Get alert by ID' },
		{
			method: 'POST', path: '/api/alerts/{alertId}/replay', label: 'Replay alert',
			confirm: 'Replay this alert?',
		},
	],
	presets: [
		{ method: 'PUT', path: '/api/scanner-presets/{id}', label: 'Update preset' },
		{
			method: 'POST', path: '/api/scanner-presets/{id}/run', label: 'Run preset',
			confirm: 'Run this scanner preset?',
		},
		{
			method: 'DELETE', path: '/api/scanner-presets/{id}', label: 'Delete preset',
			confirm: 'Delete this scanner preset?',
		},
	],
};

const STATUS_DEFINITION = { method: 'GET', path: '/api/status', label: 'Refresh status' };
const STATUS_LABELS = {
	ready: 'Ready',
	disabled: 'Disabled',
	misconfigured: 'Needs attention',
};
const DISPLAY_LABELS = {
	telegram: 'Telegram',
	whatsapp: 'WhatsApp',
	discord: 'Discord',
	tradingViewMcp: 'TradingView MCP',
	tradingViewMcpEnrichment: 'TradingView MCP enrichment',
	tradingViewVolumeConfirmation: 'TradingView volume confirmation',
	tradingViewConfluenceEnrichment: 'TradingView confluence enrichment',
	tradingViewConfluenceMultiTimeframe: 'TradingView multi-timeframe confluence',
	newsMonitorLlm: 'News monitor LLM',
	llmAlertEnrichment: 'LLM alert enrichment',
	newsMonitorDedup: 'News monitor deduplication',
	signalOutcomeWorker: 'Signal outcome worker',
	idempotencyStorage: 'Idempotency storage',
	scannerPresetStorage: 'Scanner preset storage',
	cloudflareAig: 'Cloudflare AI Gateway',
};

let contractPromise;
const loadContract = () => {
	if (!contractPromise) {
		contractPromise = fetch('/openapi.json')
			.then((response) => {
				if (!response.ok) throw new Error(`OpenAPI contract returned HTTP ${response.status}`);
				return response.json();
			})
			.catch((error) => {
				contractPromise = undefined;
				throw error;
			});
	}
	return contractPromise;
};

const element = (tag, options = {}) => {
	const node = document.createElement(tag);
	if (options.className) node.className = options.className;
	if (options.text) node.textContent = options.text;
	return node;
};

const parseJson = (value, label) => {
	if (!value.trim()) return undefined;
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new Error(`${label} must be valid JSON: ${error.message}`);
	}
};

const resolveRef = (contract, value) => {
	if (!value || !value.$ref) return value;
	return value.$ref.slice(2).split('/').reduce((current, key) => current[key], contract);
};

const getOperation = (contract, definition) => contract.paths[definition.path]
	&& contract.paths[definition.path][definition.method.toLowerCase()];

const getParameters = (contract, operation) => (operation && operation.parameters || [])
	.map((parameter) => resolveRef(contract, parameter));

const getBodyExample = (contract, operation) => {
	const requestBody = resolveRef(contract, operation && operation.requestBody);
	const json = requestBody && requestBody.content && requestBody.content['application/json'];
	if (!json) return {};
	if (json.example !== undefined) return json.example;
	const firstExample = json.examples && Object.values(json.examples)[0];
	return firstExample && firstExample.value || {};
};

const getQueryExample = (contract, operation) => Object.fromEntries(getParameters(contract, operation)
	.filter((parameter) => parameter.in === 'query' && (parameter.example !== undefined
		|| parameter.schema && (parameter.schema.example !== undefined || parameter.schema.default !== undefined)))
	.map((parameter) => [parameter.name, parameter.example !== undefined
		? parameter.example
		: parameter.schema.example !== undefined ? parameter.schema.example : parameter.schema.default]));

const createIdempotencyKey = () => (window.crypto && typeof window.crypto.randomUUID === 'function'
	? window.crypto.randomUUID()
	: `admin-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const withReplayIdempotencyKey = (definition, body) => {
	if (definition.method !== 'POST' || definition.path !== '/api/alerts/{alertId}/replay') return body;
	if (body && ['idempotencyKey', 'idempotency_key'].some((key) => typeof body[key] === 'string' && body[key].trim())) return body;
	return { ...(body || {}), idempotencyKey: createIdempotencyKey() };
};

const getRequestBody = (definition, form) => {
	const input = form.elements.body;
	const body = input ? parseJson(input.value, 'Request body') : undefined;
	const requestBody = withReplayIdempotencyKey(definition, body);
	if (input && requestBody !== body) input.value = JSON.stringify(requestBody, null, 2);
	return requestBody;
};

const addJsonField = (form, labelText, name, value) => {
	const label = element('label', { text: labelText });
	const textarea = element('textarea');
	textarea.name = name;
	textarea.rows = 8;
	textarea.value = JSON.stringify(value, null, 2);
	label.append(textarea);
	form.append(label);
};

const addField = (form, labelText, name, options = {}) => {
	const label = element('label', { text: labelText });
	const input = element(options.tag || 'input');
	input.name = name;
	Object.entries(options).forEach(([key, value]) => {
		if (key !== 'tag') input[key] = value;
	});
	label.append(input);
	form.append(label);
	return input;
};

const addPathFields = (form, path) => {
	const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
	names.forEach((name) => {
		const label = element('label', { text: name });
		const input = element('input');
		input.name = `path-${name}`;
		input.required = true;
		input.placeholder = name;
		label.append(input);
		form.append(label);
	});
	return names;
};

const fillPath = (path, names, form) => names.reduce((resolved, name) => resolved.replace(
	`{${name}}`,
	encodeURIComponent(form.elements[`path-${name}`].value),
), path);

const showError = (output, message) => {
	output.className = 'response-block response-error';
	output.textContent = message;
};

const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const displayLabel = (value) => DISPLAY_LABELS[value] || String(value)
	.replace(/([a-z])([A-Z])/g, '$1 $2')
	.replace(/[-_]/g, ' ')
	.replace(/\b\w/g, (letter) => letter.toUpperCase());

const displayStatus = (value) => STATUS_LABELS[value] || displayLabel(value || 'unknown');

const statusTone = (value) => ['ready', 'disabled', 'misconfigured'].includes(value) ? value : 'unknown';

const statusEntries = (value) => Object.entries(asObject(value))
	.filter(([, detail]) => detail && typeof detail === 'object' && typeof detail.status === 'string');

const statusCounts = (entries) => entries.reduce((counts, [, detail]) => {
	counts[detail.status] = (counts[detail.status] || 0) + 1;
	return counts;
}, {});

const createMetricCard = (label, value, meta) => {
	const card = element('article', { className: 'metric-card' });
	card.append(
		element('p', { className: 'metric-label', text: label }),
		element('strong', { className: 'metric-value', text: String(value) }),
		element('p', { className: 'metric-meta', text: meta || '' }),
	);
	return card;
};

const renderStatusCards = (container, entries, emptyText) => {
	container.replaceChildren();
	if (!entries.length) {
		container.append(element('p', { className: 'request-state', text: emptyText }));
		return;
	}
	entries.forEach(([name, detail]) => {
		const card = element('article', { className: 'status-card' });
		const copy = element('div');
		copy.append(
			element('strong', { text: displayLabel(name) }),
			element('small', { text: detail.provider ? `Provider: ${detail.provider}` : displayStatus(detail.status) }),
		);
		const badge = element('span', {
			className: `status-badge status-${statusTone(detail.status)}`,
			text: displayStatus(detail.status),
		});
		card.append(copy, badge);
		container.append(card);
	});
};

const renderStatusDashboard = ({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked }, status) => {
	const service = asObject(status.service);
	const features = Object.entries(asObject(status.featureFlags)).filter(([, enabled]) => enabled === true);
	const channels = statusEntries(status.deliveryChannels);
	const dependencies = statusEntries(status.dependencies);
	const dependencyCounts = statusCounts(dependencies);
	const attentionCount = dependencies.filter(([, detail]) => !['ready', 'disabled'].includes(detail.status)).length;

	metrics.replaceChildren(
		createMetricCard('Service', service.name || 'Unknown service', service.version ? `Version ${service.version}` : 'Version unavailable'),
		createMetricCard('Environment', service.environment || 'Unknown', service.commit ? `Commit ${String(service.commit).slice(0, 8)}` : 'Commit unavailable'),
		createMetricCard('Features', `${features.length} enabled`, `${Object.keys(asObject(status.featureFlags)).length} configured flags`),
		createMetricCard('Dependencies', `${dependencyCounts.ready || 0} ready`, `${attentionCount} need attention · ${dependencyCounts.disabled || 0} disabled`),
	);
	lastChecked.textContent = `Last checked ${new Date().toLocaleTimeString()}`;

	renderStatusCards(channelGrid, channels, 'No delivery channels reported.');
	renderStatusCards(dependencyGrid, dependencies, 'No dependencies reported.');
	featureGrid.replaceChildren();
	if (!features.length) {
		featureGrid.append(element('p', { className: 'request-state', text: 'No feature flags are enabled.' }));
		return;
	}
	features.forEach(([name]) => featureGrid.append(element('span', {
		className: 'capability-chip',
		text: displayLabel(name),
	})));
};

const createOverviewDashboard = () => {
	const dashboard = element('div', { className: 'dashboard' });
	const hero = element('section', { className: 'dashboard-hero' });
	const heroCopy = element('div');
	const lastChecked = element('p', { className: 'request-state', text: 'Waiting for live status…' });
	heroCopy.append(
		element('p', { className: 'eyebrow', text: 'Live control plane' }),
		element('h2', { text: 'Operational overview' }),
		element('p', { text: 'A quick read on service readiness, enabled capabilities and delivery health.' }),
		lastChecked,
	);
	const refreshButton = element('button', { className: 'button-primary', text: 'Refresh dashboard' });
	refreshButton.type = 'button';
	hero.append(heroCopy, refreshButton);

	const metrics = element('div', { className: 'metric-grid' });
	metrics.append(element('p', { className: 'request-state', text: 'Loading live status…' }));
	const channelGrid = element('div', { className: 'status-grid' });
	const dependencyGrid = element('div', { className: 'status-grid' });
	const featureGrid = element('div', { className: 'chip-grid' });
	const statusOutput = element('pre', { className: 'response-block', text: 'No status response yet.' });
	const rawStatus = element('details', { className: 'raw-status' });
	rawStatus.append(element('summary', { text: 'Show raw status response' }), statusOutput);

	const section = (title, content) => {
		const node = element('section', { className: 'dashboard-section' });
		node.append(element('h3', { text: title }), content);
		return node;
	};
	dashboard.append(
		hero,
		metrics,
		section('Delivery channels', channelGrid),
		section('Dependency health', dependencyGrid),
		section('Enabled capabilities', featureGrid),
		rawStatus,
	);

	const loadStatus = async () => {
		const status = await sendRequest({
			definition: STATUS_DEFINITION,
			path: STATUS_DEFINITION.path,
			button: refreshButton,
			output: statusOutput,
		});
		if (status && typeof status === 'object') {
			renderStatusDashboard({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked }, status);
		} else {
			metrics.replaceChildren(element('p', { className: 'request-state', text: 'Status unavailable. Check the API key and service logs.' }));
		}
	};
	refreshButton.addEventListener('click', loadStatus);
	if (document.getElementById('api-key').value) {
		loadStatus();
	} else {
		metrics.replaceChildren(element('p', { className: 'request-state', text: 'Enter an API key to load live status.' }));
	}
	return dashboard;
};

const sendRequest = async ({ definition, path, query, body, button, output }) => {
	const apiKey = document.getElementById('api-key').value;
	const summary = window.CabrosAdminRequest.redactSecret(`${definition.method} ${path}`, apiKey);
	let request;
	try {
		request = window.CabrosAdminRequest.createRequest({
			path,
			method: definition.method,
			query,
			body,
			apiKey,
		});
	} catch (error) {
		showError(output, error.message);
		return;
	}

	if (!window.CabrosAdminRequest.confirmRequest(definition, (message) => window.confirm(message))) return;

	button.disabled = true;
	output.className = 'response-block request-state';
	output.textContent = `${summary}\nRequest in progress…`;
	const started = performance.now();
	try {
		const response = await fetch(request.url, request.options);
		const elapsed = Math.round(performance.now() - started);
		const text = await response.text();
		let data;
		let formatted = text || '(empty response)';
		try {
			data = JSON.parse(text);
			formatted = JSON.stringify(data, null, 2);
		} catch (_) {
			// Non-JSON responses stay readable as text.
		}
		output.className = `response-block${response.ok ? '' : ' response-error'}`;
		output.textContent = `${summary}\nHTTP ${response.status} · ${elapsed} ms\n\n${window.CabrosAdminRequest.redactSecret(formatted, apiKey)}`;
		return data;
	} catch (error) {
		const elapsed = Math.round(performance.now() - started);
		showError(output, `${summary}\nNetwork error · ${elapsed} ms\n\n${window.CabrosAdminRequest.redactSecret(error.message, apiKey)}`);
	} finally {
		button.disabled = false;
	}
};

const createAlertListForm = () => {
	const definition = { method: 'GET', path: '/api/alerts', label: 'Load alerts' };
	const form = element('form', { className: 'operation-card' });
	form.append(
		element('h3', { text: definition.label }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);
	const limit = addField(form, 'Limit', 'limit', { type: 'number', min: 1, max: 100, value: 50 });
	const before = addField(form, 'Before cursor', 'before', { placeholder: 'nextBefore from the previous page' });
	const source = addField(form, 'Source', 'source', { placeholder: 'webhook' });
	const enriched = addField(form, 'Enriched', 'enriched', { tag: 'select' });
	[
		['', 'All alerts'],
		['true', 'Enriched only'],
		['false', 'Not enriched'],
	].forEach(([value, text]) => {
		const option = element('option', { text });
		option.value = value;
		enriched.append(option);
	});
	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const next = element('button', { text: 'Next page' });
	next.type = 'button';
	next.disabled = true;
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, next, output);

	let nextBefore;
	const requestPage = async (cursor) => {
		if (cursor) before.value = cursor;
		const query = Object.fromEntries(Object.entries({
			limit: limit.value,
			before: before.value,
			source: source.value,
			enriched: enriched.value,
		}).filter(([, value]) => value !== ''));
		const data = await sendRequest({ definition, path: definition.path, query, button, output });
		nextBefore = data && data.pagination && data.pagination.nextBefore;
		next.disabled = !nextBefore;
	};
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		return requestPage(before.value);
	});
	next.addEventListener('click', () => requestPage(nextBefore));
	return form;
};

const createJobStatusForm = () => {
	const definition = { method: 'GET', path: '/api/jobs/{jobId}', label: 'Get job status' };
	const form = element('form', { className: 'operation-card' });
	form.append(
		element('h3', { text: definition.label }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);
	const pathNames = addPathFields(form, definition.path);
	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const actions = element('div', { className: 'form-actions' });
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, actions, output);

	const renderActions = (job, jobId) => {
		actions.replaceChildren();
		const failedItems = [...(job.results || []), ...(job.scanResults || [])]
			.some((result) => ['error', 'timeout'].includes(result.status));
		const definitions = [];
		if (['pending', 'processing'].includes(job.status)) {
			definitions.push({
				method: 'POST', path: '/api/jobs/{jobId}/cancel', label: 'Cancel job', confirm: 'Cancel this job?',
			});
		}
		if (['failed', 'timed_out', 'cancelled'].includes(job.status)) {
			definitions.push({
				method: 'POST', path: '/api/jobs/{jobId}/retry', label: 'Retry job', confirm: 'Retry this job?',
			});
		}
		if (job.status !== 'processing' && failedItems) {
			definitions.push({
				method: 'POST', path: '/api/jobs/{jobId}/retry-failed', label: 'Retry failed items',
				confirm: 'Retry failed items for this job?',
			});
		}
		definitions.forEach((action) => {
			const actionButton = element('button', { text: action.label });
			actionButton.type = 'button';
			actionButton.className = 'destructive-action';
			actionButton.addEventListener('click', () => sendRequest({
				definition: action,
				path: action.path.replace('{jobId}', encodeURIComponent(jobId)),
				button: actionButton,
				output,
			}));
			actions.append(actionButton);
		});
	};

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const jobId = form.elements['path-jobId'].value;
		const data = await sendRequest({
			definition,
			path: fillPath(definition.path, pathNames, form),
			button,
			output,
		});
		if (data && data.status) renderActions(data, jobId);
		else actions.replaceChildren();
	});
	return form;
};

const createOperationForm = (contract, definition) => {
	const operation = getOperation(contract, definition);
	const form = element('form', { className: 'operation-card' });
	const title = element('h3', { text: definition.label });
	const route = element('code', { text: `${definition.method} ${definition.path}` });
	form.append(title, route);
	const pathNames = addPathFields(form, definition.path);

	if (definition.method === 'GET' || getParameters(contract, operation).some((parameter) => parameter.in === 'query')) {
		addJsonField(form, 'Query JSON', 'query', getQueryExample(contract, operation));
	}
	if (definition.method !== 'GET' && operation && operation.requestBody) {
		addJsonField(form, 'Request body JSON', 'body', getBodyExample(contract, operation));
	}

	const button = element('button', { text: definition.label });
	button.type = 'submit';
	if (definition.confirm) button.className = 'destructive-action';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, output);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		try {
			const query = form.elements.query
				? window.CabrosAdminRequest.validateQuery(parseJson(form.elements.query.value, 'Query'))
				: undefined;
			const body = getRequestBody(definition, form);
			sendRequest({
				definition,
				path: fillPath(definition.path, pathNames, form),
				query,
				body,
				button,
				output,
			});
		} catch (error) {
			showError(output, error.message);
		}
	});
	return form;
};

const renderPlayground = (contract, view) => {
	const form = element('form', { className: 'operation-card playground' });
	form.append(element('h2', { text: 'Playground' }));
	const selectLabel = element('label', { text: 'Operation' });
	const select = element('select');
	const definitions = window.CabrosAdminRequest.operationDefinitions(contract);
	definitions.forEach((definition, index) => {
		const option = element('option', { text: `${definition.method} ${definition.path} — ${definition.label}` });
		option.value = index;
		select.append(option);
	});
	selectLabel.append(select);
	const fields = element('div', { className: 'form-fields' });
	const button = element('button', { text: 'Send request' });
	button.type = 'submit';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(selectLabel, fields, button, output);
	view.append(form);

	const renderFields = () => {
		fields.replaceChildren();
		const definition = definitions[Number(select.value)];
		const operation = getOperation(contract, definition);
		button.className = definition.confirm ? 'destructive-action' : '';
		addPathFields(fields, definition.path);
		addJsonField(fields, 'Query JSON', 'query', getQueryExample(contract, operation));
		addJsonField(fields, 'Request body JSON', 'body', getBodyExample(contract, operation));
	};

	select.addEventListener('change', renderFields);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		try {
			const definition = definitions[Number(select.value)];
			const pathNames = [...definition.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
			sendRequest({
				definition,
				path: fillPath(definition.path, pathNames, form),
				query: window.CabrosAdminRequest.validateQuery(parseJson(form.elements.query.value, 'Query')),
				body: getRequestBody(definition, form),
				button,
				output,
			});
		} catch (error) {
			showError(output, error.message);
		}
	});
	renderFields();
};

const renderView = async (name) => {
	const view = document.getElementById('view');
	view.replaceChildren(element('p', { className: 'request-state', text: 'Loading API contract…' }));
	try {
		const contract = await loadContract();
		view.replaceChildren();
		if (name === 'playground') {
			renderPlayground(contract, view);
			return;
		}
		if (name === 'overview') {
			view.append(createOverviewDashboard());
			return;
		}
		view.append(element('h2', { text: name[0].toUpperCase() + name.slice(1) }));
		if (name === 'alerts') {
			view.append(createAlertListForm());
			VIEW_ACTIONS.alerts.forEach((definition) => view.append(createOperationForm(contract, definition)));
			return;
		}
		if (name === 'jobs') {
			VIEWS.jobs.forEach((definition) => view.append(createOperationForm(contract, definition)));
			view.append(createJobStatusForm());
			return;
		}
		[...(VIEWS[name] || []), ...(VIEW_ACTIONS[name] || [])]
			.forEach((definition) => view.append(createOperationForm(contract, definition)));
	} catch (error) {
		showError(view, `Unable to load the API contract: ${error.message}`);
	}
};

document.addEventListener('DOMContentLoaded', () => {
	const apiKey = document.getElementById('api-key');
	const keyState = document.getElementById('key-state');
	document.getElementById('connection-form').addEventListener('submit', (event) => {
		event.preventDefault();
		document.getElementById('save-key').click();
	});
	try {
		apiKey.value = sessionStorage.getItem('cabros-admin-api-key') || '';
	} catch (_) {
		keyState.textContent = 'Session storage is unavailable; the key will remain in this tab only.';
	}

	document.getElementById('save-key').addEventListener('click', () => {
		try {
			sessionStorage.setItem('cabros-admin-api-key', apiKey.value);
			keyState.textContent = 'API key saved for this browser session.';
		} catch (error) {
			keyState.textContent = `Could not save the API key: ${error.message}`;
		}
	});

	document.getElementById('clear-key').addEventListener('click', () => {
		apiKey.value = '';
		try {
			sessionStorage.removeItem('cabros-admin-api-key');
			keyState.textContent = 'API key cleared.';
		} catch (error) {
			keyState.textContent = `API key cleared from the form; session storage failed: ${error.message}`;
		}
	});

	document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
		document.querySelectorAll('[data-view]').forEach((item) => item.removeAttribute('aria-current'));
		button.setAttribute('aria-current', 'page');
		renderView(button.dataset.view);
	}));

	renderView('overview');
});
