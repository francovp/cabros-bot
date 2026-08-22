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

const ALLOWED_BACKEND_ORIGINS = new Set([
	'https://cabros-bot-production.up.railway.app',
]);

const getAllowedBackendOrigin = (value) => {
	try {
		const origin = new URL(value).origin;
		return ALLOWED_BACKEND_ORIGINS.has(origin) ? origin : '';
	} catch (_) {
		return '';
	}
};

const getApiBaseUrl = () => {
	try {
		const stored = typeof window !== 'undefined' && window.localStorage && window.localStorage.getItem('cabros_backend_origin');
		const storedOrigin = getAllowedBackendOrigin(stored);
		if (storedOrigin) return storedOrigin;
		const urlParams = typeof window !== 'undefined' && window.location ? new URLSearchParams(window.location.search) : null;
		const param = urlParams && urlParams.get('backend');
		const paramOrigin = getAllowedBackendOrigin(param);
		if (paramOrigin) return paramOrigin;
		if (typeof window !== 'undefined' && window.location && (window.location.hostname.endsWith('web.app') || window.location.hostname.endsWith('firebaseapp.com'))) {
			return 'https://cabros-bot-production.up.railway.app';
		}
	} catch (_) {
		// Fallback safely
	}
	return '';
};

let contractPromise;
let authConfigPromise;
let firebaseSdkPromise;
let authState = { enabled: false, auth: null, user: null, role: null };

const CONTRACT_TIMEOUT_MS = 8000;
const API_REQUEST_TIMEOUT_MS = 30000;
const LONG_RUNNING_API_REQUEST_TIMEOUT_MS = 900000;
const VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS = 360000;
const LONG_RUNNING_REQUEST_PATHS = new Set([
	'/api/webhook/expanded-analysis-alert',
	'/api/webhook/market-scanner-alert',
	'/api/news-monitor',
	'/api/scanner-presets/{id}/run',
]);
const getApiRequestTimeout = (definition) => {
	if (definition.path === '/api/webhook/volume-confirmation') return VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS;
	return LONG_RUNNING_REQUEST_PATHS.has(definition.path)
		? LONG_RUNNING_API_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS;
};

const fetchWithTimeout = (input, options, timeoutMs, consume) => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return fetch(input, { ...(options || {}), signal: controller.signal })
			.then((response) => typeof consume === 'function' ? consume(response) : response)
			.finally(() => clearTimeout(timer));
	} catch (error) {
		clearTimeout(timer);
		throw error;
	}
};

const loadContract = () => {
	if (!contractPromise) {
		const prefix = getApiBaseUrl();
		contractPromise = fetchWithTimeout(`${prefix}/openapi.json`, undefined, CONTRACT_TIMEOUT_MS, (response) => {
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

const getElement = (id) => document.getElementById(id);

const setHidden = (id, hidden) => {
	const node = getElement(id);
	if (node) node.hidden = hidden;
};

const AUTH_CONFIG_TIMEOUT_MS = 8000;

const loadAuthConfig = () => {
	if (!authConfigPromise) {
		const prefix = getApiBaseUrl();
		authConfigPromise = fetchWithTimeout(`${prefix}/admin/auth-config`, undefined, AUTH_CONFIG_TIMEOUT_MS, (response) => {
			if (!response.ok) throw new Error('Authentication configuration unavailable');
			return response.json();
		})
			.catch(() => ({ enabled: true, configured: false }));
	}
	return authConfigPromise;
};

const loadFirebaseSdk = () => {
	if (window.firebase && typeof window.firebase.initializeApp === 'function'
		&& typeof window.firebase.auth === 'function') return Promise.resolve();
	if (!firebaseSdkPromise) {
		firebaseSdkPromise = [
			'https://www.gstatic.com/firebasejs/10.13.2/firebase-app-compat.js',
			'https://www.gstatic.com/firebasejs/10.13.2/firebase-auth-compat.js',
		].reduce((chain, src) => chain.then(() => new Promise((resolve, reject) => {
			const script = document.createElement('script');
			script.src = src;
			script.onload = resolve;
			script.onerror = () => reject(new Error('Firebase SDK failed to load'));
			document.head.append(script);
		})), Promise.resolve());
	}
	return firebaseSdkPromise;
};

const showAuthState = (message, isError = false) => {
	const state = getElement('auth-state');
	if (state) {
		state.className = isError ? 'response-error' : 'request-state';
		state.textContent = message;
	}
};

const showSignedOutState = () => {
	setHidden('auth-form', false);
	setHidden('sign-out', true);
	showAuthState('Sign in to continue.');
	const view = getElement('view');
	if (view) view.replaceChildren(element('p', { className: 'request-state', text: 'Sign in required.' }));
};

const showSignedInState = () => {
	setHidden('auth-form', true);
	setHidden('sign-out', false);
	showAuthState(`Signed in as ${authState.user.email || 'admin'}.`);
};

const setupFirebaseAuth = async (config) => {
	setHidden('legacy-connection', true);
	setHidden('firebase-auth', false);
	if (!config.configured) {
		showAuthState('Firebase sign-in is unavailable. Ask an administrator to configure it.', true);
		return;
	}

	try {
		await loadFirebaseSdk();
		if (!window.firebase || typeof window.firebase.initializeApp !== 'function'
			|| typeof window.firebase.auth !== 'function') throw new Error('Firebase SDK unavailable');
		window.firebase.initializeApp(config.config);
		const auth = window.firebase.auth();
		authState = { enabled: true, auth, user: null, role: null };
		setHidden('legacy-connection', false);
		setupLegacyConsole({ persist: false });
		const persistence = window.firebase.auth.Auth
			&& window.firebase.auth.Auth.Persistence
			&& window.firebase.auth.Auth.Persistence.NONE;
		if (persistence && typeof auth.setPersistence === 'function') await auth.setPersistence(persistence);

		getElement('sign-in')?.addEventListener('click', async () => {
			try {
				await auth.signInWithEmailAndPassword(
					getElement('auth-email')?.value || '',
					getElement('auth-password')?.value || '',
				);
			} catch (error) {
				showAuthState('Sign-in failed. Check the account and try again.', true);
			}
		});
		getElement('sign-out')?.addEventListener('click', () => {
			if (getElement('api-key')) getElement('api-key').value = '';
			return auth.signOut();
		});
		auth.onAuthStateChanged(async (user) => {
			authState.user = user;
			if (!user) {
				authState.role = null;
				showSignedOutState();
				return;
			}
			try {
				const tokenResult = await user.getIdTokenResult();
				authState.role = window.CabrosAdminRequest.getAdminRole(tokenResult.claims);
				if (!authState.role) {
					showAuthState('This account is not authorized for the admin console.', true);
					return;
				}
				showSignedInState();
				navigateToView('status');
			} catch (error) {
				showAuthState('Unable to verify the signed-in account.', true);
			}
		});
	} catch (error) {
		showAuthState('Firebase sign-in is unavailable. Ask an administrator to configure it.', true);
	}
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
	if (getElement('api-key')?.value || (authState.enabled && authState.user)) {
		loadStatus();
	} else {
		metrics.replaceChildren(element('p', { className: 'request-state', text: 'Enter an API key to load live status.' }));
	}
	return dashboard;
};

const sendRequest = async ({
	definition, path, query, body, button, output, formatResponse, parseSuccessResponse, isCurrent,
}) => {
	const requestIsCurrent = typeof isCurrent === 'function' ? isCurrent : () => true;
	const apiKey = getElement('api-key')?.value || '';
	const requiredRole = definition.requiredRole || (definition.method === 'GET' ? 'admin.viewer' : 'admin.operator');
	if (authState.enabled && (!authState.user || !window.CabrosAdminRequest.canAccess({ requiredRole }, authState.role))) {
		showError(output, authState.user ? 'Your admin role cannot perform this operation.' : 'Sign in is required.');
		return;
	}
	let authToken;
	if (authState.enabled) {
		try {
			authToken = await authState.user.getIdToken();
		} catch (error) {
			showError(output, 'Unable to refresh the admin sign-in. Please sign in again.');
			return;
		}
	}
	const summary = window.CabrosAdminRequest.redactSecret(`${definition.method} ${path}`, apiKey);
	let request;
	try {
		request = window.CabrosAdminRequest.createRequest({
			path,
			method: definition.method,
			query,
			body,
			apiKey,
			authToken,
			baseUrl: getApiBaseUrl(),
		});
	} catch (error) {
		showError(output, error.message);
		return;
	}

	if (!window.CabrosAdminRequest.confirmRequest(definition, (message) => window.confirm(message))) return;

	if (!requestIsCurrent()) return;
	button.disabled = true;
	output.className = 'response-block request-state';
	output.textContent = `${summary}\nRequest in progress…`;
	const started = performance.now();
	try {
		const result = await fetchWithTimeout(request.url, request.options, getApiRequestTimeout(definition), async (response) => {
			const elapsed = Math.round(performance.now() - started);
			let data;
			let formatted;
			if (response.ok && typeof parseSuccessResponse === 'function') {
				({ data, formatted } = await parseSuccessResponse(response));
			} else {
				const text = await response.text();
				formatted = text || '(empty response)';
				try {
					data = JSON.parse(text);
					formatted = JSON.stringify(data, null, 2);
				} catch (_) {
					// Non-JSON responses stay readable as text.
				}
			}
			return { response, data, formatted, elapsed };
		});
		const { response, data, formatted, elapsed } = result;
		if (!requestIsCurrent()) return response.ok ? data : undefined;
		output.className = `response-block${response.ok ? '' : ' response-error'}`;
		const responseText = response.ok && formatResponse
			? formatResponse({ summary, status: response.status, elapsed, data })
			: `${summary}\nHTTP ${response.status} · ${elapsed} ms\n\n${window.CabrosAdminRequest.redactSecret(formatted, apiKey)}`;
		output.textContent = window.CabrosAdminRequest.redactSecret(responseText, apiKey);
		return response.ok ? data : undefined;
	} catch (error) {
		const elapsed = Math.round(performance.now() - started);
		if (!requestIsCurrent()) return;
		showError(output, `${summary}\nNetwork error · ${elapsed} ms\n\n${window.CabrosAdminRequest.redactSecret(error.message, apiKey)}`);
	} finally {
		if (requestIsCurrent()) button.disabled = false;
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

const toDateTimeLocal = (date) => {
	const offset = date.getTimezoneOffset();
	return new Date(date.getTime() - offset * 60 * 1000).toISOString().slice(0, 16);
};

const reportWindowDefaults = () => {
	const to = new Date();
	return {
		from: toDateTimeLocal(new Date(to.getTime() - 24 * 60 * 60 * 1000)),
		to: toDateTimeLocal(to),
	};
};

const addAlertReportFilters = (form, { requiredWindow = false } = {}) => {
	const defaults = reportWindowDefaults();
	const from = addField(form, 'From', 'from', {
		type: 'datetime-local', value: defaults.from, required: requiredWindow,
	});
	const to = addField(form, 'To', 'to', {
		type: 'datetime-local', value: defaults.to, required: requiredWindow,
	});
	const limit = addField(form, 'Limit', 'limit', { type: 'number', min: 1, max: 1000, value: 500 });
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
	return { from, to, limit, source, enriched };
};

const toIsoTimestamp = (value, label) => {
	if (!value) return undefined;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date and time.`);
	return date.toISOString();
};

const getAlertReportQuery = (fields, { format, includeText } = {}) => Object.fromEntries(
	Object.entries({
		from: toIsoTimestamp(fields.from.value, 'From'),
		to: toIsoTimestamp(fields.to.value, 'To'),
		limit: fields.limit.value,
		source: fields.source.value,
		enriched: fields.enriched.value,
		format,
		includeText,
	}).filter(([, value]) => value !== undefined && value !== ''),
);

const formatSummaryValue = (value) => {
	if (Array.isArray(value)) return `[${value.map(formatSummaryValue).join(', ')}]`;
	if (value && typeof value === 'object') {
		return `{ ${Object.entries(value).map(([key, nested]) => `${key}: ${formatSummaryValue(nested)}`).join(', ')} }`;
	}
	return String(value);
};

const formatAlertSummary = ({ summary, status, elapsed, data }) => {
	const values = data && data.summary && typeof data.summary === 'object' ? data.summary : {};
	const lines = Object.entries(values).map(([key, value]) => `${key}: ${formatSummaryValue(value)}`);
	return `${summary}\nHTTP ${status} · ${elapsed} ms\n\n${lines.length
		? lines.join('\n') : 'No summary data returned.'}`;
};

const parseAlertExportResponse = (format) => async (response) => {
	const blob = await response.blob();
	const contentType = response.headers && typeof response.headers.get === 'function'
		? response.headers.get('content-type') || blob.type
		: blob.type;
	const filename = `alerts-export.${format}`;
	const url = window.URL.createObjectURL(blob);
	const link = element('a');
	link.href = url;
	link.download = filename;
	if (typeof link.click === 'function') link.click();
	window.URL.revokeObjectURL(url);
	return {
		data: { contentType, filename },
		formatted: `Downloaded ${filename} (${contentType || 'unknown content type'}).`,
	};
};

const createAlertSummaryForm = () => {
	const definition = { method: 'GET', path: '/api/alerts/summary', label: 'Load alert analytics' };
	const form = element('form', { className: 'operation-card' });
	form.append(
		element('h3', { text: definition.label }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);
	const fields = addAlertReportFilters(form);
	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, output);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		try {
			sendRequest({
				definition,
				path: definition.path,
				query: getAlertReportQuery(fields),
				button,
				output,
				formatResponse: formatAlertSummary,
			});
		} catch (error) {
			showError(output, error.message);
		}
	});
	return form;
};

const createAlertExportForm = () => {
	const definition = { method: 'GET', path: '/api/alerts/export', label: 'Export alerts' };
	const form = element('form', { className: 'operation-card' });
	form.append(
		element('h3', { text: definition.label }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);
	const fields = addAlertReportFilters(form, { requiredWindow: true });
	const format = addField(form, 'Format', 'format', { tag: 'select' });
	[['jsonl', 'JSONL'], ['csv', 'CSV']].forEach(([value, text]) => {
		const option = element('option', { text });
		option.value = value;
		format.append(option);
	});
	const includeText = addField(form, 'Include raw alert text (explicit opt-in)', 'includeText', {
		type: 'checkbox', checked: false,
	});
	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, output);
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		if (!fields.from.value || !fields.to.value) {
			showError(output, 'From and To are required for a bounded export.');
			return;
		}
		try {
			sendRequest({
				definition,
				path: definition.path,
				query: getAlertReportQuery(fields, { format: format.value, includeText: includeText.checked }),
				button,
				output,
				parseSuccessResponse: parseAlertExportResponse(format.value),
				formatResponse: ({ summary, status, elapsed, data }) => (
					`${summary}\nHTTP ${status} · ${elapsed} ms\n\nDownloaded ${data.filename} (${data.contentType || 'unknown content type'}).`
				),
			});
		} catch (error) {
			showError(output, error.message);
		}
	});
	return form;
};

const getQueryEnum = (contract, definition, name) => {
	const operation = getOperation(contract, definition);
	const parameter = getParameters(contract, operation).find((item) => item.name === name);
	return parameter && parameter.schema && parameter.schema.enum || [];
};

const formatJobValue = (value) => value === undefined || value === null || value === '' ? '—' : String(value);

const formatJobProgress = (progress) => {
	if (!progress || typeof progress !== 'object') return '—';
	return `${formatJobValue(progress.current)} / ${formatJobValue(progress.total)}`;
};

const createJobSummary = (job, onSelect) => {
	const card = element('article', { className: 'operation-card' });
	const jobId = formatJobValue(job && job.jobId);
	card.append(element('h3', { text: jobId }));

	const details = element('dl');
	[
		['Type', job && job.type],
		['Status', job && job.status],
		['Progress', formatJobProgress(job && job.progress)],
		['Created', job && job.createdAt],
		['Updated', job && job.updatedAt],
		['Duration', job && job.totalDurationMs !== undefined && job.totalDurationMs !== null
			? `${job.totalDurationMs} ms` : undefined],
	].forEach(([label, value]) => {
		details.append(element('dt', { text: label }), element('dd', { text: formatJobValue(value) }));
	});
	card.append(details);

	const select = element('button', { text: 'Open status' });
	select.type = 'button';
	select.disabled = jobId === '—';
	select.addEventListener('click', () => onSelect(jobId));
	card.append(select);
	return card;
};

const createJobListForm = (contract, onSelect) => {
	const definition = { method: 'GET', path: '/api/jobs', label: 'Load recent jobs' };
	const operation = getOperation(contract, definition);
	const form = element('form', { className: 'operation-card' });
	form.append(
		element('h3', { text: definition.label }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);
	const queryExample = getQueryExample(contract, operation);
	const limit = addField(form, 'Limit', 'limit', {
		type: 'number', min: 1, max: 100, value: queryExample.limit || 50,
	});
	const status = addField(form, 'Status', 'status', { tag: 'select' });
	const type = addField(form, 'Type', 'type', { tag: 'select' });
	[
		[status, 'All statuses', getQueryEnum(contract, definition, 'status')],
		[type, 'All types', getQueryEnum(contract, definition, 'type')],
	].forEach(([select, allLabel, values]) => {
		const all = element('option', { text: allLabel });
		all.value = '';
		select.append(all);
		values.forEach((value) => {
			const option = element('option', { text: value });
			option.value = value;
			select.append(option);
		});
	});

	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const list = element('div', { className: 'form-fields' });
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, list, output);
	let listRequestVersion = 0;
	const invalidateListRequest = () => {
		listRequestVersion += 1;
		list.replaceChildren();
		button.disabled = false;
		output.className = 'response-block request-state';
		output.textContent = 'Filters changed. Submit to load recent jobs.';
	};
	limit.addEventListener('input', invalidateListRequest);
	[status, type].forEach((filter) => filter.addEventListener('change', invalidateListRequest));

	const renderJobs = (jobs) => {
		list.replaceChildren();
		if (!jobs.length) {
			list.append(element('p', { className: 'request-state', text: 'No recent jobs found.' }));
			return;
		}
		jobs.forEach((job) => list.append(createJobSummary(job, onSelect)));
	};

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		list.replaceChildren();
		const requestVersion = ++listRequestVersion;
		const query = Object.fromEntries(Object.entries({
			limit: limit.value,
			status: status.value,
			type: type.value,
		}).filter(([, value]) => value !== ''));
		const data = await sendRequest({
			definition,
			path: definition.path,
			query,
			button,
			output,
			isCurrent: () => requestVersion === listRequestVersion,
			formatResponse: ({ summary, status: responseStatus, elapsed }) => (
				`${summary}\nHTTP ${responseStatus} · ${elapsed} ms`
			),
		});
		if (requestVersion === listRequestVersion && data && Array.isArray(data.jobs)) renderJobs(data.jobs);
	});
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
	const jobIdInput = form.elements['path-jobId'];
	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const actions = element('div', { className: 'form-actions' });
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	form.append(button, actions, output);
	let statusRequestVersion = 0;
	jobIdInput.addEventListener('input', () => {
		statusRequestVersion += 1;
		button.disabled = false;
		actions.replaceChildren();
	});

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
		const actionVersion = statusRequestVersion;
		definitions.forEach((action) => {
			const actionButton = element('button', { text: action.label });
			actionButton.type = 'button';
			actionButton.className = 'destructive-action';
			actionButton.addEventListener('click', () => sendRequest({
				definition: action,
				path: action.path.replace('{jobId}', encodeURIComponent(jobId)),
				button: actionButton,
				output,
				isCurrent: () => actionVersion === statusRequestVersion
					&& form.elements['path-jobId'].value === jobId,
			}));
			actions.append(actionButton);
		});
	};

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const jobId = form.elements['path-jobId'].value;
		const requestVersion = ++statusRequestVersion;
		const data = await sendRequest({
			definition,
			path: fillPath(definition.path, pathNames, form),
			button,
			output,
			isCurrent: () => requestVersion === statusRequestVersion
				&& form.elements['path-jobId'].value === jobId,
		});
		if (requestVersion !== statusRequestVersion || form.elements['path-jobId'].value !== jobId) return;
		if (data && data.status) renderActions(data, jobId);
		else actions.replaceChildren();
	});
	return {
		form,
		selectJob: (jobId) => {
			statusRequestVersion += 1;
			jobIdInput.value = jobId;
			button.disabled = false;
			actions.replaceChildren();
			output.textContent = 'Job selected. Submit to load its status.';
			if (typeof jobIdInput.focus === 'function') jobIdInput.focus();
		},
	};
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
			view.append(createAlertSummaryForm(), createAlertExportForm());
			VIEW_ACTIONS.alerts.forEach((definition) => view.append(createOperationForm(contract, definition)));
			return;
		}
		if (name === 'jobs') {
			const status = createJobStatusForm();
			view.append(createJobListForm(contract, status.selectJob));
			VIEWS.jobs.forEach((definition) => view.append(createOperationForm(contract, definition)));
			view.append(status.form);
			return;
		}
		[...(VIEWS[name] || []), ...(VIEW_ACTIONS[name] || [])]
			.forEach((definition) => view.append(createOperationForm(contract, definition)));
	} catch (error) {
		showError(view, `Unable to load the API contract: ${error.message}`);
	}
};

const navigateToView = (name) => {
	if (authState.enabled && !authState.user) return showSignedOutState();
	const buttons = document.querySelectorAll('[data-view]');
	buttons.forEach((button) => button.removeAttribute('aria-current'));
	[...buttons].find((button) => button.dataset.view === name)?.setAttribute('aria-current', 'page');
	return renderView(name);
};

const setupLegacyConsole = ({ persist = true } = {}) => {
	const apiKey = getElement('api-key');
	const keyState = getElement('key-state');
	if (!apiKey || !keyState) return;
	if (persist) {
		try {
			apiKey.value = sessionStorage.getItem('cabros-admin-api-key') || '';
		} catch (_) {
			keyState.textContent = 'Session storage is unavailable; the key will remain in this tab only.';
		}
	} else {
		keyState.textContent = 'API key is used only for webhook operations and is not stored.';
	}

	getElement('save-key')?.addEventListener('click', () => {
		if (!persist) {
			keyState.textContent = 'API key kept only in memory for webhook operations.';
			return;
		}
		try {
			sessionStorage.setItem('cabros-admin-api-key', apiKey.value);
			keyState.textContent = 'API key saved for this browser session.';
		} catch (error) {
			keyState.textContent = `Could not save the API key: ${error.message}`;
		}
	});

	getElement('clear-key')?.addEventListener('click', () => {
		apiKey.value = '';
		if (!persist) {
			keyState.textContent = 'API key cleared from the form.';
			return;
		}
		try {
			sessionStorage.removeItem('cabros-admin-api-key');
			keyState.textContent = 'API key cleared.';
		} catch (error) {
			keyState.textContent = `API key cleared from the form; session storage failed: ${error.message}`;
		}
	});
};

document.addEventListener('DOMContentLoaded', async () => {
	const view = getElement('view');
	if (view) view.replaceChildren(element('p', { className: 'request-state', text: 'Checking authentication…' }));
	document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigateToView(button.dataset.view)));

	getElement('connection-form')?.addEventListener('submit', (event) => {
		event.preventDefault();
		getElement('save-key')?.click();
	});

	const config = await loadAuthConfig();
	if (config.enabled) {
		await setupFirebaseAuth(config);
		return;
	}

	authState = { enabled: false, auth: null, user: null, role: 'admin.operator' };
	setHidden('firebase-auth', true);
	setHidden('legacy-connection', false);
	setupLegacyConsole();
	renderView('overview');
});
