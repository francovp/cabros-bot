'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const requestHelper = require('../../src/admin/admin-request');
const contract = require('../../src/openapi/openapi.json');

class FakeElement {
	constructor(tagName) {
		this.tagName = tagName.toUpperCase();
		this.children = [];
		this.dataset = {};
		this.listeners = {};
		this.attributes = {};
		this.className = '';
		this.value = '';
		this.disabled = false;
		this._text = '';
	}

	get textContent() {
		return this._text + this.children.map((child) => child.textContent).join('');
	}

	set textContent(value) {
		this._text = String(value);
		this.children = [];
	}

	get elements() {
		return new Proxy({}, {
			get: (_, name) => find(this, (node) => node.name === name),
		});
	}

	append(...nodes) {
		nodes.forEach((node) => {
			const selectFirstOption = this.tagName === 'SELECT' && this.children.length === 0;
			node.parentNode = this;
			this.children.push(node);
			if (selectFirstOption) this.value = node.value;
		});
	}

	replaceChildren(...nodes) {
		this.children = [];
		this._text = '';
		this.append(...nodes);
	}

	addEventListener(type, listener) {
		(this.listeners[type] ||= []).push(listener);
	}

	async dispatch(type) {
		const event = { preventDefault() {} };
		for (const listener of this.listeners[type] || []) await listener(event);
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}

	removeAttribute(name) {
		delete this.attributes[name];
	}

	querySelectorAll(selector) {
		if (selector === '[data-view]') return findAll(this, (node) => node.dataset.view);
		return [];
	}
}

const findAll = (root, predicate) => {
	const matches = predicate(root) ? [root] : [];
	return matches.concat(root.children.flatMap((child) => findAll(child, predicate)));
};

const find = (root, predicate) => findAll(root, predicate)[0];
const findForm = (root, route) => find(root, (node) => node.tagName === 'FORM' && node.textContent.includes(route));
const findButton = (root, text) => find(root, (node) => node.tagName === 'BUTTON' && node.textContent === text);
const flush = async () => {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
};

class FakeAbortSignal {
	constructor() {
		this.aborted = false;
		this.reason = undefined;
		this.listeners = [];
	}

	addEventListener(_type, listener) {
		this.listeners.push(listener);
	}
}

class FakeAbortController {
	constructor() {
		this.signal = new FakeAbortSignal();
	}

	abort(reason) {
		if (this.signal.aborted) return;
		this.signal.aborted = true;
		this.signal.reason = reason ?? new Error('The operation was aborted');
		this.signal.listeners.forEach((listener) => listener());
	}
}

const response = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
	text: async () => JSON.stringify(body),
});

function createBrowser({ fetchImpl, confirm = () => true, storedKey = '', firebase }) {
	const body = new FakeElement('body');
	const elementsById = {};
	[
		'legacy-connection', 'firebase-auth', 'auth-form', 'auth-email', 'auth-password', 'sign-in', 'sign-out',
		'auth-state', 'api-key', 'key-state', 'save-key', 'clear-key', 'connection-form', 'view',
	].forEach((id) => {
		const tag = id === 'api-key' ? 'input' : id === 'connection-form' ? 'form'
			: id === 'view' ? 'section' : id === 'auth-form' ? 'div' : id.endsWith('key') ? 'button' : 'p';
		const node = new FakeElement(tag);
		node.id = id;
		node.hidden = false;
		elementsById[id] = node;
		body.append(node);
	});
	['overview', 'status', 'alerts', 'presets', 'jobs', 'analysis', 'playground'].forEach((view) => {
		const button = new FakeElement('button');
		button.dataset.view = view;
		body.append(button);
	});

	const documentListeners = {};
	const downloads = [];
	const timers = new Map();
	const document = {
		body,
		createElement: (tag) => {
			const node = new FakeElement(tag);
			if (tag === 'a') node.click = () => downloads.push({ href: node.href, download: node.download });
			return node;
		},
		getElementById: (id) => elementsById[id],
		querySelectorAll: (selector) => body.querySelectorAll(selector),
		addEventListener: (type, listener) => { documentListeners[type] = listener; },
	};
	const storage = new Map(storedKey ? [['cabros-admin-api-key', storedKey]] : []);
	const helperCalls = [];
	const helper = {
		...requestHelper,
		createRequest: (input) => {
			helperCalls.push(input);
			return requestHelper.createRequest(input);
		},
	};
	const context = {
		document,
		fetch: jest.fn(async (url, options) => {
			if (url === '/admin/auth-config' && !firebase) return response({ enabled: false, configured: false });
			return fetchImpl(url, options);
		}),
		performance: { now: jest.fn().mockReturnValueOnce(10).mockReturnValue(20) },
		sessionStorage: {
			getItem: (key) => storage.get(key) || null,
			setItem: (key, value) => storage.set(key, value),
			removeItem: (key) => storage.delete(key),
		},
		AbortController: FakeAbortController,
		setTimeout: (fn) => {
			const id = timers.size + 1;
			timers.set(id, fn);
			return id;
		},
		clearTimeout: (id) => { timers.delete(id); },
		window: {
			CabrosAdminRequest: helper,
			confirm,
			firebase,
			URL: {
				createObjectURL: jest.fn((blob) => `blob:${blob.type}`),
				revokeObjectURL: jest.fn(),
			},
		},
	};
	vm.runInNewContext(
		fs.readFileSync(path.join(__dirname, '../../src/admin/admin.js'), 'utf8'),
		context,
	);
	documentListeners.DOMContentLoaded();

	return { body, context, elementsById, helperCalls, storage, downloads, timers };
}

async function selectView(browser, name) {
	await find(browser.body, (node) => node.dataset.view === name).dispatch('click');
	await flush();
}

describe('admin browser client', () => {
	it('renders an operational overview from the status response', async () => {
		const status = {
			service: {
				name: 'cabros-bot',
				version: '0.1.0',
				environment: 'production',
				commit: 'abc123',
			},
			featureFlags: {
				telegramBot: true,
				marketScanner: false,
				signalOutcomeTracking: true,
			},
			deliveryChannels: {
				telegram: { enabled: true, status: 'ready' },
				whatsapp: { enabled: false, status: 'disabled' },
			},
			dependencies: {
				telegram: { enabled: true, configured: true, ready: true, status: 'ready' },
				tradingViewMcp: { enabled: true, configured: false, ready: false, status: 'misconfigured' },
				sentry: { enabled: false, configured: false, ready: false, status: 'disabled' },
			},
		};
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/status') return response(status);
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'overview');
		await flush();

		const overview = browser.elementsById.view;
		expect(overview.textContent).toContain('Operational overview');
		expect(overview.textContent).toContain('production');
		expect(overview.textContent).toContain('2 enabled');
		expect(overview.textContent).toContain('1 ready');
		expect(overview.textContent).toContain('TradingView MCP');
		expect(overview.textContent).not.toContain('undefined');
	});

	it('waits for an API key before loading protected overview status', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				requests.push(url);
				if (url === '/openapi.json') return response(contract);
				return response({});
			},
		});
		await flush();

		expect(requests).toEqual(['/openapi.json']);
		expect(browser.elementsById.view.textContent).toContain('Enter an API key');
	});

	it('does not render an HTTP error payload as a healthy overview', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/status') return response({ error: 'Unauthorized' }, 401);
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'overview');

		const overview = browser.elementsById.view;
		expect(overview.textContent).toContain('Status unavailable. Check the API key and service logs.');
		expect(overview.textContent).not.toContain('Last checked');
		expect(overview.textContent).toContain('HTTP 401');
	});

	it('resolves authentication with fallback when the auth-config fetch stalls until timeout', async () => {
		const firebase = {
			initializeApp: jest.fn(),
			auth: jest.fn(),
		};
		const browser = createBrowser({
			firebase,
			fetchImpl: (url, options) => new Promise((resolve, reject) => {
				if (options.signal.aborted) {
					reject(new Error('AbortError'));
					return;
				}
				options.signal.addEventListener('abort', () => reject(new Error('AbortError')));
			}),
		});
		await flush();

		expect(browser.body.textContent).toContain('Checking authentication');
		expect(browser.timers.size).toBe(1);

		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();

		expect(browser.elementsById['auth-state'].textContent).toContain('Firebase sign-in is unavailable');
		expect(browser.timers.size).toBe(0);
	});

	it('shows Firebase sign-in state and sends a verified token after sign-in', async () => {
		let authStateChanged;
		const user = {
			getIdToken: jest.fn().mockResolvedValue('firebase-token'),
			getIdTokenResult: jest.fn().mockResolvedValue({ claims: { roles: ['admin.viewer'] } }),
		};
		const auth = {
			setPersistence: jest.fn().mockResolvedValue(undefined),
			onAuthStateChanged: jest.fn((listener) => {
				authStateChanged = listener;
				listener(null);
				return jest.fn();
			}),
			signInWithEmailAndPassword: jest.fn(async () => {
				await authStateChanged(user);
				return { user };
			}),
			signOut: jest.fn().mockResolvedValue(undefined),
		};
		const firebase = {
			initializeApp: jest.fn(),
			auth: jest.fn(() => auth),
		};
		const requests = [];
		const browser = createBrowser({
			firebase,
			fetchImpl: async (url, options) => {
				if (url === '/admin/auth-config') {
					return response({ enabled: true, configured: true, config: {
						apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros',
					} });
				}
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return response({});
			},
		});
		await flush();

		expect(browser.elementsById['firebase-auth'].hidden).toBe(false);
		expect(browser.elementsById['legacy-connection'].hidden).toBe(false);
		expect(browser.elementsById.view.textContent).toContain('Sign in');
		browser.elementsById['api-key'].value = 'webhook-key';
		await browser.elementsById['save-key'].dispatch('click');
		expect(browser.storage.has('cabros-admin-api-key')).toBe(false);
		expect(browser.elementsById['key-state'].textContent).toContain('in memory');

		browser.elementsById['auth-email'].value = 'operator@example.com';
		browser.elementsById['auth-password'].value = 'password';
		await browser.elementsById['sign-in'].dispatch('click');
		await flush();

		const statusViewButton = find(browser.body, (node) => node.dataset.view === 'status');
		const overviewViewButton = find(browser.body, (node) => node.dataset.view === 'overview');
		expect(statusViewButton.attributes['aria-current']).toBe('page');
		expect(overviewViewButton.attributes['aria-current']).toBeUndefined();
		const statusForm = findForm(browser.elementsById.view, 'GET /api/status');
		expect(statusForm).toBeDefined();
		await statusForm.dispatch('submit');
		await flush();
		expect(requests.at(-1)[1].headers.Authorization).toBe('Bearer firebase-token');

		browser.elementsById['api-key'].value = '';
		const statusRequestCount = requests.filter(([url]) => url === '/api/status').length;
		await selectView(browser, 'overview');
		expect(requests.filter(([url]) => url === '/api/status')).toHaveLength(statusRequestCount + 1);
		expect(browser.elementsById.view.textContent).toContain('Operational overview');

		await browser.elementsById['sign-out'].dispatch('click');
		expect(auth.signOut).toHaveBeenCalled();
		expect(browser.elementsById['api-key'].value).toBe('');
	});

	it('uses the current session key, redacts output, and cancels before dispatch', async () => {
		const events = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				events.push(['fetch', url, options]);
				if (url === '/openapi.json') return response(contract);
				return response({ echoed: 'current-secret' });
			},
			confirm: () => {
				events.push(['confirm']);
				return false;
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'current-secret';
		await browser.elementsById['save-key'].dispatch('click');

		await selectView(browser, 'status');
		const statusForm = findForm(browser.elementsById.view, 'GET /api/status');
		await statusForm.dispatch('submit');
		await flush();

		expect(browser.helperCalls.at(-1).apiKey).toBe('current-secret');
		expect(events.at(-1)[2].headers['x-api-key']).toBe('current-secret');
		expect(browser.storage.get('cabros-admin-api-key')).toBe('current-secret');
		expect(statusForm.textContent).toContain('[REDACTED]');
		expect(statusForm.textContent).not.toContain('current-secret');
		expect(events.filter(([type]) => type === 'fetch').every(([, url]) => !url.includes('current-secret'))).toBe(true);

		await selectView(browser, 'alerts');
		const replayForm = findForm(browser.elementsById.view, 'POST /api/alerts/{alertId}/replay');
		replayForm.elements['path-alertId'].value = 'alert-1';
		const fetchCount = events.filter(([type]) => type === 'fetch').length;
		await replayForm.dispatch('submit');
		await flush();
		expect(events.at(-1)).toEqual(['confirm']);
		expect(events.filter(([type]) => type === 'fetch')).toHaveLength(fetchCount);

		browser.context.window.confirm = () => {
			events.push(['confirm']);
			return true;
		};
		await replayForm.dispatch('submit');
		await flush();
		expect(events.slice(-2).map(([type]) => type)).toEqual(['confirm', 'fetch']);
		expect(browser.helperCalls.at(-1).body.idempotencyKey).toEqual(expect.any(String));
		expect(browser.helperCalls.at(-1).body.idempotencyKey).not.toBe('');
		const replayIdempotencyKey = browser.helperCalls.at(-1).body.idempotencyKey;
		await replayForm.dispatch('submit');
		await flush();
		expect(browser.helperCalls.at(-1).body.idempotencyKey).toBe(replayIdempotencyKey);
	});

	it('adds an idempotency key when Playground replays an alert', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'playground');

		const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
			&& node.textContent.includes('Playground'));
		const select = find(playground, (node) => node.tagName === 'SELECT');
		select.value = select.children.find((option) => option.textContent.includes('POST /api/alerts/{alertId}/replay')).value;
		await select.dispatch('change');
		playground.elements['path-alertId'].value = 'alert-1';
		await playground.dispatch('submit');
		await flush();

		expect(browser.helperCalls.at(-1).body.idempotencyKey).toEqual(expect.any(String));
	});

	it('preserves a supplied snake_case replay idempotency key', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'alerts');

		const replayForm = findForm(browser.elementsById.view, 'POST /api/alerts/{alertId}/replay');
		replayForm.elements['path-alertId'].value = 'alert-1';
		replayForm.elements.body.value = JSON.stringify({
			channels: ['telegram'],
			idempotency_key: 'operator-replay-key',
		});
		await replayForm.dispatch('submit');
		await flush();

		expect(browser.helperCalls.at(-1).body).toEqual({
			channels: ['telegram'],
			idempotency_key: 'operator-replay-key',
		});
	});

	it('retries the OpenAPI contract after the first load rejects', async () => {
		let contractAttempts = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url !== '/openapi.json') return response({});
				contractAttempts++;
				if (contractAttempts === 1) throw new Error('temporary outage');
				return response(contract);
			},
		});
		await flush();
		expect(browser.elementsById.view.textContent).toContain('temporary outage');

		await selectView(browser, 'alerts');

		expect(contractAttempts).toBe(2);
		expect(findForm(browser.elementsById.view, 'GET /api/alerts')).toBeDefined();
		await selectView(browser, 'presets');
		expect(contractAttempts).toBe(2);
	});

	it('renders dedicated alert filters and follows the returned before cursor', async () => {
		let alertPage = 0;
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				if (url.startsWith('/api/alerts')) {
					alertPage++;
					return response({ alerts: [], pagination: alertPage === 1
						? { hasMore: true, nextBefore: 'cursor-2' }
						: { hasMore: false } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		expect(listForm.elements.limit).toBeDefined();
		expect(listForm.elements.before).toBeDefined();
		expect(listForm.elements.source).toBeDefined();
		expect(listForm.elements.enriched).toBeDefined();
		listForm.elements.limit.value = '10';
		listForm.elements.source.value = 'webhook';
		await listForm.dispatch('submit');
		await flush();
		await findButton(listForm, 'Next page').dispatch('click');
		await flush();
		expect(requests.at(-1)[0]).toBe('/api/alerts?limit=10&before=cursor-2&source=webhook');
	});

	it('renders dedicated alert analytics and export forms with safe defaults', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'alerts');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
		const exportForm = findForm(browser.elementsById.view, 'GET /api/alerts/export');
		expect(summaryForm).toBeDefined();
		expect(exportForm).toBeDefined();
		expect(exportForm.elements.from.required).toBe(true);
		expect(exportForm.elements.to.required).toBe(true);
		expect(exportForm.elements.includeText.checked).toBe(false);
	});

	it('builds the analytics query and renders summary data from the API response', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return response({
					success: true,
					summary: { totalAlerts: 3, totalSuccess: 2, byChannel: { telegram: 3 } },
				});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
		summaryForm.elements.from.value = '2026-08-01T00:00:00Z';
		summaryForm.elements.to.value = '2026-08-02T00:00:00Z';
		summaryForm.elements.limit.value = '25';
		summaryForm.elements.source.value = 'webhook';
		summaryForm.elements.enriched.value = 'true';
		await summaryForm.dispatch('submit');
		await flush();

		const query = new URLSearchParams(requests[0][0].split('?')[1]);
		expect(query.get('from')).toBe('2026-08-01T00:00:00.000Z');
		expect(query.get('to')).toBe('2026-08-02T00:00:00.000Z');
		expect(query.get('limit')).toBe('25');
		expect(query.get('source')).toBe('webhook');
		expect(query.get('enriched')).toBe('true');
		expect(summaryForm.textContent).toContain('totalAlerts: 3');
		expect(summaryForm.textContent).toContain('totalSuccess: 2');
		expect(summaryForm.textContent).toContain('telegram: 3');
	});

	it.each([
		['jsonl', 'application/x-ndjson'],
		['csv', 'text/csv'],
	])('downloads %s exports with the response content type and no raw text by default', async (format, contentType) => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return {
					ok: true,
					status: 200,
					headers: { get: (name) => name === 'content-type' ? contentType : null },
					blob: async () => ({ type: contentType }),
					text: async () => 'unused export body',
				};
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		browser.elementsById['api-key'].value = 'session-secret';
		const exportForm = findForm(browser.elementsById.view, 'GET /api/alerts/export');
		exportForm.elements.from.value = '2026-08-01T00:00:00Z';
		exportForm.elements.to.value = '2026-08-02T00:00:00Z';
		exportForm.elements.format.value = format;
		await exportForm.dispatch('submit');
		await flush();

		const query = new URLSearchParams(requests[0][0].split('?')[1]);
		expect(query.get('from')).toBe('2026-08-01T00:00:00.000Z');
		expect(query.get('to')).toBe('2026-08-02T00:00:00.000Z');
		expect(query.get('format')).toBe(format);
		expect(query.get('includeText')).toBe('false');
		expect(requests[0][1].headers['x-api-key']).toBe('session-secret');
		expect(requests[0][0]).not.toContain('session-secret');
		expect(browser.downloads[0].download).toBe(`alerts-export.${format}`);
		expect(browser.downloads[0].download).not.toContain('session-secret');
		expect(browser.context.window.URL.createObjectURL).toHaveBeenCalledWith({ type: contentType });
		expect(exportForm.textContent).toContain(contentType);
		expect(exportForm.textContent).not.toContain('session-secret');

		exportForm.elements.includeText.checked = true;
		await exportForm.dispatch('submit');
		await flush();
		const optInQuery = new URLSearchParams(requests.at(-1)[0].split('?')[1]);
		expect(optInQuery.get('includeText')).toBe('true');
	});

	it('shows bounded-export validation and protected API errors without downloading', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return response({ error: 'storage unavailable', code: 'STORAGE_UNAVAILABLE' }, 503);
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const exportForm = findForm(browser.elementsById.view, 'GET /api/alerts/export');
		exportForm.elements.from.value = '';
		await exportForm.dispatch('submit');
		await flush();
		expect(requests).toHaveLength(0);
		const exportOutput = find(exportForm, (node) => node.tagName === 'PRE');
		expect(exportOutput.className).toContain('response-error');
		expect(exportOutput.textContent).toContain('From and To are required');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
		await summaryForm.dispatch('submit');
		await flush();
		expect(requests).toHaveLength(1);
		const summaryOutput = find(summaryForm, (node) => node.tagName === 'PRE');
		expect(summaryOutput.className).toContain('response-error');
		expect(summaryOutput.textContent).toContain('HTTP 503');
		expect(summaryOutput.textContent).toContain('STORAGE_UNAVAILABLE');
	});

	it('renders dedicated alert detail lookup', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'alerts');

		expect(findForm(browser.elementsById.view, 'GET /api/alerts/{alertId}')).toBeDefined();
	});

	it('renders dedicated preset create and update controls', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();

		await selectView(browser, 'presets');
		expect(findForm(browser.elementsById.view, 'POST /api/scanner-presets')).toBeDefined();
		expect(findForm(browser.elementsById.view, 'PUT /api/scanner-presets/{id}')).toBeDefined();
	});

	it('renders query controls for POST operations that declare query parameters', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();

		await selectView(browser, 'presets');
		const runForm = findForm(browser.elementsById.view, 'POST /api/scanner-presets/{id}/run');
		expect(runForm.elements.query).toBeDefined();
		expect(runForm.elements.query.value).toContain('"dryRun": false');
	});

	it('loads recent jobs with bounded status, type, and limit filters', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return response({ success: true, jobs: [] });
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		listForm.elements.limit.value = '7';
		listForm.elements.status.value = 'failed';
		listForm.elements.type.value = 'market-scanner';
		browser.elementsById['api-key'].value = 'session-secret';
		await listForm.dispatch('submit');
		await flush();

		expect(requests.at(-1)[0]).toBe('/api/jobs?limit=7&status=failed&type=market-scanner');
		expect(requests.at(-1)[1].headers['x-api-key']).toBe('session-secret');
	});

	it('renders only safe recent-job summary fields', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({
					success: true,
					jobs: [{
						jobId: 'job-safe',
						type: 'expanded-analysis',
						status: 'failed',
						progress: { current: 1, total: 2, status: 'hidden-progress-detail' },
						createdAt: '2026-07-30T04:55:09.000Z',
						updatedAt: '2026-07-30T04:56:09.000Z',
						totalDurationMs: 60000,
						error: 'hidden internal error',
						payload: { callbackSecret: 'hidden-secret' },
					}],
				});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('job-safe');
		expect(listForm.textContent).toContain('expanded-analysis');
		expect(listForm.textContent).toContain('failed');
		expect(listForm.textContent).toContain('1 / 2');
		expect(listForm.textContent).toContain('60000 ms');
		expect(listForm.textContent).not.toContain('hidden internal error');
		expect(listForm.textContent).not.toContain('hidden-secret');
	});

	it('clears stale recent jobs when a refresh fails', async () => {
		let listAttempts = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				listAttempts++;
				if (listAttempts === 1) {
					return response({ success: true, jobs: [{
						jobId: 'stale-job', type: 'expanded-analysis', status: 'completed', progress: {},
					}] });
				}
				return response({ error: 'refresh failed' }, 500);
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		await listForm.dispatch('submit');
		await flush();
		expect(listForm.textContent).toContain('stale-job');

		await listForm.dispatch('submit');
		await flush();
		expect(listForm.textContent).not.toContain('stale-job');
	});

	it('ignores a pending list response after its filters change', async () => {
		let resolveList;
		const pendingList = new Promise((resolve) => { resolveList = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.includes('status=processing')) return pendingList;
				return response({ success: true, jobs: [] });
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		listForm.elements.status.value = 'processing';
		const pendingSubmit = listForm.dispatch('submit');
		await flush();
		listForm.elements.status.value = 'failed';
		await listForm.elements.status.dispatch('change');
		expect(listForm.textContent).toContain('Filters changed. Submit to load recent jobs.');
		resolveList(response({ success: true, jobs: [{
			jobId: 'old-filter-job', type: 'expanded-analysis', status: 'processing', progress: {},
		}] }));
		await pendingSubmit;
		await flush();

		expect(findButton(listForm, 'Load recent jobs').disabled).toBe(false);
		expect(listForm.textContent).not.toContain('old-filter-job');
	});

	it('pre-fills the existing job status workflow when a recent job is selected', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({ success: true, jobs: [{
					jobId: 'selected-job', type: 'market-scanner', status: 'processing', progress: {},
				}] });
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		await listForm.dispatch('submit');
		await flush();
		await findButton(listForm, 'Open status').dispatch('click');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		expect(statusForm.elements['path-jobId'].value).toBe('selected-job');
	});

	it('ignores a pending status response after selecting another recent job', async () => {
		let resolveStatus;
		const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/jobs?')) {
					return response({ success: true, jobs: [{
						jobId: 'job-b', type: 'market-scanner', status: 'processing', progress: {},
					}] });
				}
				if (url === '/api/jobs/job-a') return pendingStatus;
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		await listForm.dispatch('submit');
		await flush();
		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-a';
		const pendingSubmit = statusForm.dispatch('submit');
		await flush();
		await findButton(listForm, 'Open status').dispatch('click');
		expect(findButton(statusForm, 'Get job status').disabled).toBe(false);
		expect(statusForm.textContent).toContain('Job selected. Submit to load its status.');
		resolveStatus(response({ jobId: 'job-a', status: 'processing', results: [] }));
		await pendingSubmit;
		await flush();

		expect(statusForm.elements['path-jobId'].value).toBe('job-b');
		expect(findButton(statusForm, 'Cancel job')).toBeUndefined();
		expect(statusForm.textContent).toContain('Job selected. Submit to load its status.');
		expect(statusForm.textContent).not.toContain('"job-a"');
	});

	it('re-enables status lookup after a manual job-ID edit invalidates a request', async () => {
		let resolveStatus;
		const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-a') return pendingStatus;
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		const jobIdInput = statusForm.elements['path-jobId'];
		jobIdInput.value = 'job-a';
		const pendingSubmit = statusForm.dispatch('submit');
		await flush();
		jobIdInput.value = 'job-b';
		await jobIdInput.dispatch('input');
		resolveStatus(response({ jobId: 'job-a', status: 'processing', results: [] }));
		await pendingSubmit;
		await flush();

		expect(findButton(statusForm, 'Get job status').disabled).toBe(false);
		expect(statusForm.textContent).not.toContain('"job-a"');
	});

	it('ignores a pending job action after selecting another recent job', async () => {
		let resolveAction;
		const pendingAction = new Promise((resolve) => { resolveAction = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/jobs?')) {
					return response({ success: true, jobs: [{
						jobId: 'job-b', type: 'market-scanner', status: 'processing', progress: {},
					}] });
				}
				if (url === '/api/jobs/job-a') return response({ jobId: 'job-a', status: 'processing', results: [] });
				if (url === '/api/jobs/job-a/cancel') return pendingAction;
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		await listForm.dispatch('submit');
		await flush();
		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-a';
		await statusForm.dispatch('submit');
		await flush();
		const pendingRequest = findButton(statusForm, 'Cancel job').dispatch('click');
		await flush();
		await findButton(listForm, 'Open status').dispatch('click');
		resolveAction(response({ success: true, jobId: 'job-a', status: 'cancelled' }));
		await pendingRequest;
		await flush();

		expect(statusForm.elements['path-jobId'].value).toBe('job-b');
		expect(statusForm.textContent).toContain('Job selected. Submit to load its status.');
		expect(statusForm.textContent).not.toContain('"job-a"');
	});

	it('shows cancel only for a fetched active job', async () => {
		const job = { jobId: 'job-1', status: 'processing', results: [] };
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-1') return response(job);
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-1';
		await statusForm.dispatch('submit');
		await flush();
		expect(findButton(statusForm, 'Cancel job')).toBeDefined();
		expect(findButton(statusForm, 'Retry job')).toBeUndefined();
		expect(findButton(statusForm, 'Retry failed items')).toBeUndefined();
	});

	it('does not offer or dispatch retry-failed for a processing job with failed items', async () => {
		const job = {
			success: true,
			jobId: 'job-1',
			type: 'expanded-analysis',
			status: 'processing',
			progress: { completed: 2, total: 4 },
			createdAt: '2026-07-17T20:00:00.000Z',
			updatedAt: '2026-07-17T20:01:00.000Z',
			totalDurationMs: 60000,
			results: [{ status: 'error' }, { status: 'timeout' }],
		};
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-1') return response(job);
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-1';
		await statusForm.dispatch('submit');
		await flush();
		const retryFailed = findButton(statusForm, 'Retry failed items');
		if (retryFailed) {
			await retryFailed.dispatch('click');
			await flush();
		}

		expect(browser.context.fetch).not.toHaveBeenCalledWith(
			'/api/jobs/job-1/retry-failed',
			expect.anything(),
		);
		expect(retryFailed).toBeUndefined();
	});

	it('shows both retry actions only for a fetched failed job with failed items', async () => {
		const job = { jobId: 'job-1', status: 'failed', results: [{ status: 'error' }] };
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-1') return response(job);
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-1';
		await statusForm.dispatch('submit');
		await flush();
		expect(findButton(statusForm, 'Cancel job')).toBeUndefined();
		expect(findButton(statusForm, 'Retry job')).toBeDefined();
		const retryFailed = findButton(statusForm, 'Retry failed items');
		expect(retryFailed).toBeDefined();
		await retryFailed.dispatch('click');
		await flush();
		expect(browser.context.fetch).toHaveBeenLastCalledWith(
			'/api/jobs/job-1/retry-failed',
			expect.objectContaining({ method: 'POST' }),
		);
	});
});
