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
		{
			method: 'POST', path: '/api/webhook/symbol-analysis', label: 'Symbol analysis',
			renderSuccess: (data) => symbolAnalysisResult(data),
		},
		{
			method: 'POST', path: '/api/webhook/expanded-analysis-alert', label: 'Expanded analysis',
			renderSuccess: (data) => analysisReportResult(data),
		},
		{
			method: 'POST', path: '/api/webhook/market-scanner-alert', label: 'Market scanner',
			renderSuccess: (data) => analysisReportResult(data),
		},
		{
			method: 'POST', path: '/api/webhook/volume-confirmation', label: 'Volume confirmation',
			renderSuccess: (data) => volumeConfirmationResult(data),
		},
		{
			method: 'POST', path: '/api/news-monitor', label: 'News monitor',
			renderSuccess: (data) => newsMonitorResults(data),
		},
	],
};

const VIEW_ACTIONS = {
	alerts: [
		{
			method: 'GET', path: '/api/alerts/{alertId}', label: 'Get alert by ID',
			renderSuccess: (data) => (data && data.alert ? createAlertDetailPanel(data.alert) : null),
		},
		{
			method: 'POST', path: '/api/alerts/{alertId}/replay', label: 'Replay alert',
			confirm: 'Replay this alert?',
			renderSuccess: (data) => {
				const chips = deliveryChips(data && data.results);
				return chips.children.length ? chips : null;
			},
		},
	],
	presets: [
		{ method: 'PUT', path: '/api/scanner-presets/{id}', label: 'Update preset' },
		{
			method: 'POST', path: '/api/scanner-presets/{id}/run', label: 'Run preset',
			confirm: 'Run this scanner preset?',
			renderSuccess: (data) => analysisReportResult(data),
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
let detachActiveViewPoll = null;
let authState = { enabled: false, auth: null, user: null, role: null };

const CONTRACT_TIMEOUT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.CONTRACT_TIMEOUT_MS
	? window.CabrosAdminRequest.CONTRACT_TIMEOUT_MS : 8000;
const API_REQUEST_TIMEOUT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.API_REQUEST_TIMEOUT_MS
	? window.CabrosAdminRequest.API_REQUEST_TIMEOUT_MS : 30000;

// Volume confirmation budget breakdown:
// - 3 sequential TradingView MCP JSON-RPC requests (initialize, notifications/initialized, tools/call)
// - Max TRADINGVIEW_MCP_TIMEOUT_MS: 120,000 ms per RPC
// - Ingress, route handling, Firestore claim, and network transport overhead: 30,000 ms
const VOLUME_CONFIRMATION_MCP_CALLS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.VOLUME_CONFIRMATION_MCP_CALLS
	? window.CabrosAdminRequest.VOLUME_CONFIRMATION_MCP_CALLS : 3;
const TRADINGVIEW_MCP_MAX_TIMEOUT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.TRADINGVIEW_MCP_MAX_TIMEOUT_MS
	? window.CabrosAdminRequest.TRADINGVIEW_MCP_MAX_TIMEOUT_MS : 120000;
const VOLUME_CONFIRMATION_OVERHEAD_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.VOLUME_CONFIRMATION_OVERHEAD_MS
	? window.CabrosAdminRequest.VOLUME_CONFIRMATION_OVERHEAD_MS : 30000;
const VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS
	? window.CabrosAdminRequest.VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS
	: (VOLUME_CONFIRMATION_MCP_CALLS * TRADINGVIEW_MCP_MAX_TIMEOUT_MS) + VOLUME_CONFIRMATION_OVERHEAD_MS; // 390000 ms

// Long-running alert and analysis pipeline budget breakdown:
// - TradingView MCP enrichment maximum budget: 120,000 ms (TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS max)
// - Gemini Grounding analysis maximum timeout: 120,000 ms (GROUNDING_TIMEOUT_MS max)
// - Total enrichment stage: 240,000 ms
// - Notification delivery (Discord multi-chunk delivery with retries):
//   - Max 3 message chunks (2,000 chars per chunk)
//   - Per chunk: initial attempt (10,000 ms) + up to 10 retries (10 * 10,000 ms = 100,000 ms) + max retry backoff wait (120,000 ms) = 230,000 ms
//   - 3 chunks * 230,000 ms = 690,000 ms
// - Combined backend worst-case budget: 240,000 ms + 690,000 ms = 930,000 ms
// - Network transport, parsing, and execution overhead: 60,000 ms
const TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS
	? window.CabrosAdminRequest.TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS : 120000;
const GROUNDING_MAX_TIMEOUT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.GROUNDING_MAX_TIMEOUT_MS
	? window.CabrosAdminRequest.GROUNDING_MAX_TIMEOUT_MS : 120000;
const DISCORD_MAX_CHUNKS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.DISCORD_MAX_CHUNKS
	? window.CabrosAdminRequest.DISCORD_MAX_CHUNKS : 3;
const DISCORD_REQUEST_TIMEOUT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.DISCORD_REQUEST_TIMEOUT_MS
	? window.CabrosAdminRequest.DISCORD_REQUEST_TIMEOUT_MS : 10000;
const DISCORD_MAX_RETRIES = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.DISCORD_MAX_RETRIES
	? window.CabrosAdminRequest.DISCORD_MAX_RETRIES : 10;
const DISCORD_MAX_TOTAL_RETRY_WAIT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.DISCORD_MAX_TOTAL_RETRY_WAIT_MS
	? window.CabrosAdminRequest.DISCORD_MAX_TOTAL_RETRY_WAIT_MS : 120000;
const DISCORD_MAX_CHUNK_BUDGET_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.DISCORD_MAX_CHUNK_BUDGET_MS
	? window.CabrosAdminRequest.DISCORD_MAX_CHUNK_BUDGET_MS
	: DISCORD_REQUEST_TIMEOUT_MS + (DISCORD_MAX_RETRIES * DISCORD_REQUEST_TIMEOUT_MS) + DISCORD_MAX_TOTAL_RETRY_WAIT_MS; // 230000 ms
const DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS
	? window.CabrosAdminRequest.DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS
	: DISCORD_MAX_CHUNKS * DISCORD_MAX_CHUNK_BUDGET_MS; // 690000 ms
const LONG_RUNNING_BACKEND_BUDGET_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.LONG_RUNNING_BACKEND_BUDGET_MS
	? window.CabrosAdminRequest.LONG_RUNNING_BACKEND_BUDGET_MS
	: TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS + GROUNDING_MAX_TIMEOUT_MS + DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS; // 930000 ms
const LONG_RUNNING_OVERHEAD_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.LONG_RUNNING_OVERHEAD_MS
	? window.CabrosAdminRequest.LONG_RUNNING_OVERHEAD_MS : 60000;
const LONG_RUNNING_API_REQUEST_TIMEOUT_MS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.LONG_RUNNING_API_REQUEST_TIMEOUT_MS
	? window.CabrosAdminRequest.LONG_RUNNING_API_REQUEST_TIMEOUT_MS
	: LONG_RUNNING_BACKEND_BUDGET_MS + LONG_RUNNING_OVERHEAD_MS; // 990000 ms

const LONG_RUNNING_REQUEST_PATHS = typeof window !== 'undefined' && window.CabrosAdminRequest && window.CabrosAdminRequest.LONG_RUNNING_REQUEST_PATHS
	? window.CabrosAdminRequest.LONG_RUNNING_REQUEST_PATHS
	: new Set([
		'/api/webhook/expanded-analysis-alert',
		'/api/webhook/market-scanner-alert',
		'/api/news-monitor',
		'/api/scanner-presets/{id}/run',
		'/api/webhook/alert',
		'/api/webhook/message',
		'/api/alerts/{alertId}/replay',
	]);

const getApiRequestTimeout = (definition) => {
	if (typeof window !== 'undefined' && window.CabrosAdminRequest && typeof window.CabrosAdminRequest.getApiRequestTimeout === 'function') {
		return window.CabrosAdminRequest.getApiRequestTimeout(definition);
	}
	if (!definition || !definition.path) return API_REQUEST_TIMEOUT_MS;
	if (definition.path === '/api/webhook/volume-confirmation'
		|| definition.path === '/api/webhook/symbol-analysis') {
		return VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS;
	}
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
	if (options.text !== undefined) node.textContent = options.text;
	if (options.attributes) {
		Object.entries(options.attributes).forEach(([name, value]) => node.setAttribute(name, value));
	}
	return node;
};

const getElement = (id) => document.getElementById(id);

const setHidden = (id, hidden) => {
	const node = getElement(id);
	if (node) node.hidden = hidden;
};

const createLoadingState = (label) => {
	const wrap = element('span', {
		className: 'loading-state',
		attributes: { role: 'status' },
	});
	wrap.append(
		element('span', { className: 'spinner', attributes: { 'aria-hidden': 'true' } }),
		element('span', { text: label }),
	);
	return wrap;
};

const createEmptyState = (text) => element('p', { className: 'empty-state', text });

const formatRelativeTime = (value, now = Date.now()) => {
	const date = new Date(value);
	if (!value || Number.isNaN(date.getTime())) return null;
	const diffMinutes = Math.round((now - date.getTime()) / 60000);
	if (diffMinutes < 1) return 'just now';
	if (diffMinutes < 60) return `${diffMinutes} min ago`;
	const diffHours = Math.round(diffMinutes / 60);
	if (diffHours < 24) return `${diffHours} h ago`;
	const diffDays = Math.round(diffHours / 24);
	return `${diffDays} d ago`;
};

const createTimestamp = (value) => {
	const date = new Date(value);
	const readable = !value || Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleString();
	return element('span', {
		className: 'timestamp',
		text: formatRelativeTime(value) || readable,
		attributes: { title: readable },
	});
};

const copyToClipboard = async (text, button) => {
	const original = button.textContent;
	let copied = false;
	try {
		if (typeof navigator !== 'undefined' && navigator.clipboard
			&& typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(text);
			copied = true;
		} else if (typeof document.execCommand === 'function') {
			const area = document.createElement('textarea');
			area.value = text;
			area.setAttribute('readonly', 'readonly');
			document.body.append(area);
			try {
				area.select();
				copied = document.execCommand('copy');
			} finally {
				if (typeof area.remove === 'function') area.remove();
			}
		}
	} catch (_) {
		copied = false;
	}
	button.textContent = copied ? 'Copied!' : 'Copy unavailable';
	setTimeout(() => {
		button.textContent = original;
	}, 2000);
};

const createCopyButton = (getText, label = 'Copy') => {
	const button = element('button', { text: label });
	button.type = 'button';
	button.className = 'copy-button';
	button.addEventListener('click', () => copyToClipboard(
		typeof getText === 'function' ? String(getText() ?? '') : String(getText ?? ''),
		button,
	));
	return button;
};

const AUTH_CONFIG_TIMEOUT_MS = 8000;
const JOB_POLL_INTERVAL_MS = 5000;

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
	if (typeof detachActiveViewPoll === 'function') detachActiveViewPoll();
	detachActiveViewPoll = null;
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
	return value.$ref.slice(2).split('/').reduce((current, key) => current && current[key], contract);
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

const SYMBOL_PATTERN = /^[A-Za-z0-9_]+:[A-Za-z0-9._-]+$/;

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
	.filter(([, detail]) => detail && typeof detail === 'object');

const hasStatus = (detail) => detail.status !== undefined && detail.status !== null && detail.status !== '';
const nestedStatusEntries = (detail) => Object.entries(asObject(detail))
	.filter(([name, nested]) => name === 'profiling' && hasStatus(nested));
const statusDetails = (detail) => [detail, ...nestedStatusEntries(detail).map(([, nested]) => nested)];
const effectiveStatus = (detail) => statusDetails(detail).find((statusDetail) => hasStatus(statusDetail)
	&& !['ready', 'disabled'].includes(statusDetail.status))?.status || detail.status;

const statusCounts = (entries) => entries.reduce((counts, [, detail]) => {
	const status = effectiveStatus(detail);
	if (status) counts[status] = (counts[status] || 0) + 1;
	return counts;
}, {});

const statusNeedsAttention = (detail) => hasStatus({ status: effectiveStatus(detail) })
	&& !['ready', 'disabled'].includes(effectiveStatus(detail));

const statusDetailFields = [
	['configured', 'Configured'],
	['enabled', 'Enabled'],
	['environment', 'Environment'],
	['allowedSymbols', 'Allowed symbols'],
	['maxNotionalConfigured', 'Max notional configured'],
	['lastSuccessfulLoad', 'Last successful load', true],
	['cooldownActive', 'Cooldown active'],
	['remainingCooldownMs', 'Remaining cooldown (ms)'],
	['lastTriggeredAt', 'Last triggered', true],
	['triggersTotal', 'Triggers total'],
	['braveFallbacksDuringCooldown', 'Brave fallbacks during cooldown'],
	['lastBraveFallbackAt', 'Last Brave fallback', true],
	['lastCheckedAt', 'Last checked', true],
	['lastSuccessAt', 'Last success', true],
	['lastFailureAt', 'Last failure', true],
	['lastErrorCategory', 'Last error'],
	['successCount', 'Successes'],
	['failureCount', 'Failures'],
	['windowMs', 'Window (ms)'],
	['activeEntries', 'Active entries'],
	['hits', 'Hits'],
	['misses', 'Misses'],
	['failures', 'Coalescing failures'],
	['suppressedCount', 'Suppressed'],
	['lastSuppressedAt', 'Last suppressed', true],
	['activeTrackedSignals', 'Active tracked signals'],
	['intervalMs', 'Interval (ms)'],
	['batchLimit', 'Batch limit'],
	['maxAttempts', 'Max attempts'],
	['maxAgeMs', 'Max age (ms)'],
	['enqueued', 'Enqueued'],
	['claimed', 'Claimed'],
	['completed', 'Completed'],
	['failed', 'Failed'],
	['lastErrorCode', 'Last error code'],
	['lastEnqueuedAt', 'Last enqueued', true],
	['mode', 'Mode'],
	['backend', 'Backend'],
	['role', 'Worker role'],
	['running', 'Running'],
	['shutdownRequested', 'Shutdown requested'],
	['isEvaluating', 'Evaluating'],
	['source', 'Source'],
	['templateVersion', 'Template version'],
	['consecutiveFailures', 'Consecutive failures'],
	['lastRunAt', 'Last run', true],
	['lastRunDurationMs', 'Last run duration (ms)'],
	['lastRunSymbolCount', 'Last run symbols'],
	['lastRunExecutedCount', 'Last run executed'],
	['lastRunRedrivenCount', 'Last run redriven'],
	['lastRunScannedCount', 'Last run scanned'],
	['lastRunEvaluatedCount', 'Last run evaluated'],
	['lastRunPendingCount', 'Last run pending'],
	['lastRunErrorCount', 'Last run errors'],
	['pendingCount', 'Pending'],
	['deliveredCount', 'Delivered'],
	['exhaustedCount', 'Exhausted'],
	['zeroChannelBroadcasts', 'Zero-channel broadcasts'],
	['lastPollAt', 'Last poll', true],
	['lastError', 'Last error detail'],
	['lastErrorAt', 'Last error at', true],
	['metrics.totalRequests', 'Total requests'],
	['metrics.successRequests', 'Success requests'],
	['metrics.failureRequests', 'Failure requests'],
	['metrics.timeoutRequests', 'Timeout requests'],
	['circuitBreaker.state', 'Circuit breaker state'],
	['circuitBreaker.openedAt', 'Circuit breaker opened', true],
	['circuitBreaker.cooldownMs', 'Circuit breaker cooldown (ms)'],
	['circuitBreaker.consecutiveFailures', 'Circuit breaker consecutive failures'],
	['enrichment.alertPath.windowMs', 'Alert path window (ms)'],
	['enrichment.alertPath.totalCount', 'Alert path total'],
	['enrichment.alertPath.appliedCount', 'Alert path applied'],
	['enrichment.alertPath.failedCount', 'Alert path failed'],
	['enrichment.alertPath.appliedRate24h', 'Alert path applied rate (%)'],
	['enrichment.alertPath.failureRate24h', 'Alert path failure rate (%)'],
];

const statusFieldValue = (detail, key) => key.split('.').reduce((value, part) => asObject(value)[part], detail);

const SENTIMENT_TONES = {
	bullish: 'status-ready',
	bearish: 'status-danger',
	neutral: 'status-disabled',
};

const DECISION_ACTION_TONES = {
	buy: 'status-ready',
	sell: 'status-danger',
	no_trade: 'status-disabled',
	hold: 'status-disabled',
	neutral: 'status-disabled',
};

const JOB_ACTIVE_STATUSES = ['pending', 'processing'];
const JOB_STATUS_TONES = {
	completed: 'status-ready',
	failed: 'status-danger',
	cancelled: 'status-danger',
	timed_out: 'status-danger',
	processing: 'status-active',
	pending: 'status-active',
};
const RESULT_STATUS_TONES = {
	analyzed: 'status-ready',
	success: 'status-ready',
	cached: 'status-disabled',
	error: 'status-danger',
	timeout: 'status-danger',
	failed: 'status-danger',
};

const createStatusBadge = (status, tones) => element('span', {
	className: `status-badge ${(tones && tones[status]) || `status-${statusTone(status)}`}`,
	text: tones ? displayLabel(status) : displayStatus(status),
});

const createMeter = (fraction, labelText) => {
	const wrap = element('div', { className: 'meter' });
	const track = element('div', { className: 'progress-track' });
	const fill = element('div', { className: 'progress-fill' });
	const bounded = Math.max(0, Math.min(1, Number(fraction) || 0));
	fill.style = `width: ${Math.round(bounded * 100)}%;`;
	track.append(fill);
	wrap.append(track);
	if (labelText) wrap.append(element('span', { className: 'meter-label', text: labelText }));
	return wrap;
};

const symbolResultsTable = (results) => {
	if (!Array.isArray(results) || !results.length) return null;
	const table = element('table', { className: 'data-table' });
	const head = element('tr');
	['Symbol', 'Status', 'Price', 'RSI'].forEach((label) => head.append(element('th', { text: label })));
	table.append(head);
	results.forEach((result) => {
		const detail = asObject(result);
		if (!detail.symbol && !detail.status) return;
		const row = element('tr');
		row.append(
			element('td', { text: formatJobValue(detail.symbol) }),
			element('td', { text: formatJobValue(detail.status) }),
			element('td', { text: formatJobValue(detail.price) }),
			element('td', { text: formatJobValue(detail.rsi) }),
		);
		table.append(row);
	});
	return table.children.length > 1 ? table : null;
};

const trendCell = (confluence) => {
	const detail = asObject(confluence);
	if (!detail.status) return formatJobValue(undefined);
	const direction = detail.direction ? ` ${detail.direction}` : '';
	const confidence = asFiniteNumber(detail.confidence);
	return `${displayLabel(detail.status)}${direction}`
		+ `${confidence !== null ? ` (${confidence}%)` : ''}`;
};

const scanResultSections = (scanResults) => {
	const wrap = element('div');
	(Array.isArray(scanResults) ? scanResults : []).forEach((scan) => {
		const detail = asObject(scan);
		const section = element('section', { className: 'dashboard-section scan-section' });
		section.append(element('h3', {
			text: `${detail.scan || 'scan'} · ${displayStatus(detail.status || 'unknown')}`,
		}));
		const scores = Array.isArray(detail.scores) ? detail.scores : [];
		if (scores.length) {
			const table = element('table', { className: 'data-table' });
			const head = element('tr');
			['Symbol', 'Score', 'Reason', 'Trend'].forEach((label) => head.append(element('th', { text: label })));
			table.append(head);
			scores.forEach((entry) => {
				const score = asObject(entry);
				const confluence = asObject(score.trendConfluence);
				const row = element('tr');
				row.append(
					element('td', { text: formatJobValue(score.symbol) }),
					element('td', { text: formatJobValue(score.score) }),
					element('td', { text: formatJobValue(score.reason) }),
					element('td', { text: trendCell(confluence) }),
				);
				table.append(row);
			});
			section.append(table);
		} else if (detail.itemCount !== undefined) {
			section.append(element('p', {
				className: 'request-state',
				text: `${formatJobValue(detail.itemCount)} items`,
			}));
		} else if (['error', 'timeout'].includes(detail.status)) {
			section.append(createEmptyState(`This scan did not complete (${displayStatus(detail.status)}).`));
		}
		wrap.append(section);
	});
	return wrap.children.length ? wrap : null;
};

const summaryCounterChips = (summary, keys) => {
	const wrap = element('div', { className: 'chip-grid' });
	keys.forEach(([key, label]) => {
		const value = asObject(summary)[key];
		if (value === undefined || value === null) return;
		wrap.append(element('span', { className: 'capability-chip', text: `${label}: ${value}` }));
	});
	return wrap;
};

const createJobPanel = (data) => {
	const panel = element('article', { className: 'operation-card job-panel' });
	const headCopy = element('div');
	headCopy.append(
		element('p', { className: 'eyebrow', text: 'Job status' }),
		element('p', { className: 'mono-line', text: formatJobValue(data.jobId) }),
	);
	const badges = element('div', { className: 'badge-row' });
	if (data.type) badges.append(element('span', { className: 'capability-chip', text: displayLabel(data.type) }));
	badges.append(createStatusBadge(data.status, JOB_STATUS_TONES));
	const head = element('div', { className: 'section-heading' });
	head.append(headCopy, badges);
	panel.append(head);

	const meta = element('div', { className: 'badge-row job-meta' });
	if (data.createdAt) meta.append(createTimestamp(data.createdAt));
	if (data.updatedAt) meta.append(createTimestamp(data.updatedAt));
	if (data.totalDurationMs !== undefined && data.totalDurationMs !== null) {
		meta.append(element('span', { className: 'timestamp', text: `${data.totalDurationMs} ms` }));
	}
	if (meta.children.length) panel.append(meta);

	const progress = asObject(data.progress);
	const total = asFiniteNumber(progress.total);
	const current = asFiniteNumber(progress.current);
	if (total !== null && total > 0) {
		panel.append(createMeter(
			(current ?? 0) / total,
			`${formatJobValue(current)} / ${formatJobValue(total)}`
				+ (progress.status ? ` · ${progress.status}` : ''),
		));
	}

	if (typeof data.alertText === 'string' && data.alertText.trim()) {
		panel.append(element('h4', { text: 'Generated report' }));
		panel.append(element('pre', { className: 'report-text', text: data.alertText }));
	}

	const symbolTable = symbolResultsTable(data.results);
	if (symbolTable) {
		panel.append(element('h4', { text: 'Symbol results' }));
		panel.append(symbolTable);
	}

	const scans = scanResultSections(data.scanResults);
	if (scans) panel.append(scans);

	const chips = deliveryChips(data.deliveryResults);
	if (chips.children.length) {
		panel.append(element('h4', { text: 'Delivery' }));
		panel.append(chips);
	}
	return panel;
};

const symbolAnalysisResult = (data) => {
	const panel = element('article', { className: 'operation-card verdict-panel symbol-analysis-result' });
	panel.append(element('p', { className: 'eyebrow', text: 'Symbol analysis' }));

	const analysis = asObject(data.analysis);
	const decision = asObject(analysis.decision);
	const actionStr = String(decision.action || '').trim();
	const badges = element('div', { className: 'badge-row' });

	if (actionStr) {
		const actionKey = actionStr.toLowerCase();
		const tone = DECISION_ACTION_TONES[actionKey] || 'status-unknown';
		badges.append(element('span', { className: `status-badge ${tone}`, text: actionStr.toUpperCase() }));
	}

	if (decision.dataSufficient === false) {
		badges.append(element('span', { className: 'status-badge status-misconfigured', text: 'Insufficient data' }));
	}

	if (data.analysisStatus) {
		badges.append(element('span', {
			className: `capability-chip ${data.analysisStatus === 'complete' ? 'delivery-ok' : 'status-unknown'}`,
			text: `Status: ${displayLabel(data.analysisStatus)}`,
		}));
	}
	if (badges.children.length) panel.append(badges);

	const identity = [data.symbol || analysis.symbol, data.timeframe || analysis.timeframe].filter(Boolean).join(' · ');
	if (identity) panel.append(element('p', { className: 'request-state', text: identity }));

	const confidence = asFiniteNumber(decision.confidence);
	if (confidence !== null) {
		const normConfidence = confidence > 1 ? confidence / 100 : confidence;
		panel.append(createMeter(normConfidence, `${Math.round(normConfidence * 100)}% confidence`));
	}

	const reasons = Array.isArray(decision.reasons) ? decision.reasons.filter(Boolean) : [];
	const warnings = Array.isArray(decision.warnings) ? decision.warnings.filter(Boolean) : [];
	if (reasons.length || warnings.length) {
		const block = element('div', { className: 'detail-block' });
		if (reasons.length) {
			block.append(element('h4', { text: 'Decision reasons' }));
			const ul = element('ul', { className: 'detail-list' });
			reasons.forEach((reason) => ul.append(element('li', { text: String(reason) })));
			block.append(ul);
		}
		if (warnings.length) {
			block.append(element('h4', { text: 'Warnings' }));
			const ul = element('ul', { className: 'detail-list' });
			warnings.forEach((warning) => ul.append(element('li', { text: String(warning) })));
			block.append(ul);
		}
		panel.append(block);
	}

	const risk = asObject(analysis.risk);
	const priceData = asObject(analysis.price_data);
	const entryPrice = risk.entry_price ?? priceData.current_price ?? priceData.close;
	if (entryPrice !== undefined && entryPrice !== null) {
		const riskBlock = element('div', { className: 'detail-block' });
		riskBlock.append(element('h4', { text: 'Price & Risk Levels' }));
		const grid = element('div', { className: 'levels-grid' });

		const entryCard = element('div', { className: 'metric-card' });
		entryCard.append(
			element('p', { className: 'metric-label', text: 'Entry Price' }),
			element('p', { className: 'levels-value', text: formatJobValue(entryPrice) }),
		);

		const slCard = element('div', { className: 'metric-card' });
		slCard.append(
			element('p', { className: 'metric-label', text: 'Stop Loss' }),
			element('p', { className: 'levels-value', text: formatJobValue(risk.stop_loss ?? risk.invalidation_level) }),
		);

		const targetCard = element('div', { className: 'metric-card' });
		targetCard.append(
			element('p', { className: 'metric-label', text: 'Target' }),
			element('p', { className: 'levels-value', text: formatJobValue(risk.target) }),
		);

		const rrCard = element('div', { className: 'metric-card' });
		rrCard.append(
			element('p', { className: 'metric-label', text: 'Risk / Reward' }),
			element('p', { className: 'levels-value', text: risk.risk_reward_ratio !== null && risk.risk_reward_ratio !== undefined ? `${risk.risk_reward_ratio}:1` : '—' }),
		);

		grid.append(entryCard, slCard, targetCard, rrCard);
		riskBlock.append(grid);
		panel.append(riskBlock);
	}

	const indicators = asObject(analysis.technical_indicators);
	const volume = asObject(analysis.volume_analysis);
	const indicatorEntries = [
		['RSI', indicators.RSI],
		['MACD', indicators.MACD],
		['BB Position', indicators.BB_position],
		['ATR', indicators.ATR],
		['ADX', indicators.ADX],
		['SMA20', indicators.SMA20],
		['Volume Ratio', volume.volume_ratio !== null && volume.volume_ratio !== undefined ? `${volume.volume_ratio}x` : null],
		['Volume Strength', volume.volume_strength],
	].filter(([, val]) => val !== null && val !== undefined);

	if (indicatorEntries.length) {
		const indBlock = element('div', { className: 'detail-block' });
		indBlock.append(element('h4', { text: 'Technical Indicators' }));
		const indChips = element('div', { className: 'chip-grid' });
		indicatorEntries.forEach(([label, val]) => {
			indChips.append(element('span', { className: 'capability-chip', text: `${label}: ${val}` }));
		});
		indBlock.append(indChips);
		panel.append(indBlock);
	}

	const mtf = asObject(analysis.multi_timeframe);
	if (Object.keys(mtf).length) {
		const mtfBlock = element('div', { className: 'detail-block' });
		mtfBlock.append(element('h4', { text: 'Multi-timeframe Analysis' }));
		const mtfChips = element('div', { className: 'chip-grid' });
		Object.entries(mtf).forEach(([tf, tfData]) => {
			const tfObj = asObject(tfData);
			const tfTrend = tfObj.trend || tfObj.direction || tfObj.status || (typeof tfData === 'string' ? tfData : null);
			if (tfTrend) {
				mtfChips.append(element('span', { className: 'capability-chip', text: `${tf}: ${displayLabel(tfTrend)}` }));
			}
		});
		if (mtfChips.children.length) {
			mtfBlock.append(mtfChips);
			panel.append(mtfBlock);
		}
	}

	const reportText = typeof data.alertText === 'string' && data.alertText.trim()
		? data.alertText
		: asObject(data.payload).alertText;
	if (typeof reportText === 'string' && reportText.trim()) {
		panel.append(element('h4', { text: 'Report preview' }));
		panel.append(element('pre', { className: 'report-text', text: reportText }));
	}

	return panel;
};

const volumeConfirmationResult = (data) => {
		const panel = element('article', { className: 'operation-card verdict-panel' });
		panel.append(element('p', { className: 'eyebrow', text: 'Volume confirmation' }));
		const badges = element('div', { className: 'badge-row' });
		badges.append(data.confirmed === true
			? element('span', { className: 'status-badge status-ready', text: 'Confirmed' })
			: data.confirmed === false
				? element('span', { className: 'status-badge status-danger', text: 'Not confirmed' })
				: element('span', { className: 'status-badge status-active', text: 'Unknown' }));
	if (data.decision) badges.append(element('span', { className: 'capability-chip', text: displayLabel(data.decision) }));
	panel.append(badges);

	const identity = [data.symbol, data.timeframe].filter(Boolean).join(' · ');
	if (identity) panel.append(element('p', { className: 'request-state', text: identity }));

	const ratio = asFiniteNumber(data.volumeRatio);
	if (ratio !== null) {
		panel.append(createMeter(ratio / 2, `${ratio}x average volume · confirm threshold 1.2x`));
	}
	const strength = asObject(asObject(data.analysis).volume_analysis).volume_strength;
	if (strength) {
		panel.append(element('p', { className: 'capability-chip', text: `Strength: ${displayLabel(strength)}` }));
	}
	return panel;
};

const newsMonitorResults = (data) => {
	const wrap = element('div', { className: 'dashboard news-results' });
	if (data.dryRun === true) {
		wrap.append(element('p', { className: 'empty-state', text: 'Dry run: no notifications were sent and nothing was cached.' }));
	}
	const counterChips = summaryCounterChips(data.summary, [
		['analyzed', 'Analyzed'], ['cached', 'Cached'],
		['alerts_sent', data.dryRun === true ? 'Alerts generated' : 'Alerts sent'],
		['timeout', 'Timeout'], ['error', 'Error'], ['quota_exhausted', 'Quota exhausted'],
	]);
	if (counterChips.children.length) wrap.append(counterChips);

	(Array.isArray(data.results) ? data.results : []).forEach((item) => {
		const detail = asObject(item);
		const card = element('article', { className: 'operation-card news-result' });
		const badges = element('div', { className: 'badge-row' });
		badges.append(element('strong', { text: formatJobValue(detail.symbol) }));
		if (detail.status) badges.append(createStatusBadge(detail.status, RESULT_STATUS_TONES));
		if (detail.cached === true) badges.append(element('span', { className: 'capability-chip', text: 'from cache' }));
		card.append(badges);

		const alert = asObject(detail.alert);
		if (alert.headline) card.append(element('p', { className: 'alert-preview', text: String(alert.headline) }));
		if (alert.eventCategory) {
			card.append(element('span', { className: 'capability-chip', text: displayLabel(alert.eventCategory) }));
		}
		const confidence = asFiniteNumber(alert.confidence);
		if (confidence !== null) {
			card.append(createMeter(confidence, `${Math.round(confidence * 100)}% confidence`));
		}
		if (Array.isArray(alert.sources) && alert.sources.length) {
			const block = element('div', { className: 'detail-block' });
			block.append(element('h4', { text: 'Sources' }));
			const ul = element('ul', { className: 'detail-list' });
			alert.sources.slice(0, 8).forEach((source) => ul.append(sourceLink(source)));
			block.append(ul);
			card.append(block);
		}
		wrap.append(card);
	});
	return wrap.children.length ? wrap : null;
};

const analysisReportResult = (data) => {
	const wrap = element('div', { className: 'dashboard analysis-report' });
	const reportText = typeof data.alertText === 'string' && data.alertText.trim()
		? data.alertText
		: asObject(data.payload).alertText;
	if (typeof reportText === 'string' && reportText.trim()) {
		wrap.append(element('h4', { text: 'Report preview' }));
		wrap.append(element('pre', { className: 'report-text', text: reportText }));
	}
	const symbolTable = symbolResultsTable(data.results);
	if (symbolTable) {
		const section = element('section', { className: 'dashboard-section' });
		section.append(element('h3', { text: 'Symbol results' }), symbolTable);
		wrap.append(section);
	}
	const scans = scanResultSections(data.scanResults);
	if (scans) wrap.append(scans);
	const counterChips = summaryCounterChips(data.summary, [
		['analyzed', 'Analyzed'], ['delivered', 'Delivered'], ['success', 'Successful scans'],
		['error', 'Failed scans'], ['timeout', 'Timed out scans'], ['totalItems', 'Items'],
	]);
	if (counterChips.children.length) wrap.append(counterChips);
	const chips = deliveryChips(data.deliveryResults);
	if (chips.children.length) wrap.append(chips);
	return wrap.children.length ? wrap : null;
};

const asFiniteNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

const sentimentBadge = (enrichment) => {
	const sentiment = enrichment && typeof enrichment === 'object' ? String(enrichment.sentiment || '') : '';
	if (!sentiment) return null;
	const score = asFiniteNumber(enrichment && enrichment.sentiment_score);
	return element('span', {
		className: `status-badge ${SENTIMENT_TONES[sentiment.toLowerCase()] || 'status-unknown'}`,
		text: `${displayLabel(sentiment)}${score !== null ? ` (${score})` : ''}`,
	});
};

const deliveryChips = (results) => {
	const wrap = element('div', { className: 'chip-grid delivery-chips' });
	(Array.isArray(results) ? results : []).forEach((result) => {
		const ok = !!(result && result.success);
		wrap.append(element('span', {
			className: `capability-chip ${ok ? 'delivery-ok' : 'delivery-fail'}`,
			text: `${ok ? '✓' : '✗'} ${result && result.channel ? displayLabel(result.channel) : 'Unknown channel'}`,
		}));
	});
	return wrap;
};

const sourceLink = (source) => {
	const url = typeof source === 'string' ? source : source && typeof source === 'object' && source.url;
	const title = typeof source === 'string'
		? url
		: (source && typeof source === 'object' && (source.title || source.url)) || null;
	if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
		return element('li', { text: title || url || 'Unknown source' });
	}
	const li = element('li');
	const anchor = element('a', { text: title || url });
	anchor.href = url;
	anchor.setAttribute('target', '_blank');
	anchor.setAttribute('rel', 'noopener noreferrer');
	li.append(anchor);
	return li;
};

const detailListBlock = (labelText, values) => {
	if (!Array.isArray(values) || !values.length) return null;
	const block = element('div', { className: 'detail-block' });
	block.append(element('h4', { text: labelText }));
	const ul = element('ul', { className: 'detail-list' });
	values.slice(0, 12).forEach((value) => {
		ul.append(typeof value === 'object' && value !== null ? sourceLink(value) : element('li', { text: String(value) }));
	});
	block.append(ul);
	return block;
};

const appendRiskRows = (dl, data) => [
	['Invalidation level', data.invalidation_level],
	['Target level', data.target_level],
	['Setup type', data.setup_type],
	['Risk / reward', data.risk_reward_ratio],
].forEach(([label, value]) => {
	if (value === undefined || value === null || value === '') return;
	dl.append(element('dt', { text: label }), element('dd', { text: String(value) }));
});

const createAlertDetailPanel = (alert) => {
	const panel = element('article', { className: 'operation-card alert-detail' });
	const headCopy = element('div');
	headCopy.append(element('p', { className: 'eyebrow', text: 'Alert detail' }));
	if (alert && alert.id) {
		const idLine = element('p', { className: 'mono-line', text: String(alert.id) });
		idLine.append(createCopyButton(String(alert.id), 'Copy ID'));
		headCopy.append(idLine);
	}
	const badges = element('div', { className: 'badge-row' });
	badges.append(alert && alert.enriched
		? element('span', { className: 'status-badge status-ready', text: 'Enriched' })
		: element('span', { className: 'status-badge status-disabled', text: 'Plain' }));
	const data = asObject(alert && alert.enrichmentData);
	const sentimentNode = sentimentBadge(data);
	if (sentimentNode) badges.append(sentimentNode);
	const head = element('div', { className: 'section-heading' });
	head.append(headCopy, badges);
	panel.append(head);

	if (alert && alert.receivedAt) {
		panel.append(createTimestamp(alert.receivedAt));
	}
	if (alert && typeof alert.text === 'string') {
		panel.append(element('h4', { text: 'Alert text' }));
		panel.append(element('pre', { className: 'report-text', text: alert.text }));
	}

	const levelsBlock = (() => {
		const levels = asObject(data.technical_levels);
		const supports = Array.isArray(levels.supports) ? levels.supports : [];
		const resistances = Array.isArray(levels.resistances) ? levels.resistances : [];
		if (!supports.length && !resistances.length) return null;
		const block = element('div', { className: 'detail-block' });
		block.append(element('h4', { text: 'Technical levels' }));
		const grid = element('div', { className: 'levels-grid' });
		[['Supports', supports], ['Resistances', resistances]].forEach(([label, values]) => {
			const column = element('div');
			column.append(element('p', { className: 'metric-label', text: label }));
			column.append(element('p', {
				className: 'levels-value',
				text: values.slice(0, 8).map((value) => String(value)).join(' · ') || '—',
			}));
			grid.append(column);
		});
		block.append(grid);
		return block;
	})();
	if (levelsBlock) panel.append(levelsBlock);

	const insightsBlock = detailListBlock('Key insights', Array.isArray(data.insights) ? data.insights : []);
	if (insightsBlock) panel.append(insightsBlock);

	const sources = Array.isArray(data.sources) ? data.sources : [];
	if (sources.length) {
		const block = element('div', { className: 'detail-block' });
		block.append(element('h4', { text: 'Sources' }));
		const ul = element('ul', { className: 'detail-list' });
		sources.slice(0, 10).forEach((source) => ul.append(sourceLink(source)));
		block.append(ul);
		panel.append(block);
	}

	const hasRisk = ['invalidation_level', 'target_level', 'setup_type', 'risk_reward_ratio']
		.some((key) => data[key] !== undefined && data[key] !== null && data[key] !== '');
	if (hasRisk) {
		const block = element('div', { className: 'detail-block' });
		block.append(element('h4', { text: 'Risk parameters' }));
		const dl = element('dl', { className: 'risk-list' });
		appendRiskRows(dl, data);
		block.append(dl);
		panel.append(block);
	}

	const provenance = asObject(data.promptProvenance || data.prompt_provenance);
	if (provenance.name) {
		panel.append(element('p', {
			className: 'request-state',
			text: `Prompt: ${provenance.name} (${provenance.source || 'unknown source'}`
				+ `${provenance.version != null ? ` v${provenance.version}` : ''})`,
		}));
	}
	const tokens = asObject(alert && alert.tokenUsage);
	if (tokens.totalTokens !== undefined) {
		panel.append(element('p', {
			className: 'request-state',
			text: `Token usage: ${tokens.inputTokens ?? '?'} in · ${tokens.outputTokens ?? '?'} out · ${tokens.totalTokens} total`,
		}));
	}
	if (data.truncated === true) {
		panel.append(element('p', { className: 'request-state', text: 'Enrichment content was truncated.' }));
	}
	return panel;
};

const createAlertCard = (alert) => {
	const card = element('article', { className: 'operation-card alert-card' });
	const headCopy = element('div');
	headCopy.append(element('p', {
		className: 'eyebrow',
		text: alert && alert.source ? `Source: ${alert.source}` : 'Stored alert',
	}));
	if (alert && alert.id) {
		const idLine = element('p', { className: 'mono-line', text: String(alert.id) });
		idLine.append(createCopyButton(String(alert.id), 'Copy ID'));
		headCopy.append(idLine);
	}
	const badges = element('div', { className: 'badge-row' });
	if (alert && alert.receivedAt) badges.append(createTimestamp(alert.receivedAt));
	badges.append(alert && alert.enriched
		? element('span', { className: 'status-badge status-ready', text: 'Enriched' })
		: element('span', { className: 'status-badge status-disabled', text: 'Plain' }));
	const sentimentNode = sentimentBadge(asObject(alert && alert.enrichmentData));
	if (sentimentNode) badges.append(sentimentNode);
	const head = element('div', { className: 'section-heading' });
	head.append(headCopy, badges);
	card.append(head);

	const text = alert && typeof alert.text === 'string' ? alert.text : '';
	card.append(element('p', {
		className: 'alert-preview',
		text: text.length > 200 ? `${text.slice(0, 200)}…` : text,
	}));

	const chips = deliveryChips(alert && alert.deliveryResults);
	if (chips.children.length) card.append(chips);

	const detailsToggle = element('button', { text: 'Show detail' });
	detailsToggle.type = 'button';
	const detailHost = element('div');
	let builtDetail = false;
	detailsToggle.addEventListener('click', () => {
		const expanded = detailHost.hidden;
		if (expanded && !builtDetail) {
			detailHost.replaceChildren(createAlertDetailPanel(alert));
			builtDetail = true;
		}
		detailHost.hidden = !expanded;
		detailsToggle.textContent = expanded ? 'Hide detail' : 'Show detail';
	});
	detailHost.hidden = true;
	card.append(detailsToggle, detailHost);
	return card;
};

const createMetricCard = (label, value, meta) => {
	const card = element('article', { className: 'metric-card' });
	card.append(
		element('p', { className: 'metric-label', text: label }),
		element('strong', { className: 'metric-value', text: String(value) }),
		element('p', { className: 'metric-meta', text: meta || '' }),
	);
	return card;
};

const renderStatusCards = (container, entries, emptyText, { detailed = false } = {}) => {
	container.replaceChildren();
	if (!entries.length) {
		container.append(createEmptyState(emptyText));
		return;
	}
	entries.forEach(([name, detail]) => {
		if (detailed) {
			const status = effectiveStatus(detail);
			const card = element('details', { className: 'status-card status-detail-card' });
			const summary = element('summary', { className: 'status-detail-summary' });
			const copy = element('div');
			copy.append(
				element('strong', { text: displayLabel(name) }),
				element('small', { text: detail.provider ? `Provider: ${detail.provider}` : displayStatus(status) }),
			);
			summary.append(copy, createStatusBadge(status));
			const list = element('dl', { className: 'status-detail-list' });
			statusDetailFields.forEach(([key, label, timestamp]) => {
				const fieldValue = statusFieldValue(detail, key);
				if (fieldValue === undefined || fieldValue === null || fieldValue === '') return;
				const value = element('dd');
				value.append(timestamp ? createTimestamp(fieldValue) : element('span', { text: Array.isArray(fieldValue) ? fieldValue.join(', ') : String(fieldValue) }));
				list.append(element('dt', { text: label }), value);
			});
			nestedStatusEntries(detail).forEach(([name, nested]) => {
				const value = element('dd');
				value.append(createStatusBadge(nested.status));
				list.append(
					element('dt', { text: displayLabel(name) }),
					value,
				);
			});
			card.append(summary, list);
			container.append(card);
			return;
		}
		const card = element('article', { className: 'status-card' });
		const status = effectiveStatus(detail);
		const copy = element('div');
		copy.append(
			element('strong', { text: displayLabel(name) }),
			element('small', { text: detail.provider ? `Provider: ${detail.provider}` : displayStatus(status) }),
		);
		const badge = element('span', {
			className: `status-badge status-${statusTone(status)}`,
			text: displayStatus(status),
		});
		card.append(copy, badge);
		container.append(card);
	});
};

const renderStatusDependencies = (container, entries, filter = 'all', search = '') => {
	const query = String(search).trim().toLowerCase();
	const filtered = entries
		.filter(([name, detail]) => {
			const toneMatches = filter === 'all'
				|| (filter === 'attention' && statusNeedsAttention(detail))
				|| (filter === 'ready' && effectiveStatus(detail) === 'ready')
				|| (filter === 'disabled' && detail.status === 'disabled')
				|| (filter === 'unknown' && statusDetails(detail).some((statusDetail) => statusDetail.status === 'unknown'));
			const searchableStatuses = statusDetails(detail)
				.flatMap((statusDetail) => [statusDetail.status, displayStatus(statusDetail.status)])
				.join(' ');
			const searchable = `${displayLabel(name)} ${detail.provider || ''} ${searchableStatuses}`.toLowerCase();
			return toneMatches && (!query || searchable.includes(query));
		})
		.sort(([leftName, left], [rightName, right]) => {
			const priority = (detail) => statusNeedsAttention(detail) ? 0 : !hasStatus(detail) ? 1 : detail.status === 'ready' ? 2 : 1;
			return priority(left) - priority(right) || displayLabel(leftName).localeCompare(displayLabel(rightName));
		});
	renderStatusCards(container, filtered, 'No dependencies match these filters.', { detailed: true });
};

const renderStatusDashboard = ({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked }, status, { renderDependencies } = {}) => {
	const service = asObject(status.service);
	const features = Object.entries(asObject(status.featureFlags)).filter(([, enabled]) => enabled === true);
	const channels = statusEntries(status.deliveryChannels);
	const dependencies = statusEntries(status.dependencies);
	const dependencyCounts = statusCounts(dependencies);
	const attentionCount = dependencies.filter(([, detail]) => statusNeedsAttention(detail)).length;

	metrics.replaceChildren(
		createMetricCard('Service', service.name || 'Unknown service', service.version ? `Version ${service.version}` : 'Version unavailable'),
		createMetricCard('Environment', service.environment || 'Unknown', service.commit ? `Commit ${String(service.commit).slice(0, 8)}` : 'Commit unavailable'),
		createMetricCard('Features', `${features.length} enabled`, `${Object.keys(asObject(status.featureFlags)).length} configured flags`),
		createMetricCard('Dependencies', `${dependencyCounts.ready || 0} ready`, `${attentionCount} need attention · ${dependencyCounts.disabled || 0} disabled`),
	);
	lastChecked.textContent = `Last checked ${new Date().toLocaleTimeString()}`;

	renderStatusCards(channelGrid, channels, 'No delivery channels reported.');
	if (typeof renderDependencies === 'function') renderDependencies(dependencies);
	else renderStatusCards(dependencyGrid, dependencies, 'No dependencies reported.');
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

const renderStatusUnavailable = ({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked }) => {
	metrics.replaceChildren(element('p', { className: 'request-state', text: 'Status unavailable. Check the API key and service logs.' }));
	lastChecked.textContent = 'Status unavailable.';
	renderStatusCards(channelGrid, [], 'Status unavailable.');
	renderStatusCards(dependencyGrid, [], 'Status unavailable.');
	featureGrid.replaceChildren(createEmptyState('Status unavailable.'));
};

const createStatusExplorer = () => {
	const dashboard = element('div', { className: 'dashboard' });
	const hero = element('section', { className: 'dashboard-hero' });
	const heroCopy = element('div');
	const lastChecked = element('p', { className: 'request-state', text: 'Waiting for live status…' });
	heroCopy.append(
		element('p', { className: 'eyebrow', text: 'Runtime status' }),
		element('h2', { text: 'Status' }),
		element('p', { text: 'Inspect dependency readiness, delivery channels and worker health.' }),
		lastChecked,
	);
	const refreshButton = element('button', { className: 'button-primary', text: 'Refresh status' });
	refreshButton.type = 'button';
	hero.append(heroCopy, refreshButton);

	const metrics = element('div', { className: 'metric-grid' });
	metrics.append(element('p', { className: 'request-state', text: 'Loading live status…' }));
	const channelGrid = element('div', { className: 'status-grid' });
	const dependencyGrid = element('div', { className: 'status-grid' });
	const featureGrid = element('div', { className: 'chip-grid' });
	const searchLabel = element('label', { text: 'Search dependencies' });
	const search = element('input');
	search.name = 'dependency-search';
	search.type = 'search';
	search.placeholder = 'Name, provider or status';
	searchLabel.append(search);
	const toneLabel = element('label', { text: 'Filter by status' });
	const tone = element('select');
	tone.name = 'dependency-tone';
	[
		['all', 'All statuses'],
		['attention', 'Needs attention'],
		['ready', 'Ready'],
		['disabled', 'Disabled'],
		['unknown', 'Unknown'],
	].forEach(([value, text]) => {
		const option = element('option', { text });
		option.value = value;
		tone.append(option);
	});
	toneLabel.append(tone);
	const filters = element('div', { className: 'status-filter-bar' });
	filters.append(searchLabel, toneLabel);

	const statusOutput = element('pre', { className: 'response-block', text: 'No status response yet.' });
	let lastRawStatus = '';
	const rawCopyButton = createCopyButton(() => lastRawStatus, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawStatus = element('details', { className: 'raw-status' });
	rawStatus.append(
		element('summary', { text: 'Show raw status response' }),
		rawCopyButton,
		statusOutput,
	);

	const section = (title, content) => {
		const node = element('section', { className: 'dashboard-section' });
		node.append(element('h3', { text: title }), content);
		return node;
	};
	dashboard.append(
		hero,
		metrics,
		section('Delivery channels', channelGrid),
		section('Dependency filters', filters),
		section('Dependency health', dependencyGrid),
		section('Enabled capabilities', featureGrid),
		rawStatus,
	);

	let dependencies = [];
	const renderDependencies = () => renderStatusDependencies(dependencyGrid, dependencies, tone.value, search.value);
	search.addEventListener('input', renderDependencies);
	tone.addEventListener('change', renderDependencies);
	const loadStatus = async () => {
		lastRawStatus = '';
		rawCopyButton.hidden = true;
		const status = await sendRequest({
			definition: STATUS_DEFINITION,
			path: STATUS_DEFINITION.path,
			button: refreshButton,
			output: statusOutput,
		});
		if (status && typeof status === 'object') {
			lastRawStatus = window.CabrosAdminRequest.redactSecret(
				JSON.stringify(status, null, 2),
				getElement('api-key')?.value || '',
			);
			rawCopyButton.hidden = false;
			dependencies = statusEntries(status.dependencies);
			renderStatusDashboard({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked }, status, { renderDependencies });
		} else {
			dependencies = [];
			renderStatusUnavailable({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked });
		}
	};
	refreshButton.addEventListener('click', () => { loadStatus(); });
	if (getElement('api-key')?.value || (authState.enabled && authState.user)) loadStatus();
	else metrics.replaceChildren(element('p', { className: 'request-state', text: 'Enter an API key to load live status.' }));
	return dashboard;
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
	let lastRawStatus = '';
	const rawCopyButton = createCopyButton(() => lastRawStatus, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawStatus = element('details', { className: 'raw-status' });
	rawStatus.append(
		element('summary', { text: 'Show raw status response' }),
		rawCopyButton,
		statusOutput,
	);

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
		lastRawStatus = '';
		rawCopyButton.hidden = true;
		const status = await sendRequest({
			definition: STATUS_DEFINITION,
			path: STATUS_DEFINITION.path,
			button: refreshButton,
			output: statusOutput,
		});
		if (status && typeof status === 'object') {
			lastRawStatus = window.CabrosAdminRequest.redactSecret(
				JSON.stringify(status, null, 2),
				getElement('api-key')?.value || '',
			);
			rawCopyButton.hidden = false;
			renderStatusDashboard({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked }, status);
		} else {
			renderStatusUnavailable({ metrics, channelGrid, dependencyGrid, featureGrid, lastChecked });
		}
	};
	refreshButton.addEventListener('click', () => { loadStatus(); });
	if (getElement('api-key')?.value || (authState.enabled && authState.user)) {
		loadStatus();
	} else {
		metrics.replaceChildren(element('p', { className: 'request-state', text: 'Enter an API key to load live status.' }));
	}
	return dashboard;
};

const sendRequest = async ({
	definition, path, query, body, headers, button, output, formatResponse, parseSuccessResponse, isCurrent, captureResponseStatus,
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
	const baseSummary = window.CabrosAdminRequest.redactSecret(`${definition.method} ${path}`, apiKey);
	const idempotencyKey = headers && (headers['idempotency-key'] || headers['x-idempotency-key']);
	const summary = idempotencyKey ? `${baseSummary} · Idempotency: ${idempotencyKey}` : baseSummary;
	let request;
	try {
		request = window.CabrosAdminRequest.createRequest({
			path,
			method: definition.method,
			query,
			body,
			headers,
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
	output.className = 'response-block';
	output.replaceChildren(
		element('span', { className: 'response-summary', text: summary }),
		createLoadingState('Request in progress…'),
	);
	const started = performance.now();
	try {
		const result = await fetchWithTimeout(request.url, request.options, getApiRequestTimeout(definition), async (response) => {
			if (typeof captureResponseStatus === 'function') captureResponseStatus(response.status);
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
	const prev = element('button', { text: 'Previous page' });
	prev.type = 'button';
	prev.disabled = true;
	const next = element('button', { text: 'Next page' });
	next.type = 'button';
	next.disabled = true;
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	const alertList = element('div', { className: 'form-fields alert-list' });
	let lastRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.append(
		element('summary', { text: 'Show raw response' }),
		rawCopyButton,
		rawOutput,
	);
	form.append(button, prev, next, output, alertList, rawToggle);

	let nextBefore;
	let backCursors = [];
	let pageGeneration = 0;
	const requestPage = async (cursor) => {
		const generation = ++pageGeneration;
		prev.disabled = true;
		next.disabled = true;
		before.value = cursor || '';
		const query = Object.fromEntries(Object.entries({
			limit: limit.value,
			before: before.value,
			source: source.value,
			enriched: enriched.value,
		}).filter(([, value]) => value !== ''));
		const data = await sendRequest({
			definition,
			path: definition.path,
			query,
			button,
			output,
			isCurrent: () => generation === pageGeneration,
			formatResponse: ({ summary, status, elapsed, data: payload }) => `${summary}\nHTTP ${status} · ${elapsed} ms · `
				+ `${payload && Array.isArray(payload.alerts) ? `${payload.alerts.length} alerts on this page` : 'no alert list returned'}`,
		});
		if (generation !== pageGeneration) return false;
		if (data && Array.isArray(data.alerts)) {
			lastRawJson = JSON.stringify(data, null, 2);
			rawOutput.textContent = lastRawJson;
			rawCopyButton.hidden = false;
			alertList.replaceChildren();
			if (!data.alerts.length) {
				alertList.append(createEmptyState('No stored alerts match these filters.'));
			} else {
				data.alerts.forEach((alert) => alertList.append(createAlertCard(alert)));
			}
		} else {
			lastRawJson = '';
			rawOutput.textContent = '';
			rawCopyButton.hidden = true;
			alertList.replaceChildren();
		}
		const pagination = (data && data.pagination) || {};
		nextBefore = pagination.hasMore === true && pagination.nextBefore
			? pagination.nextBefore
			: undefined;
		next.disabled = !nextBefore;
		prev.disabled = !backCursors.length;
		return Boolean(data && Array.isArray(data.alerts));
	};
	const syncPagingButtons = () => {
		next.disabled = !nextBefore;
		prev.disabled = !backCursors.length;
	};
	const resetPagination = ({ clearCursor }) => {
		pageGeneration += 1;
		nextBefore = undefined;
		backCursors = [];
		next.disabled = true;
		prev.disabled = true;
		button.disabled = false;
		alertList.replaceChildren();
		lastRawJson = '';
		rawOutput.textContent = '';
		rawCopyButton.hidden = true;
		output.textContent = 'Filters changed — load alerts to refresh.';
		if (clearCursor) before.value = '';
	};
	[limit, source, enriched].forEach((field) => {
		field.addEventListener('input', () => resetPagination({ clearCursor: true }));
		field.addEventListener('change', () => resetPagination({ clearCursor: true }));
	});
	before.addEventListener('input', () => resetPagination({ clearCursor: false }));
	before.addEventListener('change', () => resetPagination({ clearCursor: false }));
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		backCursors = [];
		return requestPage(before.value);
	});
	next.addEventListener('click', () => {
		if (!nextBefore) return;
		const entry = before.value || '';
		Promise.resolve(requestPage(nextBefore)).then((succeeded) => {
			if (!succeeded) return;
			backCursors.push(entry);
			syncPagingButtons();
		});
	});
	prev.addEventListener('click', () => {
		if (!backCursors.length) return;
		const target = backCursors[backCursors.length - 1];
		Promise.resolve(requestPage(target)).then((succeeded) => {
			if (!succeeded) return;
			backCursors.pop();
			syncPagingButtons();
		});
	});
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

const renderAlertSummaryBlocks = (data) => {
	const wrap = element('div', { className: 'dashboard summary-blocks' });
	const summary = asObject(data && data.summary);
	const windowInfo = asObject(summary.window);
	const delivery = asObject(summary.delivery);
	const enrichment = asObject(summary.enrichment);
	const tokenTotals = asObject(enrichment.tokenUsage);
	const coverage = asObject(enrichment.riskMetadataCoverage);

	wrap.replaceChildren(element('div', { className: 'metric-grid' }));
	wrap.children[0].append(
		createMetricCard(
			'Total alerts',
			formatJobValue(summary.totalAlerts),
			windowInfo.from ? `${String(windowInfo.from).slice(0, 10)} → ${String(windowInfo.to).slice(0, 10)}` : 'Window unavailable',
		),
		createMetricCard(
			'Delivery',
			`${formatJobValue(delivery.totalSuccess)} ok`,
			`${formatJobValue(delivery.totalFailure)} failed`,
		),
		createMetricCard(
			'Tokens',
			formatJobValue(tokenTotals.totalTokens),
			tokenTotals.totalCost !== undefined ? `Estimated cost ${tokenTotals.totalCost}` : 'LLM usage in window',
		),
		createMetricCard(
			'Enriched alerts',
			formatJobValue(enrichment.enrichedAlerts),
			`${formatJobValue(enrichment.plainAlerts)} plain · denominator ${formatJobValue(coverage.denominator)}`,
		),
	);

	const channels = Object.entries(asObject(delivery.byChannel));
	if (channels.length) {
		const section = element('section', { className: 'dashboard-section' });
		section.append(element('h3', { text: 'Delivery by channel' }));
		const table = element('table', { className: 'data-table' });
		const head = element('tr');
		['Channel', 'Total', 'Success', 'Failure'].forEach((label) => head.append(element('th', { text: label })));
		table.append(head);
		channels.forEach(([channel, stats]) => {
			const detail = asObject(stats);
			const row = element('tr');
			row.append(
				element('td', { text: displayLabel(channel) }),
				element('td', { text: formatJobValue(detail.total) }),
				element('td', { text: formatJobValue(detail.success) }),
				element('td', { text: formatJobValue(detail.failure) }),
			);
			table.append(row);
		});
		section.append(table);
		wrap.append(section);
	}

	const fields = Object.entries(asObject(coverage.fields));
	if (fields.length) {
		const section = element('section', { className: 'dashboard-section' });
		section.append(element('h3', { text: 'Risk metadata coverage' }));
		const table = element('table', { className: 'data-table' });
		const head = element('tr');
		['Field', 'Populated', 'Coverage'].forEach((label) => head.append(element('th', { text: label })));
		table.append(head);
		fields.forEach(([field, info]) => {
			const detail = asObject(info);
			const row = element('tr');
			row.append(
				element('td', { text: displayLabel(field) }),
				element('td', { text: `${formatJobValue(detail.populated)} / ${formatJobValue(coverage.denominator)}` }),
				element('td', { text: `${formatJobValue(detail.percentage)}%` }),
			);
			table.append(row);
		});
		section.append(table);
		wrap.append(section);
	}
	return wrap;
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
	const blocks = element('div', { className: 'summary-host' });
	let lastRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.append(
		element('summary', { text: 'Show raw analytics response' }),
		rawCopyButton,
		rawOutput,
	);
	form.append(button, output, blocks, rawToggle);
	let summaryGeneration = 0;
	const invalidateSummary = () => {
		summaryGeneration += 1;
		button.disabled = false;
		blocks.replaceChildren();
		lastRawJson = '';
		rawOutput.textContent = '';
		rawCopyButton.hidden = true;
		output.textContent = 'Filters changed — load alert analytics to refresh.';
	};
	Object.values(fields).forEach((field) => {
		if (!field) return;
		field.addEventListener('input', invalidateSummary);
		field.addEventListener('change', invalidateSummary);
	});
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const generation = ++summaryGeneration;
		try {
			sendRequest({
				definition,
				path: definition.path,
				query: getAlertReportQuery(fields),
				button,
				output,
				isCurrent: () => generation === summaryGeneration,
				formatResponse: ({ summary, status, elapsed, data }) => {
					if (!data || !data.summary) return `${summary}\nHTTP ${status} · ${elapsed} ms\n\nNo summary data returned.`;
					lastRawJson = JSON.stringify(data, null, 2);
					return `${summary}\nHTTP ${status} · ${elapsed} ms`;
				},
			}).then((data) => {
				if (generation !== summaryGeneration) return;
				if (!data || !data.summary) {
					blocks.replaceChildren();
					lastRawJson = '';
					rawOutput.textContent = '';
					rawCopyButton.hidden = true;
					return;
				}
				blocks.replaceChildren(renderAlertSummaryBlocks(data));
				rawOutput.textContent = lastRawJson;
				rawCopyButton.hidden = false;
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

const createOutcomeDetailPanel = (outcome) => {
	const panel = element('article', { className: 'operation-card outcome-detail' });
	const headCopy = element('div');
	headCopy.append(element('p', { className: 'eyebrow', text: 'Outcome detail' }));
	if (outcome && outcome.id) {
		const idLine = element('p', { className: 'mono-line', text: String(outcome.id) });
		idLine.append(createCopyButton(String(outcome.id), 'Copy ID'));
		headCopy.append(idLine);
	}
	const badges = element('div', { className: 'badge-row' });
	badges.append(outcome && outcome.outcomeEvaluated
		? element('span', { className: 'status-badge status-ready', text: 'Evaluated' })
		: element('span', { className: 'status-badge status-disabled', text: 'Pending' }));
	if (outcome && outcome.side) {
		badges.append(element('span', {
			className: `status-badge ${outcome.side === 'SELL' ? 'status-disabled' : 'status-ready'}`,
			text: outcome.side,
		}));
	}
	const head = element('div', { className: 'section-heading' });
	head.append(headCopy, badges);
	panel.append(head);

	if (outcome && outcome.receivedAt) {
		panel.append(createTimestamp(outcome.receivedAt));
	}

	const dl = element('dl', { className: 'risk-list' });
	const detailFields = [
		['Request ID', outcome && outcome.requestId],
		['Source', outcome && outcome.source],
		['Symbol', outcome && outcome.symbol],
		['Exchange', outcome && outcome.exchange],
		['Asset class', outcome && outcome.assetClass],
		['Timeframe', outcome && outcome.timeframe],
		['Setup type', outcome && outcome.setupType],
		['Score', outcome && typeof outcome.score === 'number' ? outcome.score : null],
		['Entry price', outcome && typeof outcome.price === 'number' ? outcome.price : null],
		['Stop loss', outcome && typeof outcome.stop === 'number' ? outcome.stop : null],
		['Target price', outcome && typeof outcome.target === 'number' ? outcome.target : null],
		['Market data provider', outcome && outcome.marketDataProvider],
		['Entry price source', outcome && outcome.entryPriceSource],
		['Eligibility state', outcome && outcome.eligibilityState],
		['Eligibility reason', outcome && outcome.eligibilityReason],
		['Processing time', outcome && typeof outcome.processingTimeMs === 'number' ? `${outcome.processingTimeMs} ms` : null],
	];
	detailFields.forEach(([label, val]) => {
		if (val !== undefined && val !== null && val !== '') {
			const dt = element('dt', { text: label });
			const dd = element('dd', { text: String(val) });
			dl.append(dt, dd);
		}
	});
	panel.append(dl);

	const sources = Array.isArray(outcome && outcome.sources) ? outcome.sources : [];
	if (sources.length) {
		const block = element('div', { className: 'detail-block' });
		block.append(element('h4', { text: 'Sources' }));
		const ul = element('ul', { className: 'detail-list' });
		sources.slice(0, 10).forEach((source) => ul.append(sourceLink(source)));
		block.append(ul);
		panel.append(block);
	}

	const tokens = asObject(outcome && outcome.tokenUsage);
	if (tokens.totalTokens !== undefined || tokens.totalCost !== undefined) {
		panel.append(element('p', {
			className: 'request-state',
			text: `Token usage: ${tokens.inputTokens ?? '?'} in · ${tokens.outputTokens ?? '?'} out · ${tokens.totalTokens ?? '?'} total`
				+ (tokens.totalCost !== undefined ? ` · Cost: $${tokens.totalCost}` : ''),
		}));
	}

	return panel;
};

const createOutcomeCard = (outcome) => {
	const card = element('article', { className: 'operation-card outcome-card' });
	const headCopy = element('div');
	const symbolExchange = `${outcome && outcome.symbol ? outcome.symbol : 'UNKNOWN'}${outcome && outcome.exchange ? ` · ${outcome.exchange}` : ''}`;
	headCopy.append(element('p', {
		className: 'eyebrow',
		text: outcome && outcome.source ? `Source: ${outcome.source}` : 'Signal outcome',
	}));
	headCopy.append(element('h4', {
		className: 'outcome-title',
		text: symbolExchange,
	}));
	if (outcome && outcome.id) {
		const idLine = element('p', { className: 'mono-line', text: String(outcome.id) });
		idLine.append(createCopyButton(String(outcome.id), 'Copy ID'));
		headCopy.append(idLine);
	}
	const badges = element('div', { className: 'badge-row' });
	if (outcome && outcome.receivedAt) badges.append(createTimestamp(outcome.receivedAt));
	if (outcome && outcome.side) {
		badges.append(element('span', {
			className: `status-badge ${outcome.side === 'SELL' ? 'status-disabled' : 'status-ready'}`,
			text: outcome.side,
		}));
	}
	badges.append(outcome && outcome.outcomeEvaluated
		? element('span', { className: 'status-badge status-ready', text: 'Evaluated' })
		: element('span', { className: 'status-badge status-disabled', text: 'Pending' }));
	if (outcome && outcome.setupType) {
		badges.append(element('span', { className: 'status-badge', text: outcome.setupType }));
	}
	if (outcome && outcome.timeframe) {
		badges.append(element('span', { className: 'status-badge', text: outcome.timeframe }));
	}
	if (outcome && typeof outcome.score === 'number') {
		badges.append(element('span', { className: 'status-badge', text: `Score: ${outcome.score}` }));
	}

	const head = element('div', { className: 'section-heading' });
	head.append(headCopy, badges);
	card.append(head);

	const levels = element('div', { className: 'levels-grid' });
	const levelItems = [
		['Entry Price', outcome && typeof outcome.price === 'number' ? outcome.price : '—'],
		['Stop Loss', outcome && typeof outcome.stop === 'number' ? outcome.stop : '—'],
		['Target Price', outcome && typeof outcome.target === 'number' ? outcome.target : '—'],
		['Price Source', outcome && outcome.entryPriceSource ? outcome.entryPriceSource : '—'],
	];
	levelItems.forEach(([label, val]) => {
		const col = element('div');
		col.append(element('p', { className: 'metric-label', text: label }));
		col.append(element('p', { className: 'levels-value', text: String(val) }));
		levels.append(col);
	});
	card.append(levels);

	if (outcome && outcome.eligibilityReason) {
		card.append(element('p', {
			className: 'request-state',
			text: `Eligibility: ${outcome.eligibilityReason}`,
		}));
	}

	const outcomesMap = asObject(outcome && outcome.outcomes);
	const windowKeys = ['1h', '4h', '1D', '1W'];
	const windowsGrid = element('div', { className: 'outcome-windows-grid' });
	windowKeys.forEach((winKey) => {
		const win = outcomesMap[winKey] || outcomesMap[winKey.toLowerCase()] || null;
		const winCard = element('div', { className: 'outcome-window-card' });
		const winHead = element('div', { className: 'outcome-window-header' });
		winHead.append(element('strong', { text: winKey }));
		if (!win) {
			winHead.append(element('span', { className: 'status-badge status-disabled', text: 'No data' }));
			winCard.append(winHead);
		} else if (win.status === 'pending') {
			winHead.append(element('span', { className: 'status-badge status-disabled', text: 'Pending' }));
			winCard.append(winHead);
		} else if (win.status === 'unavailable') {
			winHead.append(element('span', { className: 'status-badge status-misconfigured', text: 'Unavailable' }));
			winCard.append(winHead);
			if (win.reason) {
				winCard.append(element('span', { className: 'timestamp', text: String(win.reason) }));
			}
		} else if (win.status === 'evaluated') {
			winHead.append(element('span', { className: 'status-badge status-ready', text: 'Evaluated' }));
			winCard.append(winHead);

			if (typeof win.return === 'number') {
				const retClass = win.return >= 0 ? 'outcome-return-pos' : 'outcome-return-neg';
				const retText = `${win.return > 0 ? '+' : ''}${win.return.toFixed(2)}%`;
				const retRow = element('div', { className: 'outcome-stat-row' });
				retRow.append(element('span', { text: 'Return' }), element('span', { className: retClass, text: retText }));
				winCard.append(retRow);
			}

			if (typeof win.rMultiple === 'number') {
				const rClass = win.rMultiple >= 0 ? 'outcome-return-pos' : 'outcome-return-neg';
				const rText = `${win.rMultiple > 0 ? '+' : ''}${win.rMultiple.toFixed(2)}R`;
				const rRow = element('div', { className: 'outcome-stat-row' });
				rRow.append(element('span', { text: 'R-Multiple' }), element('span', { className: rClass, text: rText }));
				winCard.append(rRow);
			}

			if (typeof win.maxFavorableExcursion === 'number' || typeof win.maxAdverseExcursion === 'number') {
				const mfeMaeRow = element('div', { className: 'outcome-stat-row' });
				mfeMaeRow.append(
					element('span', { text: 'MFE / MAE' }),
					element('span', { text: `+${(win.maxFavorableExcursion ?? 0).toFixed(2)}% / ${(win.maxAdverseExcursion ?? 0).toFixed(2)}%` }),
				);
				winCard.append(mfeMaeRow);
			}

			if (win.firstHit || win.targetHit || win.stopHit) {
				const hitRow = element('div', { className: 'outcome-stat-row' });
				const hitSummary = win.firstHit ? `First: ${win.firstHit}` : (win.targetHit ? 'Target hit' : (win.stopHit ? 'Stop hit' : 'None'));
				hitRow.append(element('span', { text: 'Barriers' }), element('span', { text: hitSummary }));
				winCard.append(hitRow);
			}

			if (typeof win.price === 'number') {
				const exitRow = element('div', { className: 'outcome-stat-row' });
				exitRow.append(element('span', { text: 'Exit price' }), element('span', { text: String(win.price) }));
				winCard.append(exitRow);
			}
		}
		windowsGrid.append(winCard);
	});
	card.append(windowsGrid);

	const detailsToggle = element('button', { text: 'Show detail' });
	detailsToggle.type = 'button';
	const detailHost = element('div');
	let builtDetail = false;
	detailsToggle.addEventListener('click', () => {
		const expanded = detailHost.hidden;
		if (expanded && !builtDetail) {
			detailHost.replaceChildren(createOutcomeDetailPanel(outcome));
			builtDetail = true;
		}
		detailHost.hidden = !expanded;
		detailsToggle.textContent = expanded ? 'Hide detail' : 'Show detail';
	});
	detailHost.hidden = true;
	card.append(detailsToggle, detailHost);

	return card;
};

const createOutcomesListForm = () => {
	const definition = { method: 'GET', path: '/api/outcomes', label: 'Load outcomes' };
	const form = element('form', { className: 'operation-card' });
	form.append(
		element('h3', { text: definition.label }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);
	const symbol = addField(form, 'Symbol', 'symbol', { placeholder: 'BTCUSDT or BINANCE:BTCUSDT' });
	const exchange = addField(form, 'Exchange', 'exchange', { placeholder: 'BINANCE' });
	const status = addField(form, 'Status', 'status', { tag: 'select' });
	[
		['', 'All statuses'],
		['pending', 'Pending'],
		['evaluated', 'Evaluated'],
		['unavailable', 'Unavailable'],
	].forEach(([value, text]) => {
		const option = element('option', { text });
		option.value = value;
		status.append(option);
	});
	const windowField = addField(form, 'Window', 'window', { tag: 'select' });
	[
		['', 'All windows'],
		['1h', '1h'],
		['4h', '4h'],
		['1D', '1D'],
		['1W', '1W'],
	].forEach(([value, text]) => {
		const option = element('option', { text });
		option.value = value;
		windowField.append(option);
	});
	const from = addField(form, 'From', 'from', { placeholder: 'ISO-8601 timestamp' });
	const to = addField(form, 'To', 'to', { placeholder: 'ISO-8601 timestamp' });
	const limit = addField(form, 'Limit', 'limit', { type: 'number', min: 1, max: 100, value: 50 });
	const before = addField(form, 'Before cursor', 'before', { placeholder: 'nextBefore from the previous page' });

	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const prev = element('button', { text: 'Previous page' });
	prev.type = 'button';
	prev.disabled = true;
	const next = element('button', { text: 'Next page' });
	next.type = 'button';
	next.disabled = true;
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	const outcomeList = element('div', { className: 'form-fields outcome-list' });
	let lastRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.append(
		element('summary', { text: 'Show raw response' }),
		rawCopyButton,
		rawOutput,
	);
	form.append(button, prev, next, output, outcomeList, rawToggle);

	let nextBefore;
	let backCursors = [];
	let pageGeneration = 0;
	const requestPage = async (cursor) => {
		const generation = ++pageGeneration;
		prev.disabled = true;
		next.disabled = true;
		before.value = cursor || '';
		const query = Object.fromEntries(Object.entries({
			limit: limit.value,
			before: before.value,
			symbol: symbol.value,
			exchange: exchange.value,
			status: status.value,
			window: windowField.value,
			from: from.value,
			to: to.value,
		}).filter(([, value]) => value !== ''));
		const data = await sendRequest({
			definition,
			path: definition.path,
			query,
			button,
			output,
			isCurrent: () => generation === pageGeneration,
			formatResponse: ({ summary, status: respStatus, elapsed, data: payload }) => `${summary}\nHTTP ${respStatus} · ${elapsed} ms · `
				+ `${payload && Array.isArray(payload.outcomes) ? `${payload.outcomes.length} outcomes on this page` : 'no outcome list returned'}`,
		});
		if (generation !== pageGeneration) return false;
		if (data && Array.isArray(data.outcomes)) {
			lastRawJson = JSON.stringify(data, null, 2);
			rawOutput.textContent = lastRawJson;
			rawCopyButton.hidden = false;
			outcomeList.replaceChildren();
			if (!data.outcomes.length) {
				outcomeList.append(createEmptyState('No recorded outcomes match these filters.'));
			} else {
				data.outcomes.forEach((outcome) => outcomeList.append(createOutcomeCard(outcome)));
			}
		} else {
			lastRawJson = '';
			rawOutput.textContent = '';
			rawCopyButton.hidden = true;
			outcomeList.replaceChildren();
		}
		const pagination = (data && data.pagination) || {};
		nextBefore = pagination.hasMore === true && pagination.nextBefore
			? pagination.nextBefore
			: undefined;
		next.disabled = !nextBefore;
		prev.disabled = !backCursors.length;
		return Boolean(data && Array.isArray(data.outcomes));
	};
	const syncPagingButtons = () => {
		next.disabled = !nextBefore;
		prev.disabled = !backCursors.length;
	};
	const resetPagination = ({ clearCursor }) => {
		pageGeneration += 1;
		nextBefore = undefined;
		backCursors = [];
		next.disabled = true;
		prev.disabled = true;
		button.disabled = false;
		outcomeList.replaceChildren();
		lastRawJson = '';
		rawOutput.textContent = '';
		rawCopyButton.hidden = true;
		output.textContent = 'Filters changed — load outcomes to refresh.';
		if (clearCursor) before.value = '';
	};
	[limit, symbol, exchange, status, windowField, from, to].forEach((field) => {
		field.addEventListener('input', () => resetPagination({ clearCursor: true }));
		field.addEventListener('change', () => resetPagination({ clearCursor: true }));
	});
	before.addEventListener('input', () => resetPagination({ clearCursor: false }));
	before.addEventListener('change', () => resetPagination({ clearCursor: false }));
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		backCursors = [];
		return requestPage(before.value);
	});
	next.addEventListener('click', () => {
		if (!nextBefore) return;
		const entry = before.value || '';
		Promise.resolve(requestPage(nextBefore)).then((succeeded) => {
			if (!succeeded) return;
			backCursors.push(entry);
			syncPagingButtons();
		});
	});
	prev.addEventListener('click', () => {
		if (!backCursors.length) return;
		const target = backCursors[backCursors.length - 1];
		Promise.resolve(requestPage(target)).then((succeeded) => {
			if (!succeeded) return;
			backCursors.pop();
			syncPagingButtons();
		});
	});
	return form;
};

const renderOutcomesSummaryBlocks = (data) => {
	const summary = asObject(data && data.summary);
	const wrap = element('div', { className: 'dashboard' });
	const metrics = element('div', { className: 'metric-grid' });
	wrap.append(metrics);

	const totalSignals = summary.totalSignalsReceived ?? summary.totalSignals ?? 0;
	const totalEligible = summary.totalSignalsEligible ?? 0;
	const totalEvaluated = summary.totalSignalsEvaluated ?? 0;
	const totalPending = summary.totalSignalsPending ?? 0;
	const winRate = summary.winRatePercent ?? summary.overallHitRatePercent;
	const expR = summary.expectancyR;
	const avgReturn = summary.averageReturnPercent;

	metrics.append(
		createMetricCard(
			'Signals',
			formatJobValue(totalSignals),
			`${formatJobValue(totalEligible)} eligible · ${formatJobValue(totalEvaluated)} evaluated · ${formatJobValue(totalPending)} pending`,
		),
		createMetricCard(
			'Hit rate',
			winRate !== undefined && winRate !== null ? `${winRate}%` : '—',
			'Evaluated signals meeting targets',
		),
		createMetricCard(
			'Average return',
			avgReturn !== undefined && avgReturn !== null ? `${avgReturn > 0 ? '+' : ''}${avgReturn}%` : '—',
			expR !== undefined && expR !== null ? `Expectancy ${expR > 0 ? '+' : ''}${expR}R` : 'Average per evaluated window',
		),
		createMetricCard(
			'MFE / MAE',
			summary.averageMfePercent !== undefined ? `+${summary.averageMfePercent}%` : '—',
			summary.averageMaePercent !== undefined ? `Avg MAE: ${summary.averageMaePercent}%` : 'Excursion metrics',
		),
	);

	const windows = asObject(summary.windows || summary.byWindow);
	const windowEntries = Object.entries(windows);
	if (windowEntries.length) {
		const section = element('section', { className: 'dashboard-section' });
		section.append(element('h3', { text: 'Performance by window' }));
		const table = element('table', { className: 'data-table' });
		const head = element('tr');
		['Window', 'Evaluated', 'Hit rate', 'Target hit', 'Stop hit', 'Exp (R)', 'Avg return', 'Avg MFE', 'Avg MAE'].forEach((label) => head.append(element('th', { text: label })));
		table.append(head);
		windowEntries.forEach(([winKey, stats]) => {
			const detail = asObject(stats);
			const row = element('tr');
			row.append(
				element('td', { text: winKey }),
				element('td', { text: formatJobValue(detail.totalSignals ?? detail.evaluatedCount) }),
				element('td', { text: detail.hitRatePercent !== undefined ? `${detail.hitRatePercent}%` : '—' }),
				element('td', { text: detail.targetHitRatePercent !== undefined ? `${detail.targetHitRatePercent}%` : '—' }),
				element('td', { text: detail.stopHitRatePercent !== undefined ? `${detail.stopHitRatePercent}%` : '—' }),
				element('td', { text: detail.expectancyR !== undefined && detail.expectancyR !== null ? `${detail.expectancyR > 0 ? '+' : ''}${detail.expectancyR}R` : '—' }),
				element('td', { text: detail.averageReturnPercent !== undefined ? `${detail.averageReturnPercent > 0 ? '+' : ''}${detail.averageReturnPercent}%` : '—' }),
				element('td', { text: detail.averageMfePercent !== undefined ? `+${detail.averageMfePercent}%` : '—' }),
				element('td', { text: detail.averageMaePercent !== undefined ? `${detail.averageMaePercent}%` : '—' }),
			);
			table.append(row);
		});
		section.append(table);
		wrap.append(section);
	}

	return wrap;
};

const createOutcomesSummaryForm = () => {
	const definition = { method: 'GET', path: '/api/outcomes/summary', label: 'Load outcomes summary' };
	const form = element('form', { className: 'operation-card' });
	form.append(
		element('h3', { text: definition.label }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);
	const symbol = addField(form, 'Symbol', 'symbol', { placeholder: 'BTCUSDT or BINANCE:BTCUSDT' });
	const exchange = addField(form, 'Exchange', 'exchange', { placeholder: 'BINANCE' });
	const status = addField(form, 'Status', 'status', { tag: 'select' });
	[
		['', 'All statuses'],
		['pending', 'Pending'],
		['evaluated', 'Evaluated'],
		['unavailable', 'Unavailable'],
	].forEach(([value, text]) => {
		const option = element('option', { text });
		option.value = value;
		status.append(option);
	});
	const windowField = addField(form, 'Window', 'window', { tag: 'select' });
	[
		['', 'All windows'],
		['1h', '1h'],
		['4h', '4h'],
		['1D', '1D'],
		['1W', '1W'],
	].forEach(([value, text]) => {
		const option = element('option', { text });
		option.value = value;
		windowField.append(option);
	});
	const from = addField(form, 'From', 'from', { placeholder: 'ISO-8601 timestamp' });
	const to = addField(form, 'To', 'to', { placeholder: 'ISO-8601 timestamp' });
	const limit = addField(form, 'Limit', 'limit', { type: 'number', min: 1, max: 100, value: 50 });

	const button = element('button', { text: definition.label });
	button.type = 'submit';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	const blocks = element('div', { className: 'summary-host' });
	let lastRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.append(
		element('summary', { text: 'Show raw summary response' }),
		rawCopyButton,
		rawOutput,
	);
	form.append(button, output, blocks, rawToggle);

	let summaryGeneration = 0;
	const invalidateSummary = () => {
		summaryGeneration += 1;
		button.disabled = false;
		blocks.replaceChildren();
		lastRawJson = '';
		rawOutput.textContent = '';
		rawCopyButton.hidden = true;
		output.textContent = 'Filters changed — load outcomes summary to refresh.';
	};
	[symbol, exchange, status, windowField, from, to, limit].forEach((field) => {
		field.addEventListener('input', invalidateSummary);
		field.addEventListener('change', invalidateSummary);
	});
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		const generation = ++summaryGeneration;
		const query = Object.fromEntries(Object.entries({
			limit: limit.value,
			symbol: symbol.value,
			exchange: exchange.value,
			status: status.value,
			window: windowField.value,
			from: from.value,
			to: to.value,
		}).filter(([, value]) => value !== ''));
		sendRequest({
			definition,
			path: definition.path,
			query,
			button,
			output,
			isCurrent: () => generation === summaryGeneration,
			formatResponse: ({ summary: sumText, status: respStatus, elapsed, data }) => {
				if (!data || !data.summary) return `${sumText}\nHTTP ${respStatus} · ${elapsed} ms\n\nNo summary data returned.`;
				lastRawJson = JSON.stringify(data, null, 2);
				return `${sumText}\nHTTP ${respStatus} · ${elapsed} ms`;
			},
		}).then((data) => {
			if (generation !== summaryGeneration) return;
			if (!data || !data.summary) {
				blocks.replaceChildren();
				lastRawJson = '';
				rawOutput.textContent = '';
				rawCopyButton.hidden = true;
				return;
			}
			blocks.replaceChildren(renderOutcomesSummaryBlocks(data));
			rawOutput.textContent = lastRawJson;
			rawCopyButton.hidden = false;
		});
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
	const jobHeading = element('h3');
	jobHeading.append(
		element('span', { text: jobId }),
		createCopyButton(jobId, 'Copy ID'),
	);
	card.append(jobHeading);

	const details = element('dl');
	[
		['Type', job && job.type],
		['Status', job && job.status],
		['Progress', formatJobProgress(job && job.progress)],
	].forEach(([label, value]) => {
		details.append(element('dt', { text: label }), element('dd', { text: formatJobValue(value) }));
	});
	[
		['Created', job && job.createdAt],
		['Updated', job && job.updatedAt],
	].forEach(([label, value]) => {
		const dd = element('dd');
		if (value) dd.append(createTimestamp(value));
		else dd.textContent = '—';
		details.append(element('dt', { text: label }), dd);
	});
	const duration = job && job.totalDurationMs !== undefined && job.totalDurationMs !== null
		? `${job.totalDurationMs} ms` : undefined;
	details.append(element('dt', { text: 'Duration' }), element('dd', { text: formatJobValue(duration) }));
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
			list.append(createEmptyState('No recent jobs found.'));
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
	const pollButton = element('button', { className: 'button-ghost', text: 'Pause auto-refresh' });
	pollButton.type = 'button';
	pollButton.hidden = true;
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	const statusPanel = element('div');
	let lastRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.append(
		element('summary', { text: 'Show raw job payload' }),
		rawCopyButton,
		rawOutput,
	);
	form.append(button, actions, pollButton, statusPanel, output, rawToggle);

	let statusRequestVersion = 0;
	let actionsEpoch = 0;
	let pollTimer;
	let pollPaused = false;
	let lastFetchedActive = false;

	function schedulePoll() {
		if (!lastFetchedActive || pollPaused) return;
		const version = statusRequestVersion;
		pollTimer = setTimeout(() => {
			pollTimer = undefined;
			if (pollPaused || version !== statusRequestVersion) return;
			Promise.resolve(requestStatus(true)).catch(() => {});
		}, JOB_POLL_INTERVAL_MS);
	}

	const stopPollTimer = () => {
		if (pollTimer !== undefined) {
			clearTimeout(pollTimer);
			pollTimer = undefined;
		}
	};

	const updatePollButton = () => {
		pollButton.hidden = !lastFetchedActive && !pollPaused;
		pollButton.textContent = pollPaused ? 'Resume auto-refresh' : 'Pause auto-refresh';
	};

	const clearStructuredState = () => {
		statusPanel.replaceChildren();
		actions.replaceChildren();
		rawOutput.textContent = '';
		rawCopyButton.hidden = true;
		lastFetchedActive = false;
		stopPollTimer();
		updatePollButton();
	};

	const applyStatus = (data, jobId) => {
		statusPanel.replaceChildren(createJobPanel(data));
		lastRawJson = JSON.stringify(data, null, 2);
		rawOutput.textContent = lastRawJson;
		rawCopyButton.hidden = false;
		renderActions(data, jobId);
		lastFetchedActive = JOB_ACTIVE_STATUSES.includes(data.status);
		stopPollTimer();
		if (lastFetchedActive && !pollPaused) schedulePoll();
		updatePollButton();
	};

	const requestStatus = async (isAutoRefresh) => {
		const jobId = jobIdInput.value.trim();
		if (jobIdInput.value !== jobId) jobIdInput.value = jobId;
		if (!jobId) return undefined;
		const requestVersion = ++statusRequestVersion;
		let pollFailureStatus;
		const data = await sendRequest({
			definition,
			path: fillPath(definition.path, pathNames, form),
			button,
			output,
			isCurrent: () => requestVersion === statusRequestVersion
				&& form.elements['path-jobId'].value.trim() === jobId,
			formatResponse: ({ summary, status, elapsed }) => `${summary}\nHTTP ${status} · ${elapsed} ms`
				+ (isAutoRefresh ? ' · auto-refresh' : ''),
			captureResponseStatus: (responseStatus) => { pollFailureStatus = responseStatus; },
		});
		if (requestVersion !== statusRequestVersion || form.elements['path-jobId'].value.trim() !== jobId) return data;
		if (data && data.status) applyStatus(data, jobId);
		else if (!isAutoRefresh) clearStructuredState();
		else {
			statusRequestVersion += 1;
			stopPollTimer();
			const recoverable = typeof pollFailureStatus !== 'number'
				|| pollFailureStatus >= 500 || pollFailureStatus === 429;
			if (recoverable && lastFetchedActive && !pollPaused) schedulePoll();
			else {
				lastFetchedActive = false;
				updatePollButton();
			}
		}
		return data;
	};

	pollButton.addEventListener('click', () => {
		pollPaused = !pollPaused;
		if (pollPaused) stopPollTimer();
		else schedulePoll();
		updatePollButton();
	});

	jobIdInput.addEventListener('input', () => {
		actionsEpoch += 1;
		jobIdInput.value = jobIdInput.value.trim();
		statusRequestVersion += 1;
		button.disabled = false;
		clearStructuredState();
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
		const actionVersion = actionsEpoch;
		definitions.forEach((action) => {
			const actionButton = element('button', { text: action.label });
			actionButton.type = 'button';
			actionButton.className = 'destructive-action';
			actionButton.addEventListener('click', () => sendRequest({
				definition: action,
				path: action.path.replace('{jobId}', encodeURIComponent(jobId)),
				button: actionButton,
				output,
				isCurrent: () => actionVersion === actionsEpoch
					&& form.elements['path-jobId'].value.trim() === jobId,
			}));
			actions.append(actionButton);
		});
	};

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		Promise.resolve(requestStatus(false)).catch(() => {});
	});

	detachActiveViewPoll = () => {
		statusRequestVersion += 1;
		stopPollTimer();
	};

	return {
		form,
		selectJob: async (selectedJobId, options = {}) => {
			statusRequestVersion += 1;
			jobIdInput.value = selectedJobId;
			button.disabled = false;
			clearStructuredState();
			if (options && options.autoLoad) {
				if (typeof form.scrollIntoView === 'function') {
					form.scrollIntoView({ behavior: 'smooth' });
				}
				return requestStatus(false);
			}
			output.textContent = 'Job selected. Submit to load its status.';
			if (typeof jobIdInput.focus === 'function') jobIdInput.focus();
			return undefined;
		},
	};
};

const PRESET_SCAN_TYPES = [
	{ id: 'top_gainers', label: 'Top gainers' },
	{ id: 'top_losers', label: 'Top losers' },
	{ id: 'bollinger_scan', label: 'Bollinger bands' },
	{ id: 'volume_breakout_scanner', label: 'Volume breakout' },
	{ id: 'smart_volume_scanner', label: 'Smart volume' },
];

const PRESET_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1D', '1W', '1M'];

const createJobCreateForm = (contract, definition, onJobCreated) => {
	const form = element('form', { className: 'operation-card structured-form' });
	form.append(
		element('h3', { text: definition.label || 'Create job' }),
		element('code', { text: `${definition.method} ${definition.path}` }),
	);

	const eaTimeframes = (() => {
		const schema = contract?.components?.schemas?.ExpandedAnalysisRequest?.properties?.timeframe;
		if (schema && Array.isArray(schema.enum) && schema.enum.length) return schema.enum;
		return PRESET_TIMEFRAMES;
	})();

	const msTimeframes = (() => {
		const schema = contract?.components?.schemas?.MarketScannerRequest?.properties?.timeframe;
		if (schema && Array.isArray(schema.enum) && schema.enum.length) return schema.enum;
		return ['15m', '1h', '4h', '1D'];
	})();

	const msScans = (() => {
		const schema = contract?.components?.schemas?.MarketScannerRequest?.properties?.scans;
		if (schema?.items && Array.isArray(schema.items.enum) && schema.items.enum.length) return schema.items.enum;
		return ['top_gainers', 'top_losers', 'volume_breakout_scanner', 'smart_volume_scanner', 'bollinger_scan'];
	})();

	const cbEventsEnum = (() => {
		const schema = contract?.components?.schemas?.CallbackFields?.properties?.callbackEvents;
		if (schema?.items && Array.isArray(schema.items.enum) && schema.items.enum.length) return schema.items.enum;
		return ['completed', 'failed', 'cancelled', 'timed_out', 'processing'];
	})();

	// Job type selector
	const typeSelect = addField(form, 'Job type', 'type', { tag: 'select' });
	[
		{ value: 'expanded-analysis', label: 'Expanded analysis' },
		{ value: 'market-scanner', label: 'Market scanner' },
	].forEach(({ value, label }) => {
		const opt = element('option', { text: label });
		opt.value = value;
		typeSelect.append(opt);
	});
	typeSelect.value = 'expanded-analysis';

	// Shared Timeframe Selector
	const timeframeSelect = addField(form, 'Timeframe', 'timeframe', { tag: 'select' });
	const updateTimeframeOptions = (timeframes, defaultValue) => {
		timeframeSelect.replaceChildren();
		timeframes.forEach((tf) => {
			const opt = element('option', { text: tf });
			opt.value = tf;
			timeframeSelect.append(opt);
		});
		timeframeSelect.value = defaultValue;
	};

	// Type containers
	const eaContainer = element('div', { className: 'job-type-container' });
	const msContainer = element('div', { className: 'job-type-container' });
	msContainer.hidden = true;

	// --- Expanded Analysis fields ---
	const symbolsInput = addField(eaContainer, 'Symbols (EXCHANGE:SYMBOL, one per line)', 'symbols', {
		tag: 'textarea',
		rows: 3,
		placeholder: 'BINANCE:BTCUSDT\nNASDAQ:NVDA',
		value: 'BINANCE:BTCUSDT',
	});
	const symbolsFeedback = element('div', { className: 'field-feedback' });
	eaContainer.append(symbolsFeedback);

	// Shared MTF checkbox element
	const mtfLabel = element('label', { className: 'checkbox-label' });
	const mtfCheckbox = element('input', { type: 'checkbox' });
	mtfCheckbox.name = 'includeMultiTimeframe';
	const mtfSpan = element('span', { text: 'Include multi-timeframe analysis' });
	mtfLabel.append(mtfCheckbox, mtfSpan);
	eaContainer.append(mtfLabel);

	// --- Market Scanner fields ---
	const msExchangeInput = addField(msContainer, 'Exchange', 'exchange', {
		placeholder: 'BINANCE',
		value: 'BINANCE',
	});

	const scansFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	scansFieldset.append(element('legend', { text: 'Scans' }));
	const scanInputs = [];
	const initialCheckedScans = ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
	msScans.forEach((scan) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `scan_${scan}`;
		cb.value = scan;
		cb.checked = initialCheckedScans.includes(scan);
		const def = PRESET_SCAN_TYPES.find((s) => s.id === scan);
		label.append(cb, element('span', { text: def ? def.label : scan.replace(/_/g, ' ') }));
		scansFieldset.append(label);
		scanInputs.push(cb);
	});
	msContainer.append(scansFieldset);

	const msLimitInput = addField(msContainer, 'Scan limit (1-20)', 'limit', {
		type: 'number',
		min: 1,
		max: 20,
		value: 5,
	});
	const clampLimit = () => {
		const val = parseInt(msLimitInput.value, 10);
		if (Number.isFinite(val)) {
			msLimitInput.value = Math.max(1, Math.min(20, val));
		}
	};
	msLimitInput.addEventListener('input', clampLimit);
	msLimitInput.addEventListener('change', clampLimit);

	const msBbwInput = addField(msContainer, 'BBW threshold', 'bbw_threshold', {
		type: 'number',
		step: '0.01',
		min: 0,
		value: 0.05,
	});

	const msFlags = element('div', { className: 'badge-row' });
	const msRankedCheckbox = addField(msFlags, 'Ranked results', 'ranked', {
		type: 'checkbox',
		checked: true,
	});
	msContainer.append(msFlags);

	form.append(eaContainer, msContainer);

	// --- Advanced Section ---
	const advancedDetails = element('details', { className: 'raw-status' });
	advancedDetails.append(element('summary', { text: 'Advanced options & raw JSON' }));

	const channelsFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	channelsFieldset.append(element('legend', { text: 'Notification channels (optional)' }));
	const channelInputs = [];
	['telegram', 'whatsapp', 'discord'].forEach((ch) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `channel_${ch}`;
		cb.value = ch;
		label.append(cb, element('span', { text: ch.charAt(0).toUpperCase() + ch.slice(1) }));
		channelsFieldset.append(label);
		channelInputs.push(cb);
	});
	advancedDetails.append(channelsFieldset);

	const tgChatInput = addField(advancedDetails, 'Telegram Chat ID (optional)', 'telegramChatId', {
		placeholder: 'e.g. -1001234567890',
	});
	const waChatInput = addField(advancedDetails, 'WhatsApp Chat ID (optional)', 'whatsappChatId', {
		placeholder: 'e.g. 1234567890@c.us',
	});

	const cbUrlInput = addField(advancedDetails, 'Callback URL (optional)', 'callbackUrl', {
		placeholder: 'https://myapp.example.com/job-done',
	});
	const cbSecretInput = addField(advancedDetails, 'Callback secret (optional)', 'callbackSecret', {
		placeholder: 'shared-secret',
	});
	const cbEventsFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	cbEventsFieldset.append(element('legend', { text: 'Callback events' }));
	const cbEventInputs = [];
	const defaultCbEvents = ['completed', 'failed', 'cancelled', 'timed_out'];
	cbEventsEnum.forEach((evt) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `callback_event_${evt}`;
		cb.value = evt;
		cb.checked = defaultCbEvents.includes(evt);
		label.append(cb, element('span', { text: evt }));
		cbEventsFieldset.append(label);
		cbEventInputs.push(cb);
	});
	advancedDetails.append(cbEventsFieldset);

	const timeoutMsInput = addField(advancedDetails, 'Timeout ms (optional)', 'timeoutMs', {
		type: 'number',
		min: 1000,
		max: 600000,
		step: 1000,
		placeholder: '300000',
	});

	addJsonField(advancedDetails, 'Request body JSON (raw override)', 'body', {});
	form.append(advancedDetails);

	// Actions, output, and raw response
	const button = element('button', { text: definition.label || 'Create job' });
	button.type = 'submit';
	const retryButton = element('button', { className: 'button-ghost', text: 'Retry submission' });
	retryButton.type = 'button';
	retryButton.hidden = true;
	const formActions = element('div', { className: 'form-actions' });
	formActions.append(button, retryButton);

	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	let lastRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.append(
		element('summary', { text: 'Show raw response' }),
		rawCopyButton,
		rawOutput,
	);
	form.append(formActions, output, rawToggle);

	// Validation
	const validateSymbols = () => {
		const text = (symbolsInput.value || '').trim();
		if (!text) {
			const msg = 'At least one symbol is required.';
			symbolsFeedback.textContent = msg;
			symbolsFeedback.className = 'field-feedback error';
			return msg;
		}
		const symbols = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
		if (!symbols.length) {
			const msg = 'At least one symbol is required.';
			symbolsFeedback.textContent = msg;
			symbolsFeedback.className = 'field-feedback error';
			return msg;
		}
		const invalid = symbols.filter((s) => !SYMBOL_PATTERN.test(s));
		if (invalid.length > 0) {
			const msg = `Malformed symbol(s): ${invalid.join(', ')}. Expected EXCHANGE:SYMBOL format (e.g. BINANCE:BTCUSDT).`;
			symbolsFeedback.textContent = msg;
			symbolsFeedback.className = 'field-feedback error';
			return msg;
		}
		symbolsFeedback.textContent = '';
		symbolsFeedback.className = 'field-feedback';
		return null;
	};

	symbolsInput.addEventListener('input', validateSymbols);

	// Type switching
	const updateTypeView = () => {
		const isEA = typeSelect.value === 'expanded-analysis';
		eaContainer.hidden = !isEA;
		msContainer.hidden = isEA;
		if (isEA) {
			updateTimeframeOptions(eaTimeframes, '1D');
			eaContainer.append(mtfLabel);
			mtfSpan.textContent = 'Include multi-timeframe analysis';
			mtfCheckbox.checked = false;
			validateSymbols();
		} else {
			updateTimeframeOptions(msTimeframes, '4h');
			msFlags.append(mtfLabel);
			mtfSpan.textContent = 'Include multi-timeframe';
			mtfCheckbox.checked = true;
			symbolsFeedback.textContent = '';
			symbolsFeedback.className = 'field-feedback';
		}
	};

	// Payload builder & sync
	const buildPayload = () => {
		const selectedType = typeSelect.value;
		const payload = { type: selectedType };

		if (selectedType === 'expanded-analysis') {
			const text = (symbolsInput.value || '').trim();
			const symbols = text ? text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : [];
			payload.symbols = symbols;
			payload.timeframe = timeframeSelect.value || '1D';
			if (mtfCheckbox.checked) payload.includeMultiTimeframe = true;
		} else if (selectedType === 'market-scanner') {
			payload.exchange = (msExchangeInput.value || '').trim() || 'BINANCE';
			payload.timeframe = timeframeSelect.value || '4h';
			const selectedScans = scanInputs.filter((cb) => cb.checked).map((cb) => cb.value);
			payload.scans = selectedScans.length ? selectedScans : ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
			clampLimit();
			const rawLimit = parseInt(msLimitInput.value, 10);
			payload.limit = Number.isFinite(rawLimit) ? rawLimit : 5;
			const bbw = parseFloat(msBbwInput.value);
			if (Number.isFinite(bbw)) payload.bbw_threshold = bbw;
			if (msRankedCheckbox.checked) payload.ranked = true;
			if (mtfCheckbox.checked) payload.includeMultiTimeframe = true;
		}

		const selectedChannels = channelInputs.filter((cb) => cb.checked).map((cb) => cb.value);
		if (selectedChannels.length > 0) payload.channels = selectedChannels;
		const tgChat = (tgChatInput.value || '').trim();
		if (tgChat) payload.telegramChatId = tgChat;
		const waChat = (waChatInput.value || '').trim();
		if (waChat) payload.whatsappChatId = waChat;

		const cbUrl = (cbUrlInput.value || '').trim();
		if (cbUrl) {
			payload.callbackUrl = cbUrl;
			const cbSecret = (cbSecretInput.value || '').trim();
			if (cbSecret) payload.callbackSecret = cbSecret;
			const selectedEvents = cbEventInputs.filter((cb) => cb.checked).map((cb) => cb.value);
			if (selectedEvents.length > 0) payload.callbackEvents = selectedEvents;
		}
		const timeoutVal = parseInt(timeoutMsInput.value, 10);
		if (Number.isFinite(timeoutVal) && timeoutVal > 0) payload.timeoutMs = timeoutVal;

		return payload;
	};

	let isAdvancedDirty = false;
	const syncBody = () => {
		if (isAdvancedDirty || !form.elements.body) return undefined;
		const payload = buildPayload();
		form.elements.body.value = JSON.stringify(payload, null, 2);
		return payload;
	};

	typeSelect.addEventListener('change', () => {
		updateTypeView();
		isAdvancedDirty = false;
		syncBody();
	});

	const structuredInputs = [
		symbolsInput, mtfCheckbox, timeframeSelect,
		msExchangeInput, msLimitInput, msBbwInput, msRankedCheckbox,
		...scanInputs, ...channelInputs, tgChatInput, waChatInput,
		cbUrlInput, cbSecretInput, ...cbEventInputs, timeoutMsInput,
	];
	structuredInputs.forEach((input) => {
		input.addEventListener('input', () => {
			isAdvancedDirty = false;
			syncBody();
		});
		input.addEventListener('change', () => {
			isAdvancedDirty = false;
			syncBody();
		});
	});
	if (form.elements.body) {
		form.elements.body.addEventListener('input', () => {
			isAdvancedDirty = true;
		});
	}

	updateTypeView();
	syncBody();

	// Submission & retry
	let lastIdempotencyKey = null;
	let submitInProgress = false;

	const doSubmit = async (idempotencyKey) => {
		if (submitInProgress) return;
		if (!isAdvancedDirty && typeSelect.value === 'expanded-analysis') {
			const err = validateSymbols();
			if (err) {
				showError(output, err);
				return;
			}
		}

		let body;
		try {
			const bodyInput = form.elements.body;
			body = isAdvancedDirty && bodyInput ? parseJson(bodyInput.value, 'Request body') : buildPayload();
		} catch (error) {
			showError(output, error.message);
			return;
		}

		lastIdempotencyKey = idempotencyKey;
		retryButton.hidden = true;
		lastRawJson = '';
		rawOutput.textContent = '';
		rawCopyButton.hidden = true;
		submitInProgress = true;

		let pollFailureStatus;
		const headers = { 'idempotency-key': idempotencyKey };
		try {
			const data = await sendRequest({
				definition,
				path: definition.path,
				headers,
				body,
				button,
				output,
				captureResponseStatus: (responseStatus) => { pollFailureStatus = responseStatus; },
				formatResponse: ({ summary, status: responseStatus, elapsed }) => (
					`${summary}\nHTTP ${responseStatus} · ${elapsed} ms`
				),
			});

			if (data) {
				lastRawJson = JSON.stringify(data, null, 2);
				rawOutput.textContent = lastRawJson;
				rawCopyButton.hidden = false;
			}

			if (data && data.jobId && (!pollFailureStatus || pollFailureStatus < 400)) {
				if (typeof onJobCreated === 'function') {
					await onJobCreated(data.jobId);
				}
			} else if (pollFailureStatus && pollFailureStatus >= 400) {
				retryButton.hidden = false;
			}
		} catch (error) {
			showError(output, error.message);
			retryButton.hidden = false;
		} finally {
			submitInProgress = false;
		}
	};

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const freshKey = createIdempotencyKey();
		await doSubmit(freshKey);
	});

	retryButton.addEventListener('click', async () => {
		if (lastIdempotencyKey) {
			await doSubmit(lastIdempotencyKey);
		}
	});

	return form;
};

const canPerformMutation = () => !authState.enabled
	|| (Boolean(authState.user) && window.CabrosAdminRequest.canAccess({ requiredRole: 'admin.operator' }, authState.role));

const createPresetSummary = (preset, { onEdit, onRun, onDelete }) => {
	const card = element('article', { className: 'operation-card preset-card' });
	const id = String(preset && preset.id || '—');
	const name = String(preset && preset.name || 'Unnamed preset');

	const header = element('div', { className: 'preset-card-header' });
	const titleHeading = element('h3');
	titleHeading.append(element('span', { text: name }));
	const monoId = element('span', { className: 'mono-line' });
	monoId.append(
		element('code', { text: id }),
		createCopyButton(id, 'Copy ID'),
	);
	header.append(titleHeading, monoId);
	card.append(header);

	const summaryLine = element('p', {
		className: 'job-meta',
		text: `${preset.exchange || 'BINANCE'} · ${preset.timeframe || '4h'} · Limit ${preset.limit || 5}`,
	});
	card.append(summaryLine);

	const chips = element('div', { className: 'chip-grid' });
	(Array.isArray(preset.scans) ? preset.scans : []).forEach((scan) => {
		chips.append(element('span', { className: 'capability-chip', text: scan }));
	});

	if (preset.schedule && preset.schedule.enabled !== false && (preset.schedule.cadence || preset.schedule.cadenceMs)) {
		const cadence = preset.schedule.cadence || `${Math.round(preset.schedule.cadenceMs / 60000)}m`;
		chips.append(element('span', { className: 'status-badge status-active', text: `Schedule: ${cadence}` }));
	}

	if (preset.ranked) {
		chips.append(element('span', { className: 'status-badge status-ready', text: 'Ranked' }));
	}
	if (preset.includeMultiTimeframe) {
		chips.append(element('span', { className: 'status-badge status-ready', text: 'MTF' }));
	}
	if (preset.bbwThreshold !== undefined && preset.bbwThreshold !== null) {
		chips.append(element('span', { className: 'capability-chip', text: `BBW: ${preset.bbwThreshold}` }));
	}
	if (chips.children.length) card.append(chips);

	if (preset.lastRunAt || preset.lastStatus) {
		const dl = element('dl', { className: 'status-detail-list' });
		if (preset.lastStatus) {
			dl.append(element('dt', { text: 'Last status' }), element('dd', { text: preset.lastStatus }));
		}
		if (preset.lastRunAt) {
			const dd = element('dd');
			dd.append(createTimestamp(preset.lastRunAt));
			dl.append(element('dt', { text: 'Last run' }), dd);
		}
		card.append(dl);
	}

	const actions = element('div', { className: 'preset-actions' });
	const runBtn = element('button', { text: 'Run', className: 'button-primary' });
	runBtn.type = 'button';
	runBtn.setAttribute('aria-label', `Run preset ${name}`);
	const editBtn = element('button', { text: 'Edit' });
	editBtn.type = 'button';
	editBtn.setAttribute('aria-label', `Edit preset ${name}`);
	const deleteBtn = element('button', { text: 'Delete', className: 'destructive-action' });
	deleteBtn.type = 'button';
	deleteBtn.setAttribute('aria-label', `Delete preset ${name}`);

	const isOperator = canPerformMutation();
	if (!isOperator) {
		runBtn.disabled = true;
		runBtn.title = 'Requires admin.operator role';
		editBtn.disabled = true;
		editBtn.title = 'Requires admin.operator role';
		deleteBtn.disabled = true;
		deleteBtn.title = 'Requires admin.operator role';
	}

	const resultHost = element('div');
	const output = element('pre', { className: 'response-block', text: '' });
	output.hidden = true;
	let lastRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.hidden = true;
	rawToggle.append(element('summary', { text: 'Show raw run response' }), rawCopyButton, rawOutput);

	runBtn.addEventListener('click', () => {
		onRun(preset, runBtn, card, output, resultHost, rawToggle, rawOutput, rawCopyButton);
	});
	editBtn.addEventListener('click', () => {
		onEdit(preset);
	});
	deleteBtn.addEventListener('click', () => {
		onDelete(preset, deleteBtn, card);
	});

	actions.append(runBtn, editBtn, deleteBtn);
	card.append(actions, resultHost, output, rawToggle);

	return card;
};

const createPresetListForm = (contract, { onEdit, onStorageUpdate }) => {
	const definition = { method: 'GET', path: '/api/scanner-presets', label: 'Load presets' };
	const form = element('form', { className: 'operation-card preset-list-panel' });

	const titleRow = element('div', { className: 'section-heading' });
	const title = element('h3', { text: 'Scanner presets' });
	const storageBadge = element('span', { className: 'status-badge status-unknown', text: 'Storage: checking…' });
	titleRow.append(title, storageBadge);
	const route = element('code', { text: `${definition.method} ${definition.path}` });
	form.append(titleRow, route);

	const updateStorageBadge = (storage) => {
		if (!storage || typeof storage !== 'object') return;
		const mode = String(storage.mode || 'unknown');
		const backend = String(storage.backend || 'unknown');
		const isDurable = mode.toLowerCase() === 'durable';
		storageBadge.className = `status-badge ${isDurable ? 'status-ready' : 'status-disabled'}`;
		storageBadge.textContent = `${displayLabel(mode)} · ${displayLabel(backend)}`;
	};

	const button = element('button', { text: definition.label });
	button.type = 'submit';

	const listContainer = element('div', { className: 'form-fields preset-list' });
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });

	let lastListRawJson = '';
	const rawOutput = element('pre', { className: 'response-block' });
	const rawCopyButton = createCopyButton(() => lastListRawJson, 'Copy JSON');
	rawCopyButton.hidden = true;
	const rawToggle = element('details', { className: 'raw-status' });
	rawToggle.hidden = true;
	rawToggle.append(element('summary', { text: 'Show raw presets response' }), rawCopyButton, rawOutput);

	form.append(button, listContainer, output, rawToggle);

	const onRunPreset = async (preset, runBtn, card, cardOutput, cardResultHost, cardRawToggle, cardRawOutput, cardRawCopy) => {
		const runDef = {
			method: 'POST',
			path: '/api/scanner-presets/{id}/run',
			label: 'Run preset',
			confirm: 'Run this scanner preset?',
			requiredRole: 'admin.operator',
		};
		cardResultHost.replaceChildren();
		cardRawToggle.hidden = true;
		cardOutput.hidden = false;
		cardOutput.className = 'response-block request-state';
		cardOutput.textContent = 'Running scanner preset…';
		try {
			const data = await sendRequest({
				definition: runDef,
				path: `/api/scanner-presets/${encodeURIComponent(preset.id)}/run`,
				query: { dryRun: false },
				button: runBtn,
				output: cardOutput,
				formatResponse: ({ summary, status, elapsed }) => `${summary}\nHTTP ${status} · ${elapsed} ms`,
			});
			if (!data) {
				cardOutput.hidden = true;
				return;
			}
			if (data.storage) {
				updateStorageBadge(data.storage);
				if (typeof onStorageUpdate === 'function') onStorageUpdate(data.storage);
			}
			const rawJson = JSON.stringify(data, null, 2);
			cardRawOutput.textContent = rawJson;
			cardRawCopy.hidden = false;
			cardRawToggle.hidden = false;
			const rendered = analysisReportResult(data);
			cardResultHost.replaceChildren(...(rendered ? [rendered] : []));
		} catch (error) {
			showError(cardOutput, error.message);
		}
	};

	const onDeletePreset = async (preset, deleteBtn, card) => {
		const deleteDef = {
			method: 'DELETE',
			path: '/api/scanner-presets/{id}',
			label: 'Delete preset',
			confirm: 'Delete this scanner preset?',
			requiredRole: 'admin.operator',
		};
		try {
			const data = await sendRequest({
				definition: deleteDef,
				path: `/api/scanner-presets/${encodeURIComponent(preset.id)}`,
				button: deleteBtn,
				output,
			});
			if (data && data.success) {
				card.remove();
				if (data.storage) {
					updateStorageBadge(data.storage);
					if (typeof onStorageUpdate === 'function') onStorageUpdate(data.storage);
				}
				await loadPresets();
			}
		} catch (error) {
			showError(output, error.message);
		}
	};

	const loadPresets = async () => {
		listContainer.replaceChildren(element('div', { className: 'loading-state', text: 'Loading presets…' }));
		rawToggle.hidden = true;
		try {
			const data = await sendRequest({
				definition,
				path: definition.path,
				button,
				output,
				formatResponse: ({ summary, status, elapsed }) => `${summary}\nHTTP ${status} · ${elapsed} ms`,
			});
			if (!data) {
				listContainer.replaceChildren();
				return;
			}
			if (data.storage) {
				updateStorageBadge(data.storage);
				if (typeof onStorageUpdate === 'function') onStorageUpdate(data.storage);
			}
			lastListRawJson = JSON.stringify(data, null, 2);
			rawOutput.textContent = lastListRawJson;
			rawCopyButton.hidden = false;
			rawToggle.hidden = false;

			const presets = Array.isArray(data.presets) ? data.presets : [];
			listContainer.replaceChildren();
			if (!presets.length) {
				listContainer.append(createEmptyState('No scanner presets found.'));
				return;
			}
			presets.forEach((preset) => {
				const card = createPresetSummary(preset, {
					onEdit,
					onRun: onRunPreset,
					onDelete: onDeletePreset,
				});
				listContainer.append(card);
			});
		} catch (error) {
			showError(output, error.message);
		}
	};

	form.refresh = () => loadPresets();
	form.updateStorage = (storage) => updateStorageBadge(storage);

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		Promise.resolve(loadPresets()).catch(() => {});
	});

	return form;
};

const addPresetStructuredFields = (form, contract, operation) => {
	const bodyExample = getBodyExample(contract, operation) || {};
	let isAdvancedDirty = false;

	const nameInput = addField(form, 'Preset name', 'name', {
		required: true,
		placeholder: 'e.g. Daily Momentum',
		value: bodyExample.name || '',
	});

	const exchangeInput = addField(form, 'Exchange', 'exchange', {
		placeholder: 'BINANCE',
		value: bodyExample.exchange || 'BINANCE',
	});

	const timeframeSelect = addField(form, 'Timeframe', 'timeframe', { tag: 'select' });
	PRESET_TIMEFRAMES.forEach((tf) => {
		const option = element('option', { text: tf });
		option.value = tf;
		if (tf === (bodyExample.timeframe || '4h')) option.selected = true;
		timeframeSelect.append(option);
	});
	timeframeSelect.value = bodyExample.timeframe || '4h';

	const scansFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	scansFieldset.append(element('legend', { text: 'Scan types' }));
	const initialScans = Array.isArray(bodyExample.scans) && bodyExample.scans.length
		? bodyExample.scans
		: ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
	const scanInputs = [];
	PRESET_SCAN_TYPES.forEach((scan) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `scan_${scan.id}`;
		cb.value = scan.id;
		cb.checked = initialScans.includes(scan.id);
		label.append(cb, element('span', { text: scan.label }));
		scansFieldset.append(label);
		scanInputs.push(cb);
	});
	form.presetScanInputs = scanInputs;
	form.append(scansFieldset);

	const limitInput = addField(form, 'Scan limit', 'limit', {
		type: 'number',
		min: 1,
		max: 20,
		value: bodyExample.limit || 5,
	});
	limitInput.addEventListener('change', () => {
		const val = parseInt(limitInput.value, 10);
		if (Number.isFinite(val)) {
			limitInput.value = Math.max(1, Math.min(20, val));
		}
	});

	const bbwInput = addField(form, 'BBW threshold', 'bbwThreshold', {
		type: 'number',
		step: '0.01',
		min: 0,
		placeholder: '0.05',
		value: bodyExample.bbwThreshold !== undefined && bodyExample.bbwThreshold !== null ? bodyExample.bbwThreshold : '',
	});

	const flagsRow = element('div', { className: 'badge-row' });
	const rankedLabel = element('label', { className: 'checkbox-label' });
	const rankedCb = element('input', { type: 'checkbox' });
	rankedCb.name = 'ranked';
	rankedCb.checked = Boolean(bodyExample.ranked);
	rankedLabel.append(rankedCb, element('span', { text: 'Ranked results' }));

	const mtfLabel = element('label', { className: 'checkbox-label' });
	const mtfCb = element('input', { type: 'checkbox' });
	mtfCb.name = 'includeMultiTimeframe';
	mtfCb.checked = Boolean(bodyExample.includeMultiTimeframe);
	mtfLabel.append(mtfCb, element('span', { text: 'Include multi-timeframe' }));
	flagsRow.append(rankedLabel, mtfLabel);
	form.append(flagsRow);

	const scheduleInput = addField(form, 'Schedule cadence (optional)', 'schedule', {
		placeholder: 'e.g. 1h, 4h, 1d',
		value: (bodyExample.schedule && (bodyExample.schedule.cadence || (bodyExample.schedule.cadenceMs && `${Math.round(bodyExample.schedule.cadenceMs / 60000)}m`))) || '',
	});

	const advancedDetails = element('details', { className: 'raw-status' });
	advancedDetails.append(element('summary', { text: 'Advanced request body' }));
	addJsonField(advancedDetails, 'Request body JSON', 'body', bodyExample);
	form.append(advancedDetails);

	const syncBody = () => {
		if (isAdvancedDirty) return undefined;
		const name = (nameInput.value || '').trim();
		const exchange = (exchangeInput.value || '').trim() || 'BINANCE';
		const timeframe = timeframeSelect.value || '4h';
		const rawLimit = parseInt(limitInput.value, 10);
		const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 5;
		const selectedScans = scanInputs.filter((cb) => cb.checked).map((cb) => cb.value);
		const bbw = parseFloat(bbwInput.value);
		const ranked = Boolean(rankedCb.checked);
		const includeMultiTimeframe = Boolean(mtfCb.checked);
		const schedule = (scheduleInput.value || '').trim();

		const payload = {
			name,
			exchange,
			timeframe,
			scans: selectedScans.length ? selectedScans : ['top_gainers', 'top_losers', 'volume_breakout_scanner'],
			limit,
		};
		if (Number.isFinite(bbw)) payload.bbwThreshold = bbw;
		if (ranked) payload.ranked = true;
		if (includeMultiTimeframe) payload.includeMultiTimeframe = true;
		if (schedule) payload.schedule = { enabled: true, cadence: schedule };

		if (form.elements.body) {
			form.elements.body.value = JSON.stringify(payload, null, 2);
		}
		return payload;
	};

	[nameInput, exchangeInput, limitInput, bbwInput, scheduleInput].forEach((input) => {
		input.addEventListener('input', () => {
			isAdvancedDirty = false;
			syncBody();
		});
	});
	[timeframeSelect, rankedCb, mtfCb, ...scanInputs].forEach((input) => {
		input.addEventListener('change', () => {
			isAdvancedDirty = false;
			syncBody();
		});
	});

	if (form.elements.body) {
		form.elements.body.addEventListener('input', () => {
			isAdvancedDirty = true;
		});
	}

	form.populatePreset = (preset) => {
		isAdvancedDirty = false;
		if (form.elements['path-id'] && preset.id) {
			form.elements['path-id'].value = preset.id;
		}
		nameInput.value = preset.name || '';
		exchangeInput.value = preset.exchange || 'BINANCE';
		timeframeSelect.value = preset.timeframe || '4h';
		limitInput.value = preset.limit || 5;
		bbwInput.value = preset.bbwThreshold !== undefined && preset.bbwThreshold !== null ? preset.bbwThreshold : '';
		rankedCb.checked = Boolean(preset.ranked);
		mtfCb.checked = Boolean(preset.includeMultiTimeframe);
		scheduleInput.value = (preset.schedule && (preset.schedule.cadence || (preset.schedule.cadenceMs && `${Math.round(preset.schedule.cadenceMs / 60000)}m`))) || '';
		const targetScans = Array.isArray(preset.scans) ? preset.scans : [];
		scanInputs.forEach((cb) => {
			cb.checked = targetScans.includes(cb.value);
		});
		syncBody();
	};

	syncBody();
};

const createOperationForm = (contract, definition, options = {}) => {
	const operation = getOperation(contract, definition);
	const form = element('form', { className: 'operation-card' });
	const title = element('h3', { text: definition.label });
	const route = element('code', { text: `${definition.method} ${definition.path}` });
	form.append(title, route);
	const pathNames = addPathFields(form, definition.path);

	const isPresetUpsert = (definition.path === '/api/scanner-presets' && definition.method === 'POST') ||
		(definition.path === '/api/scanner-presets/{id}' && definition.method === 'PUT');

	if (definition.method === 'GET' || getParameters(contract, operation).some((parameter) => parameter.in === 'query')) {
		addJsonField(form, 'Query JSON', 'query', getQueryExample(contract, operation));
	}
	if (isPresetUpsert) {
		addPresetStructuredFields(form, contract, operation);
	} else if (definition.method !== 'GET' && operation && operation.requestBody) {
		addJsonField(form, 'Request body JSON', 'body', getBodyExample(contract, operation));
	}

	const button = element('button', { text: definition.label });
	button.type = 'submit';
	if (definition.confirm) button.className = 'destructive-action';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	const hasStructuredResult = typeof definition.renderSuccess === 'function';
	const resultHost = hasStructuredResult ? element('div') : null;
	let lastRawJson = '';
	let rawOutputEl = null;
	let rawCopyButton = null;
	if (hasStructuredResult) {
		rawOutputEl = element('pre', { className: 'response-block' });
		rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
		rawCopyButton.hidden = true;
		const rawToggle = element('details', { className: 'raw-status' });
		rawToggle.append(
			element('summary', { text: 'Show raw response' }),
			rawCopyButton,
			rawOutputEl,
		);
		form.append(button, resultHost, output, rawToggle);
	} else {
		form.append(button, output);
	}
	form.addEventListener('submit', (event) => {
		event.preventDefault();
		if (resultHost) resultHost.replaceChildren();
		if (rawCopyButton) {
			lastRawJson = '';
			rawOutputEl.textContent = '';
			rawCopyButton.hidden = true;
		}
		try {
			const query = form.elements.query
				? window.CabrosAdminRequest.validateQuery(parseJson(form.elements.query.value, 'Query'))
				: undefined;
			const body = getRequestBody(definition, form);
			Promise.resolve(sendRequest({
				definition,
				path: fillPath(definition.path, pathNames, form),
				query,
				body,
				button,
				output,
				formatResponse: hasStructuredResult
					? ({ summary, status, elapsed }) => `${summary}\nHTTP ${status} · ${elapsed} ms`
					: undefined,
			})).then((data) => {
				if (options && typeof options.onStorageUpdate === 'function' && data && data.storage) {
					options.onStorageUpdate(data.storage);
				}
				if (options && typeof options.onSuccess === 'function' && data) {
					options.onSuccess(data);
				}
				if (!resultHost) return;
				if (!data) {
					resultHost.replaceChildren();
					rawOutputEl.textContent = '';
					rawCopyButton.hidden = true;
					return;
				}
				lastRawJson = JSON.stringify(data, null, 2);
				rawOutputEl.textContent = lastRawJson;
				rawCopyButton.hidden = false;
				const rendered = definition.renderSuccess(data);
				resultHost.replaceChildren(...(rendered ? [rendered] : []));
			}).catch(() => {});
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

const getBodySchema = (contract, operation) => {
	const requestBody = resolveRef(contract, operation && operation.requestBody);
	const json = requestBody && requestBody.content && requestBody.content['application/json'];
	if (!json || !json.schema) return null;
	return resolveRef(contract, json.schema);
};

const getQueryEnumValues = (contract, definition, paramName) => {
	const operation = getOperation(contract, definition);
	const parameter = getParameters(contract, operation).find((p) => p.name === paramName);
	if (!parameter || !parameter.schema) return [];
	if (Array.isArray(parameter.schema.enum)) return parameter.schema.enum;
	if (parameter.schema.items && Array.isArray(parameter.schema.items.enum)) {
		return parameter.schema.items.enum;
	}
	return [];
};

const getBodySchemaEnum = (contract, operation, propertyName) => {
	const schema = getBodySchema(contract, operation);
	if (!schema || !schema.properties || !schema.properties[propertyName]) return [];
	const prop = resolveRef(contract, schema.properties[propertyName]);
	if (Array.isArray(prop.enum)) return prop.enum;
	if (prop.items) {
		const items = resolveRef(contract, prop.items);
		if (items && Array.isArray(items.enum)) return items.enum;
	}
	return [];
};

const createStructuredAnalysisForm = (contract, definition, builder) => {
	const operation = getOperation(contract, definition);
	const form = element('form', { className: 'operation-card structured-form' });
	const title = element('h3', { text: definition.label });
	const route = element('code', { text: `${definition.method} ${definition.path}` });
	form.append(title, route);
	const pathNames = addPathFields(form, definition.path);

	const isGet = definition.method === 'GET';
	const fields = element('div', { className: 'form-fields' });
	const builderResult = (builder && builder(contract, operation, fields, definition)) || {};

	let isAdvancedDirty = false;
	const bodyExample = getBodyExample(contract, operation) || {};

	if (!isGet) {
		const advancedDetails = element('details', { className: 'raw-status' });
		advancedDetails.append(element('summary', { text: 'Advanced request body' }));
		addJsonField(advancedDetails, 'Request body JSON', 'body', bodyExample);
		form.append(fields, advancedDetails);
	} else {
		form.append(fields);
	}

	const syncBody = () => {
		if (isGet || isAdvancedDirty || !form.elements.body) return undefined;
		let payload = {};
		if (typeof builderResult.getBody === 'function') {
			try {
				payload = builderResult.getBody();
			} catch (_) {
				return undefined;
			}
		}
		form.elements.body.value = JSON.stringify(payload, null, 2);
		return payload;
	};

	if (!isGet && form.elements.body) {
		form.elements.body.addEventListener('input', () => {
			isAdvancedDirty = true;
		});

		fields.addEventListener('input', () => {
			isAdvancedDirty = false;
			syncBody();
		});
		fields.addEventListener('change', () => {
			isAdvancedDirty = false;
			syncBody();
		});

		if (Array.isArray(builderResult.inputs)) {
			builderResult.inputs.forEach((input) => {
				if (input && typeof input.addEventListener === 'function') {
					input.addEventListener('input', () => {
						isAdvancedDirty = false;
						syncBody();
					});
					input.addEventListener('change', () => {
						isAdvancedDirty = false;
						syncBody();
					});
				}
			});
		}

		syncBody();
	}

	const button = element('button', { text: definition.label });
	button.type = 'submit';
	if (definition.confirm) button.className = 'destructive-action';
	const output = element('pre', { className: 'response-block', text: 'No request sent.' });
	const hasStructuredResult = typeof definition.renderSuccess === 'function';
	const resultHost = hasStructuredResult ? element('div') : null;
	let lastRawJson = '';
	let rawOutputEl = null;
	let rawCopyButton = null;

	if (hasStructuredResult) {
		rawOutputEl = element('pre', { className: 'response-block' });
		rawCopyButton = createCopyButton(() => lastRawJson, 'Copy JSON');
		rawCopyButton.hidden = true;
		const rawToggle = element('details', { className: 'raw-status' });
		rawToggle.append(
			element('summary', { text: 'Show raw response' }),
			rawCopyButton,
			rawOutputEl,
		);
		form.append(button, resultHost, output, rawToggle);
	} else {
		form.append(button, output);
	}

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		if (resultHost) resultHost.replaceChildren();
		if (rawCopyButton) {
			lastRawJson = '';
			rawOutputEl.textContent = '';
			rawCopyButton.hidden = true;
		}

		try {
			let query;
			let body;

			if (isGet) {
				if (typeof builderResult.getQuery === 'function') {
					query = builderResult.getQuery();
				} else if (form.elements.query) {
					query = window.CabrosAdminRequest.validateQuery(parseJson(form.elements.query.value, 'Query'));
				}
			} else {
				if (!isAdvancedDirty && typeof builderResult.validate === 'function') {
					const validationError = builderResult.validate();
					if (validationError) {
						showError(output, validationError);
						return;
					}
				}
				const input = form.elements.body;
				body = input ? parseJson(input.value, 'Request body') : undefined;
				body = withReplayIdempotencyKey(definition, body);
				if (input && body && body.replayIdempotencyKey) {
					input.value = JSON.stringify(body, null, 2);
				}
			}

			Promise.resolve(sendRequest({
				definition,
				path: fillPath(definition.path, pathNames, form),
				query,
				body,
				button,
				output,
				formatResponse: hasStructuredResult
					? ({ summary, status, elapsed }) => `${summary}\nHTTP ${status} · ${elapsed} ms`
					: undefined,
			})).then((data) => {
				if (!resultHost) return;
				if (!data) {
					resultHost.replaceChildren();
					rawOutputEl.textContent = '';
					rawCopyButton.hidden = true;
					return;
				}
				lastRawJson = JSON.stringify(data, null, 2);
				rawOutputEl.textContent = lastRawJson;
				rawCopyButton.hidden = false;
				const rendered = definition.renderSuccess(data);
				resultHost.replaceChildren(...(rendered ? [rendered] : []));
			}).catch(() => {});
		} catch (error) {
			showError(output, error.message);
		}
	});

	return form;
};

const buildExpandedAnalysisForm = (contract, operation, fields) => {
	const bodyExample = getBodyExample(contract, operation) || {};
	const timeframeEnum = getBodySchemaEnum(contract, operation, 'timeframe');
	const analysisModeEnum = getBodySchemaEnum(contract, operation, 'analysisMode');
	const channelsEnum = getBodySchemaEnum(contract, operation, 'channels');

	const initialSymbols = Array.isArray(bodyExample.symbols) && bodyExample.symbols.length
		? bodyExample.symbols.join('\n')
		: (bodyExample.symbol || 'BINANCE:BTCUSDT');

	const symbolsInput = addField(fields, 'Symbols (EXCHANGE:SYMBOL, one per line)', 'symbols', {
		tag: 'textarea',
		rows: 4,
		placeholder: 'BINANCE:BTCUSDT\nNASDAQ:NVDA',
		value: initialSymbols,
	});

	const feedback = element('div', { className: 'field-feedback' });
	fields.append(feedback);

	const timeframeSelect = addField(fields, 'Timeframe', 'timeframe', { tag: 'select' });
	const availableTimeframes = timeframeEnum.length ? timeframeEnum : ['5m', '15m', '1h', '4h', '1D', '1W', '1M'];
	availableTimeframes.forEach((tf) => {
		const opt = element('option', { text: tf });
		opt.value = tf;
		timeframeSelect.append(opt);
	});
	timeframeSelect.value = bodyExample.timeframe || (availableTimeframes.includes('1D') ? '1D' : availableTimeframes[0]);

	const analysisModeSelect = addField(fields, 'Analysis mode', 'analysisMode', { tag: 'select' });
	const availableModes = analysisModeEnum.length ? analysisModeEnum : ['standard', 'combined'];
	availableModes.forEach((mode) => {
		const opt = element('option', { text: mode });
		opt.value = mode;
		analysisModeSelect.append(opt);
	});
	analysisModeSelect.value = bodyExample.analysisMode || 'standard';

	const includeMTF = addField(fields, 'Include multi-timeframe analysis', 'includeMultiTimeframe', {
		type: 'checkbox',
	});
	includeMTF.checked = Boolean(bodyExample.includeMultiTimeframe);

	const dryRun = addField(fields, 'Dry run (simulate without sending alerts)', 'dryRun', {
		type: 'checkbox',
	});
	dryRun.checked = Boolean(bodyExample.dryRun);

	const channelsFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	channelsFieldset.append(element('legend', { text: 'Notification channels' }));
	const availableChannels = channelsEnum.length ? channelsEnum : ['telegram', 'whatsapp', 'discord'];
	const channelInputs = [];
	const initialChannels = Array.isArray(bodyExample.channels) ? bodyExample.channels : [];
	availableChannels.forEach((ch) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `channel_${ch}`;
		cb.value = ch;
		cb.checked = initialChannels.includes(ch);
		label.append(cb, element('span', { text: ch.charAt(0).toUpperCase() + ch.slice(1) }));
		channelsFieldset.append(label);
		channelInputs.push(cb);
	});
	fields.append(channelsFieldset);

	const tgChatInput = addField(fields, 'Telegram Chat ID (optional)', 'telegramChatId', {
		value: bodyExample.telegramChatId || '',
	});
	const tgThreadInput = addField(fields, 'Telegram Thread ID (optional, 0 for general)', 'telegramThreadId', {
		type: 'number',
		min: 0,
		value: bodyExample.telegramThreadId !== undefined ? bodyExample.telegramThreadId : '',
	});
	const waChatInput = addField(fields, 'WhatsApp Chat ID (optional)', 'whatsappChatId', {
		value: bodyExample.whatsappChatId || '',
	});

	const validate = () => {
		const text = (symbolsInput.value || '').trim();
		if (!text) {
			feedback.textContent = 'At least one symbol is required.';
			feedback.className = 'field-feedback error';
			return 'At least one symbol is required.';
		}
		const symbols = text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
		const invalid = symbols.filter((s) => !SYMBOL_PATTERN.test(s));
		if (invalid.length > 0) {
			const msg = `Malformed symbol(s): ${invalid.join(', ')}. Expected EXCHANGE:SYMBOL format (e.g. BINANCE:BTCUSDT).`;
			feedback.textContent = msg;
			feedback.className = 'field-feedback error';
			return msg;
		}
		feedback.textContent = '';
		feedback.className = 'field-feedback';
		return null;
	};

	symbolsInput.addEventListener('input', validate);

	const getBody = () => {
		const text = (symbolsInput.value || '').trim();
		const symbols = text ? text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean) : [];
		const selectedChannels = channelInputs.filter((cb) => cb.checked).map((cb) => cb.value);
		const payload = {
			symbols,
			timeframe: timeframeSelect.value,
			analysisMode: analysisModeSelect.value,
		};
		if (includeMTF.checked) payload.includeMultiTimeframe = true;
		if (dryRun.checked) payload.dryRun = true;
		if (selectedChannels.length > 0) payload.channels = selectedChannels;
		const tgChat = (tgChatInput.value || '').trim();
		if (tgChat) payload.telegramChatId = tgChat;
		const tgThread = (tgThreadInput.value || '').trim();
		if (tgThread !== '') payload.telegramThreadId = parseInt(tgThread, 10);
		const waChat = (waChatInput.value || '').trim();
		if (waChat) payload.whatsappChatId = waChat;
		return payload;
	};

	return {
		getBody,
		validate,
		inputs: [symbolsInput, timeframeSelect, analysisModeSelect, includeMTF, dryRun, ...channelInputs, tgChatInput, tgThreadInput, waChatInput],
	};
};

const buildMarketScannerForm = (contract, operation, fields) => {
	const bodyExample = getBodyExample(contract, operation) || {};
	const timeframeEnum = getBodySchemaEnum(contract, operation, 'timeframe');
	const scansEnum = getBodySchemaEnum(contract, operation, 'scans');
	const channelsEnum = getBodySchemaEnum(contract, operation, 'channels');

	const exchangeInput = addField(fields, 'Exchange', 'exchange', {
		placeholder: 'BINANCE',
		value: bodyExample.exchange || 'BINANCE',
	});

	const timeframeSelect = addField(fields, 'Timeframe', 'timeframe', { tag: 'select' });
	const availableTimeframes = timeframeEnum.length ? timeframeEnum : ['15m', '1h', '4h', '1D'];
	availableTimeframes.forEach((tf) => {
		const opt = element('option', { text: tf });
		opt.value = tf;
		timeframeSelect.append(opt);
	});
	timeframeSelect.value = bodyExample.timeframe || (availableTimeframes.includes('4h') ? '4h' : availableTimeframes[0]);

	const scansFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	scansFieldset.append(element('legend', { text: 'Scans' }));
	const availableScans = scansEnum.length ? scansEnum : ['top_gainers', 'top_losers', 'volume_breakout_scanner', 'smart_volume_scanner', 'bollinger_scan'];
	const scanInputs = [];
	const initialScans = Array.isArray(bodyExample.scans) && bodyExample.scans.length
		? bodyExample.scans
		: ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
	availableScans.forEach((scan) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `scan_${scan}`;
		cb.value = scan;
		cb.checked = initialScans.includes(scan);
		label.append(cb, element('span', { text: scan.replace(/_/g, ' ') }));
		scansFieldset.append(label);
		scanInputs.push(cb);
	});
	fields.append(scansFieldset);

	const limitInput = addField(fields, 'Scan limit (1-20)', 'limit', {
		type: 'number',
		min: 1,
		max: 20,
		value: bodyExample.limit || 5,
	});

	const bbwInput = addField(fields, 'BBW threshold', 'bbw_threshold', {
		type: 'number',
		step: '0.01',
		value: bodyExample.bbw_threshold !== undefined ? bodyExample.bbw_threshold : 0.05,
	});

	const ratingInput = addField(fields, 'Rating (-3 to 3)', 'rating', {
		type: 'number',
		min: -3,
		max: 3,
		value: bodyExample.rating !== undefined ? bodyExample.rating : 3,
	});

	const patternSelect = addField(fields, 'Pattern type', 'pattern_type', { tag: 'select' });
	['bullish', 'bearish'].forEach((pt) => {
		const opt = element('option', { text: pt });
		opt.value = pt;
		patternSelect.append(opt);
	});
	patternSelect.value = bodyExample.pattern_type || 'bullish';

	const candleInput = addField(fields, 'Candle count (2-5)', 'candle_count', {
		type: 'number',
		min: 2,
		max: 5,
		value: bodyExample.candle_count || 3,
	});

	const minGrowthInput = addField(fields, 'Min growth (optional)', 'min_growth', {
		type: 'number',
		step: '0.01',
		value: bodyExample.min_growth !== undefined ? bodyExample.min_growth : '',
	});

	const maxDeclineInput = addField(fields, 'Max decline (optional)', 'max_decline', {
		type: 'number',
		step: '0.01',
		value: bodyExample.max_decline !== undefined ? bodyExample.max_decline : '',
	});

	const rankedCb = addField(fields, 'Ranked results', 'ranked', { type: 'checkbox' });
	rankedCb.checked = Boolean(bodyExample.ranked);

	const mtfCb = addField(fields, 'Include multi-timeframe', 'includeMultiTimeframe', { type: 'checkbox' });
	mtfCb.checked = Boolean(bodyExample.includeMultiTimeframe);

	const dryRunCb = addField(fields, 'Dry run (simulate without sending alerts)', 'dryRun', { type: 'checkbox' });
	dryRunCb.checked = Boolean(bodyExample.dryRun);

	const channelsFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	channelsFieldset.append(element('legend', { text: 'Notification channels' }));
	const availableChannels = channelsEnum.length ? channelsEnum : ['telegram', 'whatsapp', 'discord'];
	const channelInputs = [];
	const initialChannels = Array.isArray(bodyExample.channels) ? bodyExample.channels : [];
	availableChannels.forEach((ch) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `channel_${ch}`;
		cb.value = ch;
		cb.checked = initialChannels.includes(ch);
		label.append(cb, element('span', { text: ch.charAt(0).toUpperCase() + ch.slice(1) }));
		channelsFieldset.append(label);
		channelInputs.push(cb);
	});
	fields.append(channelsFieldset);

	const tgChatInput = addField(fields, 'Telegram Chat ID (optional)', 'telegramChatId', {
		value: bodyExample.telegramChatId || '',
	});
	const tgThreadInput = addField(fields, 'Telegram Thread ID (optional, 0 for general)', 'telegramThreadId', {
		type: 'number',
		min: 0,
		value: bodyExample.telegramThreadId !== undefined ? bodyExample.telegramThreadId : '',
	});
	const waChatInput = addField(fields, 'WhatsApp Chat ID (optional)', 'whatsappChatId', {
		value: bodyExample.whatsappChatId || '',
	});

	const getBody = () => {
		const exchange = (exchangeInput.value || '').trim() || 'BINANCE';
		const timeframe = timeframeSelect.value || '4h';
		const selectedScans = scanInputs.filter((cb) => cb.checked).map((cb) => cb.value);
		const rawLimit = parseInt(limitInput.value, 10);
		const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(20, rawLimit)) : 5;
		const bbw = parseFloat(bbwInput.value);
		const rating = parseInt(ratingInput.value, 10);
		const candleCount = parseInt(candleInput.value, 10);
		const minGrowth = parseFloat(minGrowthInput.value);
		const maxDecline = parseFloat(maxDeclineInput.value);
		const selectedChannels = channelInputs.filter((cb) => cb.checked).map((cb) => cb.value);

		const payload = {
			exchange,
			timeframe,
			scans: selectedScans.length ? selectedScans : ['top_gainers', 'top_losers', 'volume_breakout_scanner'],
			limit,
			pattern_type: patternSelect.value || 'bullish',
		};
		if (Number.isFinite(bbw)) payload.bbw_threshold = bbw;
		if (Number.isFinite(rating)) payload.rating = rating;
		if (Number.isFinite(candleCount)) payload.candle_count = candleCount;
		if (Number.isFinite(minGrowth)) payload.min_growth = minGrowth;
		if (Number.isFinite(maxDecline)) payload.max_decline = maxDecline;
		if (rankedCb.checked) payload.ranked = true;
		if (mtfCb.checked) payload.includeMultiTimeframe = true;
		if (dryRunCb.checked) payload.dryRun = true;
		if (selectedChannels.length > 0) payload.channels = selectedChannels;
		const tgChat = (tgChatInput.value || '').trim();
		if (tgChat) payload.telegramChatId = tgChat;
		const tgThread = (tgThreadInput.value || '').trim();
		if (tgThread !== '') payload.telegramThreadId = parseInt(tgThread, 10);
		const waChat = (waChatInput.value || '').trim();
		if (waChat) payload.whatsappChatId = waChat;
		return payload;
	};

	return {
		getBody,
		inputs: [
			exchangeInput, timeframeSelect, ...scanInputs, limitInput, bbwInput,
			ratingInput, patternSelect, candleInput, minGrowthInput, maxDeclineInput,
			rankedCb, mtfCb, dryRunCb, ...channelInputs, tgChatInput, tgThreadInput, waChatInput,
		],
	};
};

const buildVolumeConfirmationForm = (contract, operation, fields) => {
	const bodyExample = getBodyExample(contract, operation) || {};
	const timeframeEnum = getBodySchemaEnum(contract, operation, 'timeframe');

	const symbolInput = addField(fields, 'Symbol (EXCHANGE:SYMBOL)', 'symbol', {
		placeholder: 'BINANCE:BTCUSDT',
		value: bodyExample.symbol || 'BINANCE:BTCUSDT',
	});

	const feedback = element('div', { className: 'field-feedback' });
	fields.append(feedback);

	let timeframeControl;
	if (timeframeEnum.length > 0) {
		timeframeControl = addField(fields, 'Timeframe', 'timeframe', { tag: 'select' });
		timeframeEnum.forEach((tf) => {
			const opt = element('option', { text: tf });
			opt.value = tf;
			timeframeControl.append(opt);
		});
		timeframeControl.value = bodyExample.timeframe || timeframeEnum[0];
	} else {
		timeframeControl = addField(fields, 'Timeframe', 'timeframe', {
			placeholder: '1h',
			value: bodyExample.timeframe || '1h',
		});
	}

	const validate = () => {
		const sym = (symbolInput.value || '').trim();
		if (!sym) {
			feedback.textContent = 'Symbol is required.';
			feedback.className = 'field-feedback error';
			return 'Symbol is required.';
		}
		if (!SYMBOL_PATTERN.test(sym)) {
			const msg = `Malformed symbol: "${sym}". Expected EXCHANGE:SYMBOL format (e.g. BINANCE:BTCUSDT).`;
			feedback.textContent = msg;
			feedback.className = 'field-feedback error';
			return msg;
		}
		feedback.textContent = '';
		feedback.className = 'field-feedback';
		return null;
	};

	symbolInput.addEventListener('input', validate);

	const getBody = () => ({
		symbol: (symbolInput.value || '').trim(),
		timeframe: (timeframeControl.value || '').trim() || '1h',
	});

	return {
		getBody,
		validate,
		inputs: [symbolInput, timeframeControl],
	};
};

const buildSymbolAnalysisForm = (contract, operation, fields) => {
	const bodyExample = getBodyExample(contract, operation) || {};
	const timeframeEnum = getBodySchemaEnum(contract, operation, 'timeframe');
	const analysisModeEnum = getBodySchemaEnum(contract, operation, 'analysisMode');

	const symbolInput = addField(fields, 'Symbol (EXCHANGE:SYMBOL)', 'symbol', {
		placeholder: 'BINANCE:BTCUSDT',
		value: bodyExample.symbol || 'BINANCE:BTCUSDT',
	});

	const feedback = element('div', { className: 'field-feedback' });
	fields.append(feedback);

	let timeframeControl;
	if (timeframeEnum.length > 0) {
		timeframeControl = addField(fields, 'Timeframe', 'timeframe', { tag: 'select' });
		timeframeEnum.forEach((tf) => {
			const opt = element('option', { text: tf });
			opt.value = tf;
			timeframeControl.append(opt);
		});
		timeframeControl.value = bodyExample.timeframe || (timeframeEnum.includes('1D') ? '1D' : timeframeEnum[0]);
	} else {
		timeframeControl = addField(fields, 'Timeframe', 'timeframe', {
			placeholder: '1D',
			value: bodyExample.timeframe || '1D',
		});
	}

	const analysisModeSelect = addField(fields, 'Analysis mode', 'analysisMode', { tag: 'select' });
	const availableModes = analysisModeEnum.length ? analysisModeEnum : ['standard', 'combined'];
	availableModes.forEach((mode) => {
		const opt = element('option', { text: mode });
		opt.value = mode;
		analysisModeSelect.append(opt);
	});
	analysisModeSelect.value = bodyExample.analysisMode || 'standard';

	const validate = () => {
		const sym = (symbolInput.value || '').trim();
		if (!sym) {
			feedback.textContent = 'Symbol is required.';
			feedback.className = 'field-feedback error';
			return 'Symbol is required.';
		}
		if (!SYMBOL_PATTERN.test(sym)) {
			const msg = `Malformed symbol: "${sym}". Expected EXCHANGE:SYMBOL format (e.g. BINANCE:BTCUSDT).`;
			feedback.textContent = msg;
			feedback.className = 'field-feedback error';
			return msg;
		}
		feedback.textContent = '';
		feedback.className = 'field-feedback';
		return null;
	};

	symbolInput.addEventListener('input', validate);

	const getBody = () => ({
		symbol: (symbolInput.value || '').trim(),
		timeframe: (timeframeControl.value || '').trim() || '1D',
		analysisMode: analysisModeSelect.value || 'standard',
	});

	return {
		getBody,
		validate,
		inputs: [symbolInput, timeframeControl, analysisModeSelect],
	};
};

const buildNewsMonitorForm = (contract, operation, fields, definition) => {
	const isGet = definition.method === 'GET';

	if (isGet) {
		const queryExample = getQueryExample(contract, operation) || {};
		const cryptoInput = addField(fields, 'Crypto symbols (comma-separated)', 'crypto', {
			placeholder: 'BTCUSDT,ETHUSDT',
			value: queryExample.crypto || 'BTCUSDT',
		});
		const stocksInput = addField(fields, 'Stock symbols (comma-separated)', 'stocks', {
			placeholder: 'NVDA,MSFT',
			value: queryExample.stocks || 'NVDA',
		});
		const dryRunCb = addField(fields, 'Dry run (analyze only, no delivery)', 'dryRun', { type: 'checkbox' });
		dryRunCb.checked = Boolean(queryExample.dryRun);

		return {
			getQuery: () => {
				const query = {};
				const crypto = (cryptoInput.value || '').trim();
				const stocks = (stocksInput.value || '').trim();
				if (crypto) query.crypto = crypto;
				if (stocks) query.stocks = stocks;
				if (dryRunCb.checked) query.dryRun = true;
				return query;
			},
			inputs: [cryptoInput, stocksInput, dryRunCb],
		};
	}

	const bodyExample = getBodyExample(contract, operation) || {};
	const channelsEnum = getBodySchemaEnum(contract, operation, 'channels');

	const initialCrypto = Array.isArray(bodyExample.crypto)
		? bodyExample.crypto.join(',')
		: (bodyExample.crypto || 'BTCUSDT');
	const initialStocks = Array.isArray(bodyExample.stocks)
		? bodyExample.stocks.join(',')
		: (bodyExample.stocks || 'NVDA');

	const cryptoInput = addField(fields, 'Crypto symbols (comma-separated)', 'crypto', {
		placeholder: 'BTCUSDT,ETHUSDT',
		value: initialCrypto,
	});
	const stocksInput = addField(fields, 'Stock symbols (comma-separated)', 'stocks', {
		placeholder: 'NVDA,MSFT',
		value: initialStocks,
	});
	const dryRunCb = addField(fields, 'Dry run (analyze only, no delivery)', 'dryRun', { type: 'checkbox' });
	dryRunCb.checked = Boolean(bodyExample.dryRun);

	const channelsFieldset = element('fieldset', { className: 'preset-scans-fieldset' });
	channelsFieldset.append(element('legend', { text: 'Notification channels' }));
	const availableChannels = channelsEnum.length ? channelsEnum : ['telegram', 'whatsapp', 'discord'];
	const channelInputs = [];
	const initialChannels = Array.isArray(bodyExample.channels) ? bodyExample.channels : [];
	availableChannels.forEach((ch) => {
		const label = element('label', { className: 'checkbox-label' });
		const cb = element('input', { type: 'checkbox' });
		cb.name = `channel_${ch}`;
		cb.value = ch;
		cb.checked = initialChannels.includes(ch);
		label.append(cb, element('span', { text: ch.charAt(0).toUpperCase() + ch.slice(1) }));
		channelsFieldset.append(label);
		channelInputs.push(cb);
	});
	fields.append(channelsFieldset);

	const tgChatInput = addField(fields, 'Telegram Chat ID (optional)', 'telegramChatId', {
		value: bodyExample.telegramChatId || '',
	});
	const tgThreadInput = addField(fields, 'Telegram Thread ID (optional, 0 for general)', 'telegramThreadId', {
		type: 'number',
		min: 0,
		value: bodyExample.telegramThreadId !== undefined ? bodyExample.telegramThreadId : '',
	});
	const waChatInput = addField(fields, 'WhatsApp Chat ID (optional)', 'whatsappChatId', {
		value: bodyExample.whatsappChatId || '',
	});

	const getBody = () => {
		const crypto = (cryptoInput.value || '').trim();
		const stocks = (stocksInput.value || '').trim();
		const selectedChannels = channelInputs.filter((cb) => cb.checked).map((cb) => cb.value);
		const payload = {};
		if (crypto) payload.crypto = crypto.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
		if (stocks) payload.stocks = stocks.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
		if (dryRunCb.checked) payload.dryRun = true;
		if (selectedChannels.length > 0) payload.channels = selectedChannels;
		const tgChat = (tgChatInput.value || '').trim();
		if (tgChat) payload.telegramChatId = tgChat;
		const tgThread = (tgThreadInput.value || '').trim();
		if (tgThread !== '') payload.telegramThreadId = parseInt(tgThread, 10);
		const waChat = (waChatInput.value || '').trim();
		if (waChat) payload.whatsappChatId = waChat;
		return payload;
	};

	return {
		getBody,
		inputs: [cryptoInput, stocksInput, dryRunCb, ...channelInputs, tgChatInput, tgThreadInput, waChatInput],
	};
};

const renderView = async (name) => {
	const view = document.getElementById('view');
	if (typeof detachActiveViewPoll === 'function') detachActiveViewPoll();
	detachActiveViewPoll = null;
	view.replaceChildren(createLoadingState('Loading API contract…'));
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
		if (name === 'status') {
			view.append(createStatusExplorer());
			return;
		}
		view.append(element('h2', { text: name[0].toUpperCase() + name.slice(1) }));
		if (name === 'alerts') {
			view.append(createAlertListForm());
			view.append(createAlertSummaryForm(), createAlertExportForm());
			VIEW_ACTIONS.alerts.forEach((definition) => view.append(createOperationForm(contract, definition)));
			return;
		}
		if (name === 'outcomes') {
			view.append(createOutcomesListForm());
			view.append(createOutcomesSummaryForm());
			return;
		}
		if (name === 'jobs') {
			const status = createJobStatusForm();
			view.append(createJobListForm(contract, status.selectJob));
			VIEWS.jobs.forEach((definition) => view.append(createJobCreateForm(contract, definition, (jobId) => {
				status.selectJob(jobId, { autoLoad: true });
			})));
			view.append(status.form);
			return;
		}
		if (name === 'presets') {
			let updateForm = null;
			let listForm = null;
			const onEdit = (preset) => {
				if (updateForm && typeof updateForm.populatePreset === 'function') {
					updateForm.populatePreset(preset);
					if (typeof updateForm.scrollIntoView === 'function') {
						updateForm.scrollIntoView({ behavior: 'smooth' });
					}
					if (updateForm.elements?.name && typeof updateForm.elements.name.focus === 'function') {
						updateForm.elements.name.focus();
					}
				}
			};
			const onStorageUpdate = (storage) => {
				if (listForm && typeof listForm.updateStorage === 'function') {
					listForm.updateStorage(storage);
				}
			};
			const onPresetMutated = async (storage) => {
				if (storage) onStorageUpdate(storage);
				if (listForm && typeof listForm.refresh === 'function') {
					await listForm.refresh();
				}
			};
			listForm = createPresetListForm(contract, { onEdit, onStorageUpdate });
			view.append(listForm);

			VIEWS.presets.forEach((definition) => {
				if (definition.method === 'GET') return;
				const form = createOperationForm(contract, definition, {
					onStorageUpdate: onPresetMutated,
					onSuccess: () => {
						if (listForm && typeof listForm.refresh === 'function') listForm.refresh();
					},
				});
				view.append(form);
			});

			VIEW_ACTIONS.presets.forEach((definition) => {
				const form = createOperationForm(contract, definition, {
					onStorageUpdate: onPresetMutated,
					onSuccess: () => {
						if (listForm && typeof listForm.refresh === 'function') listForm.refresh();
					},
				});
				if (definition.method === 'PUT') {
					updateForm = form;
				}
				view.append(form);
			});
			return;
		}
		if (name === 'analysis') {
			const definitions = [...(VIEWS[name] || []), ...(VIEW_ACTIONS[name] || [])];
			definitions.forEach((definition) => {
				const path = definition.path;
				if (path === '/api/webhook/expanded-analysis-alert') {
					view.append(createStructuredAnalysisForm(contract, definition, buildExpandedAnalysisForm));
				} else if (path === '/api/webhook/market-scanner-alert') {
					view.append(createStructuredAnalysisForm(contract, definition, buildMarketScannerForm));
				} else if (path === '/api/webhook/volume-confirmation') {
					view.append(createStructuredAnalysisForm(contract, definition, buildVolumeConfirmationForm));
				} else if (path === '/api/webhook/symbol-analysis') {
					view.append(createStructuredAnalysisForm(contract, definition, buildSymbolAnalysisForm));
				} else if (path === '/api/news-monitor') {
					view.append(createStructuredAnalysisForm(contract, definition, buildNewsMonitorForm));
				} else {
					view.append(createOperationForm(contract, definition));
				}
			});
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
	if (view) view.replaceChildren(createLoadingState('Checking authentication…'));
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
