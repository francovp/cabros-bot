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

	remove() {
		if (!this.parentNode) return;
		const siblings = this.parentNode.children;
		const index = siblings.indexOf(this);
		if (index >= 0) siblings.splice(index, 1);
		this.parentNode = undefined;
	}

	select() {}

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

function createBrowser({ fetchImpl, confirm = () => true, storedKey = '', firebase, location = {} }) {
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
	const timerDelays = new Map();
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
		execCommand: () => false,
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
		URL,
		URLSearchParams,
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
		setTimeout: (fn, delay) => {
			const id = timers.size + 1;
			timers.set(id, fn);
			timerDelays.set(id, delay);
			return id;
		},
		clearTimeout: (id) => { timers.delete(id); timerDelays.delete(id); },
		window: {
			CabrosAdminRequest: helper,
			confirm,
			firebase,
			location,
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

	return { body, context, elementsById, helperCalls, storage, downloads, timers, timerDelays };
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

	it('ignores an unallowlisted backend origin override', async () => {
		const requests = [];
		const browser = createBrowser({
			location: {
				hostname: 'cabros-bot.web.app',
				search: '?backend=https%3A%2F%2Fattacker.example',
			},
			fetchImpl: async (url) => {
				requests.push(url);
				if (url.endsWith('/openapi.json')) return response(contract);
				return response({ enabled: false, configured: false });
			},
		});
		await flush();

		expect(requests[0]).toBe('https://cabros-bot-production.up.railway.app/admin/auth-config');
		expect(requests.some((url) => url.includes('attacker.example'))).toBe(false);
		void browser;
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

	it('resolves authentication with fallback when the auth-config body stalls until timeout', async () => {
		const firebase = {
			initializeApp: jest.fn(),
			auth: jest.fn(),
		};
		const browser = createBrowser({
			firebase,
			fetchImpl: (url, options) => {
				if (url !== '/admin/auth-config') return response({});
				return Promise.resolve({
					ok: true,
					status: 200,
					json: () => new Promise((resolve, reject) => {
						options.signal.addEventListener('abort', () => reject(new Error('AbortError')));
					}),
				});
			},
		});
		await flush();

		expect(browser.timers.size).toBe(1);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();

		expect(browser.elementsById['auth-state'].textContent).toContain('Firebase sign-in is unavailable');
		expect(browser.timers.size).toBe(0);
	});

	it('shows a contract-load error when the OpenAPI fetch stalls until timeout', async () => {
		let signal;
		const browser = createBrowser({
			fetchImpl: (url, options) => {
				if (url !== '/openapi.json') return response({});
				signal = options?.signal;
				return new Promise((resolve, reject) => {
					signal?.addEventListener('abort', () => reject(new Error('AbortError')));
				});
			},
		});
		await flush();

		expect(browser.timers.size).toBe(1);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();

		expect(signal.aborted).toBe(true);
		expect(browser.elementsById.view.textContent).toContain('Unable to load the API contract: AbortError');
		expect(browser.timers.size).toBe(0);
	});

	it('shows a network error when an API request stalls until timeout', async () => {
		let signal;
		const browser = createBrowser({
			fetchImpl: (url, options) => {
				if (url === '/openapi.json') return response(contract);
				if (url !== '/api/status') return response({});
				signal = options?.signal;
				return new Promise((resolve, reject) => {
					signal?.addEventListener('abort', () => reject(new Error('AbortError')));
				});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'status');
		const form = findForm(browser.elementsById.view, 'GET /api/status');
		await form.dispatch('submit');
		await flush();

		expect(browser.timers.size).toBe(1);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();

		expect(signal.aborted).toBe(true);
		expect(form.textContent).toContain('Network error');
		expect(browser.timers.size).toBe(0);
	});

	it('allows long-running analysis requests to use the server-side deadline budget', async () => {
		const signals = [];
		const browser = createBrowser({
			fetchImpl: (url, options) => {
				if (url === '/openapi.json') return response(contract);
				if (!url.includes('/api/webhook/expanded-analysis-alert')
					&& !url.includes('/api/news-monitor')
					&& !url.includes('/api/scanner-presets/')
					&& !url.includes('/api/webhook/volume-confirmation')) return response({});
				const signal = options?.signal;
				signals.push(signal);
				return new Promise((resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('AbortError')));
				});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'analysis');
		const form = findForm(browser.elementsById.view, 'POST /api/webhook/expanded-analysis-alert');
		await form.dispatch('submit');
		await flush();

		expect([...browser.timerDelays.values()]).toContain(900000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[0].aborted).toBe(true);

		await selectView(browser, 'analysis');
		await findForm(browser.elementsById.view, 'POST /api/news-monitor').dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toContain(900000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[1].aborted).toBe(true);

		await selectView(browser, 'presets');
		await findForm(browser.elementsById.view, 'POST /api/scanner-presets/{id}/run').dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toContain(900000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[2].aborted).toBe(true);

		await selectView(browser, 'analysis');
		await findForm(browser.elementsById.view, 'POST /api/webhook/volume-confirmation').dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toContain(360000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[3].aborted).toBe(true);
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
				summary: {
					window: { from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' },
					totalAlerts: 3,
					enrichment: {
						enrichedAlerts: 2,
						plainAlerts: 1,
						riskMetadataCoverage: {
							denominator: 2,
							fields: { invalidation_level: { populated: 1, percentage: 50 } },
						},
						tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, totalCost: 0.002 },
					},
					delivery: {
						totalSuccess: 2,
						totalFailure: 1,
						byChannel: { telegram: { total: 3, success: 2, failure: 1 } },
					},
				},
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

		const blocks = find(summaryForm, (node) => node.className === 'dashboard summary-blocks');
		expect(blocks).toBeDefined();
		expect(blocks.textContent).toContain('Total alerts');
		expect(blocks.textContent).toContain('Estimated cost 0.002');
		expect(find(blocks, (node) => node.tagName === 'TR' && node.textContent.includes('Telegram'))).toBeDefined();
		expect(find(blocks, (node) => node.tagName === 'TR'
			&& node.textContent.toLowerCase().includes('invalidation'))).toBeDefined();
		expect(blocks.textContent).toContain('50%');
		expect(findButton(summaryForm, 'Copy JSON').hidden).toBe(false);
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

	it('shows a shared loading state while a request is in flight', async () => {
		let resolveStatus;
		const pendingStatus = new Promise((resolve) => { resolveStatus = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/status') return pendingStatus;
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'status');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/status');
		const pendingSubmit = statusForm.dispatch('submit');
		await flush();

		const output = find(statusForm, (node) => node.tagName === 'PRE');
		expect(find(output, (node) => node.className === 'spinner')).toBeDefined();
		expect(output.textContent).toContain('Request in progress');

		resolveStatus(response({
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			deliveryChannels: {},
			dependencies: {},
		}));
		await pendingSubmit;
		await flush();
		expect(output.textContent).toContain('cabros-bot');
	});

	it('renders an empty state when the recent-jobs list has no rows', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : { success: true, jobs: [] }),
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		await listForm.dispatch('submit');
		await flush();

		const empty = find(listForm, (node) => node.className === 'empty-state');
		expect(empty).toBeDefined();
		expect(empty.textContent).toContain('No recent jobs found.');
	});

	it('formats job card timestamps relatively with an absolute title', async () => {
		const createdAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({ success: true, jobs: [{
					jobId: 'recent-job', type: 'expanded-analysis', status: 'completed',
					progress: {}, createdAt,
				}] });
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const listForm = findForm(browser.elementsById.view, 'Load recent jobs');
		await listForm.dispatch('submit');
		await flush();

		const stamps = findAll(browser.elementsById.view, (node) => node.className === 'timestamp'
			&& node.textContent.includes('min ago'));
		expect(stamps.length).toBeGreaterThanOrEqual(1);
		expect(stamps[0].attributes.title).toContain(String(new Date(createdAt).getFullYear()));
	});

	it('offers a raw-status copy action that reports unavailable clipboards safely', async () => {
		const status = {
			service: { name: 'cabros-bot', version: '0.1.0', environment: 'production', commit: 'abc123' },
			featureFlags: {},
			deliveryChannels: {},
			dependencies: {},
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

		const copyButton = findButton(browser.elementsById.view, 'Copy JSON');
		expect(copyButton).toBeDefined();
		await copyButton.dispatch('click');
		await flush();
		expect(copyButton.textContent).toBe('Copy unavailable');

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		expect(copyButton.textContent).toBe('Copy JSON');
	});

	it('renders stored alerts as cards with sentiment, delivery chips, and lazy detail', async () => {
		const receivedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					return response({
						success: true,
						alerts: [{
							id: 'alert-9',
							receivedAt,
							text: 'BTCUSDT breakout confirmed',
							enriched: true,
							source: 'webhook',
							enrichmentData: {
								sentiment: 'bullish',
								sentiment_score: 0.82,
								insights: ['Volume confirms move'],
								technical_levels: { supports: [81000], resistances: [85000] },
								invalidation_level: 80000,
								target_level: 90000,
								setup_type: 'breakout',
								risk_reward_ratio: '2.5:1',
								prompt_provenance: { name: 'alert-enrichment', source: 'langfuse', version: 4 },
								sources: [{ url: 'https://example.com/a', title: 'Example News' }],
							},
							tokenUsage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
							deliveryResults: [
								{ channel: 'telegram', success: true },
								{ channel: 'whatsapp', success: false },
							],
						}],
						pagination: { hasMore: false },
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();

		const card = find(listForm, (node) => node.className.includes('alert-card'));
		expect(card).toBeDefined();
		expect(card.textContent).toContain('BTCUSDT breakout confirmed');
		expect(card.textContent).toContain('Bullish (0.82)');
		expect(find(card, (node) => node.className.includes('delivery-ok')).textContent).toContain('Telegram');
		expect(find(card, (node) => node.className.includes('delivery-fail')).textContent).toContain('WhatsApp');
		expect(find(card, (node) => node.tagName === 'A')).toBeUndefined();

		await findButton(card, 'Show detail').dispatch('click');
		const link = find(card, (node) => node.tagName === 'A');
		expect(link.href).toBe('https://example.com/a');
		expect(link.attributes.rel).toBe('noopener noreferrer');
		expect(card.textContent).toContain('Invalidation level');
		expect(card.textContent).toContain('2.5:1');
		expect(card.textContent).toContain('alert-enrichment');
		expect(card.textContent).toContain('Token usage');

		await findButton(card, 'Hide detail').dispatch('click');
		expect(findButton(card, 'Hide detail')).toBeUndefined();
		expect(findButton(card, 'Show detail')).toBeDefined();
	});

	it('keeps the raw stored-alerts payload behind a collapsed toggle with copy', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					return response({ success: true, alerts: [{ id: 'a1', text: 'x', enriched: false }], pagination: {} });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');
		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();

		const rawToggle = find(listForm, (node) => node.tagName === 'DETAILS');
		expect(rawToggle).toBeDefined();
		const summary = find(rawToggle, (node) => node.tagName === 'SUMMARY');
		expect(summary.textContent).toContain('Show raw response');
		expect(findButton(listForm, 'Copy JSON').hidden).toBe(false);
	});

	it('paginates stored alerts backward through visited cursors', async () => {
		const pages = [
			{ alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } },
			{ alerts: [{ id: 'a2', text: 'second page alert', enriched: false }], pagination: { hasMore: false } },
		];
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				if (url.startsWith('/api/alerts')) {
					const params = new URLSearchParams(url.split('?')[1] || '');
					return response(params.get('before') === 'cursor-2' ? pages[1] : pages[0]);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		expect(listForm.textContent).toContain('first page alert');
		expect(findButton(listForm, 'Previous page').disabled).toBe(true);

		await findButton(listForm, 'Next page').dispatch('click');
		await flush();
		expect(requests.at(-1)[0]).toBe('/api/alerts?limit=50&before=cursor-2');
		expect(listForm.textContent).toContain('second page alert');
		expect(findButton(listForm, 'Previous page').disabled).toBe(false);
		expect(findButton(listForm, 'Next page').disabled).toBe(true);

		await findButton(listForm, 'Previous page').dispatch('click');
		await flush();
		expect(requests.at(-1)[0]).toBe('/api/alerts?limit=50');
		expect(listForm.textContent).toContain('first page alert');
	});

	it('renders an empty state when no stored alerts match the filters', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) return response({ success: true, alerts: [], pagination: {} });
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');
		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();

		const empty = find(listForm, (node) => node.className === 'empty-state');
		expect(empty).toBeDefined();
		expect(empty.textContent).toContain('No stored alerts match these filters.');
	});

	it('renders an alert detail panel after a successful lookup by ID', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/alerts/alert-7') {
					return response({ success: true, alert: { id: 'alert-7', text: 'detail body', enriched: false } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const detailForm = findForm(browser.elementsById.view, 'GET /api/alerts/{alertId}');
		detailForm.elements['path-alertId'].value = 'alert-7';
		await detailForm.dispatch('submit');
		await flush();

		const panel = find(detailForm, (node) => node.className.includes('alert-detail'));
		expect(panel).toBeDefined();
		expect(panel.textContent).toContain('Plain');
		expect(panel.textContent).toContain('detail body');
	});

	it('renders a structured job panel with progress, results, and raw toggle', async () => {
		const job = {
			success: true,
			jobId: 'job-panel',
			type: 'expanded-analysis',
			status: 'completed',
			progress: { current: 2, total: 4, status: 'Analyzing symbols' },
			createdAt: '2026-08-01T10:00:00.000Z',
			totalDurationMs: 42000,
			alertText: '📊 REPORT BODY',
			results: [{ symbol: 'BINANCE:BTCUSDT', status: 'analyzed', price: 65000, rsi: 55.5 }],
			deliveryResults: [{ channel: 'telegram', success: true }],
		};
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-panel') return response(job);
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-panel';
		await statusForm.dispatch('submit');
		await flush();

		const panel = find(statusForm, (node) => node.className.includes('job-panel'));
		expect(panel).toBeDefined();
		const fill = find(panel, (node) => node.className === 'progress-fill');
		expect(fill.style).toBe('width: 50%;');
		expect(panel.textContent).toContain('2 / 4');
		expect(find(panel, (node) => node.tagName === 'TR' && node.textContent.includes('BINANCE:BTCUSDT'))).toBeDefined();
		expect(find(panel, (node) => node.className === 'report-text').textContent).toContain('REPORT BODY');
		expect(find(panel, (node) => node.className.includes('delivery-ok'))).toBeDefined();
		expect(findButton(statusForm, 'Copy JSON').hidden).toBe(false);
	});

	it('auto-refreshes active jobs and stops on terminal status', async () => {
		let statusCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-live') {
					statusCalls += 1;
					return response(statusCalls === 1
						? { jobId: 'job-live', type: 'market-scanner', status: 'processing', progress: { current: 1, total: 3 } }
						: { jobId: 'job-live', type: 'market-scanner', status: 'completed', progress: { current: 3, total: 3 } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-live';
		await statusForm.dispatch('submit');
		await flush();
		expect(statusCalls).toBe(1);
		expect(findButton(statusForm, 'Pause auto-refresh').hidden).toBe(false);

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);
	});

	it('pauses auto-refresh while a job is still processing', async () => {
		let statusCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-slow') {
					statusCalls += 1;
					return response({ jobId: 'job-slow', status: 'processing', progress: {} });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-slow';
		await statusForm.dispatch('submit');
		await flush();

		const pauseButton = findButton(statusForm, 'Pause auto-refresh');
		expect(pauseButton.hidden).toBe(false);
		await pauseButton.dispatch('click');
		expect(findButton(statusForm, 'Resume auto-refresh')).toBeDefined();

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(1);
	});

	it('stops polling when the job ID input changes mid-refresh cycle', async () => {
		let statusCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-a') {
					statusCalls += 1;
					return response({ jobId: 'job-a', status: 'processing', progress: {} });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-a';
		await statusForm.dispatch('submit');
		await flush();
		expect(statusCalls).toBe(1);

		statusForm.elements['path-jobId'].value = 'job-b';
		await statusForm.elements['path-jobId'].dispatch('input');
		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(1);
	});

	it('renders the volume confirmation verdict with a ratio meter', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/volume-confirmation') {
					return response({
						success: true,
						symbol: 'BINANCE:BTCUSDT',
						timeframe: '4h',
						confirmed: true,
						decision: 'confirm',
						volumeRatio: 1.7,
						analysis: { volume_analysis: { volume_strength: 'HIGH' } },
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/volume-confirmation');
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('verdict-panel'));
		expect(verdict).toBeDefined();
		expect(verdict.textContent).toContain('Confirmed');
		expect(verdict.textContent).toContain('BINANCE:BTCUSDT · 4h');
		expect(verdict.textContent).toContain('1.7x average volume');
		expect(verdict.textContent).toContain('Strength: HIGH');
		expect(findButton(form, 'Copy JSON').hidden).toBe(false);
	});

	it('renders news-monitor result cards with confidence and dry-run notice', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/news-monitor')) {
					return response({
						success: true,
						dryRun: true,
						summary: { analyzed: 1, alerts_sent: 1 },
						results: [{
							symbol: 'BTCUSDT',
							status: 'analyzed',
							alert: {
								eventCategory: 'price_surge',
								headline: 'Bitcoin breaks resistance',
								confidence: 0.85,
								sources: ['https://example.com/news'],
							},
						}],
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/news-monitor');
		await form.dispatch('submit');
		await flush();

		const results = find(form, (node) => node.className === 'dashboard news-results');
		expect(results).toBeDefined();
		expect(results.textContent).toContain('Dry run');
		expect(results.textContent).toContain('Bitcoin breaks resistance');
		expect(results.textContent).toContain('85% confidence');
		expect(results.textContent).toContain('Analyzed: 1');
		expect(find(results, (node) => node.tagName === 'LI' && node.textContent.includes('example.com/news'))).toBeDefined();
	});

	it('renders market-scanner sections with ranked score tables and trend chips', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/webhook/market-scanner-alert')) {
					return response({
						success: true,
						alertText: '📡 SCANNER REPORT',
						scanResults: [{
							scan: 'top_gainers',
							status: 'success',
							itemCount: 1,
							scores: [{
								symbol: 'ETHUSDT',
								score: 83,
								reason: '+3.5% · RSI 62',
								trendConfluence: { status: 'aligned', direction: 'bullish', confidence: 82 },
							}],
						}],
						deliveryResults: [{ channel: 'telegram', success: true }],
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/market-scanner-alert');
		await form.dispatch('submit');
		await flush();

		const report = find(form, (node) => node.className === 'dashboard analysis-report');
		expect(report).toBeDefined();
		expect(find(report, (node) => node.className === 'report-text').textContent).toContain('SCANNER REPORT');
		const row = find(report, (node) => node.tagName === 'TR' && node.textContent.includes('ETHUSDT'));
		expect(row).toBeDefined();
		expect(row.textContent).toContain('83');
		expect(row.textContent).toContain('Aligned bullish (82%)');
		expect(find(report, (node) => node.className.includes('delivery-ok'))).toBeDefined();
	});

	it('stops in-flight auto-refresh polling when the jobs view detaches', async () => {
		let statusCalls = 0;
		let releasePoll;
		const slowPoll = new Promise((resolve) => { releasePoll = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-live') {
					statusCalls += 1;
					if (statusCalls === 1) {
						return response({ jobId: 'job-live', type: 'market-scanner', status: 'processing', progress: { current: 1, total: 3 } });
					}
					return slowPoll.then(() => response({ jobId: 'job-live', status: 'processing', progress: {} }));
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-live';
		await statusForm.dispatch('submit');
		await flush();
		expect(statusCalls).toBe(1);

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);

		await selectView(browser, 'overview');

		releasePoll();
		await flush();
		expect(statusCalls).toBe(2);

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);
	});

	it('renders an unknown volume verdict separately from denial', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/volume-confirmation') {
					return response({
						success: true,
						symbol: 'BINANCE:ETHUSDT',
						timeframe: '1h',
						confirmed: null,
						decision: 'unknown',
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/volume-confirmation');
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('verdict-panel'));
		expect(verdict).toBeDefined();
		const badge = find(verdict, (node) => node.className.includes('status-badge'));
		expect(badge.className).toContain('status-active');
		expect(badge.textContent).toBe('Unknown');
		expect(find(verdict, (node) => node.className.includes('status-danger'))).toBeUndefined();
	});

	it('reads dry-run analysis reports from the nested payload.alertText', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/webhook/expanded-analysis-alert')) {
					return response({
						success: true,
						dryRun: true,
						payload: { alertText: '📊 ANÁLISIS AMPLIADO (dry run)' },
						results: [{ symbol: 'BINANCE:BTCUSDT', status: 'analyzed' }],
						summary: { total: 1, analyzed: 1, delivered: 0 },
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/expanded-analysis-alert');
		await form.dispatch('submit');
		await flush();

		const report = find(form, (node) => node.className === 'dashboard analysis-report');
		expect(report).toBeDefined();
		expect(report.textContent).toContain('ANÁLISIS AMPLIADO (dry run)');
	});

	it('reads the persisted camelCase promptProvenance field in alert details', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					return response({
						success: true,
						alerts: [{
							id: 'alert-p',
							text: 'provenance alert',
							enriched: true,
							enrichmentData: {
								sentiment: 'bullish',
								promptProvenance: { name: 'alert-enrichment', source: 'langfuse', version: 7 },
							},
						}],
						pagination: {},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');
		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();

		const card = find(listForm, (node) => node.className.includes('alert-card'));
		await findButton(card, 'Show detail').dispatch('click');
		expect(card.textContent).toContain('Prompt: alert-enrichment (langfuse v7)');
	});

	it('serializes stored-alert pagination so a slow page cannot interleave', async () => {
		const pages = [
			{ alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } },
			{ alerts: [{ id: 'a2', text: 'second page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-3' } },
			{ alerts: [{ id: 'a3', text: 'third page alert', enriched: false }], pagination: { hasMore: false } },
		];
		let alertCalls = 0;
		let releaseSlowPage;
		const slowPage = new Promise((resolve) => { releaseSlowPage = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					if (alertCalls === 2) return slowPage.then(() => response(pages[2]));
					return response(pages[alertCalls - 1]);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		expect(listForm.textContent).toContain('first page alert');

		const nextButton = findButton(listForm, 'Next page');
		const prevButton = findButton(listForm, 'Previous page');
		const click = nextButton.dispatch('click');
		await flush();
		expect(alertCalls).toBe(2);
		expect(nextButton.disabled).toBe(true);
		expect(prevButton.disabled).toBe(true);

		releaseSlowPage();
		await click;
		await flush();
		expect(listForm.textContent).toContain('third page alert');
		expect(findButton(listForm, 'Next page').disabled).toBe(true);
	});

	it('clears the raw-status copy payload when a later refresh fails', async () => {
		const status = {
			service: { name: 'cabros-bot', version: '0.1.0', environment: 'production', commit: 'abc123' },
			featureFlags: {},
			deliveryChannels: {},
			dependencies: {},
		};
		let statusCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/status') {
					statusCalls += 1;
					if (statusCalls === 1) return response(status);
					return response({ error: 'Unauthorized' }, 401);
				}
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'overview');
		await flush();

		const copyButton = findButton(browser.elementsById.view, 'Copy JSON');
		expect(copyButton).toBeDefined();
		expect(copyButton.hidden).toBe(false);

		const refreshButton = findButton(browser.elementsById.view, 'Refresh dashboard');
		await refreshButton.dispatch('click');
		await flush();

		expect(statusCalls).toBe(2);
		expect(copyButton.hidden).toBe(true);
	});

	it('sends job actions confirmed during an in-flight auto-refresh', async () => {
		const requests = [];
		let statusCalls = 0;
		let releasePoll;
		const slowPoll = new Promise((resolve) => { releasePoll = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options?.method || 'GET']);
				if (url === '/api/jobs/job-live') {
					statusCalls += 1;
					if (statusCalls === 1) {
						return response({ jobId: 'job-live', type: 'market-scanner', status: 'processing', progress: { current: 1, total: 3 } });
					}
					return slowPoll.then(() => response({ jobId: 'job-live', status: 'processing', progress: {} }));
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-live';
		await statusForm.dispatch('submit');
		await flush();

		const cancelButton = findButton(statusForm, 'Cancel job');
		expect(cancelButton).toBeDefined();

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);

		await cancelButton.dispatch('click');
		await flush();

		expect(requests.some(([url, method]) => url.includes('/api/jobs/job-live/cancel') && method === 'POST')).toBe(true);

		releasePoll();
		await flush();
	});

	it('removes the fallback textarea even when execCommand throws', async () => {
		const status = {
			service: { name: 'cabros-bot' },
			featureFlags: {},
			deliveryChannels: {},
			dependencies: {},
		};
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : (url === '/api/status' ? status : {})),
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'overview');
		await flush();

		browser.context.document.execCommand = () => { throw new Error('blocked'); };
		const copyButton = findButton(browser.elementsById.view, 'Copy JSON');
		await copyButton.dispatch('click');
		await flush();

		expect(copyButton.textContent).toBe('Copy unavailable');
		expect(find(browser.body, (node) => node.tagName === 'TEXTAREA')).toBeUndefined();
	});

	it('reports a successful execCommand fallback and cleans up its textarea', async () => {
		const status = {
			service: { name: 'cabros-bot' },
			featureFlags: {},
			deliveryChannels: {},
			dependencies: {},
		};
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : (url === '/api/status' ? status : {})),
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'overview');
		await flush();

		browser.context.document.execCommand = () => true;
		const copyButton = findButton(browser.elementsById.view, 'Copy JSON');
		await copyButton.dispatch('click');
		await flush();

		expect(copyButton.textContent).toBe('Copied!');
		expect(find(browser.body, (node) => node.tagName === 'TEXTAREA')).toBeUndefined();
	});

	it('clears a previous structured result when the next submission fails validation', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/alerts/alert-7') {
					return response({ success: true, alert: { id: 'alert-7', text: 'detail body', enriched: false } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const detailForm = findForm(browser.elementsById.view, 'GET /api/alerts/{alertId}');
		detailForm.elements['path-alertId'].value = 'alert-7';
		await detailForm.dispatch('submit');
		await flush();
		expect(find(detailForm, (node) => node.className.includes('alert-detail'))).toBeDefined();

		detailForm.elements.query.value = '{ invalid json';
		await detailForm.dispatch('submit');
		await flush();

		expect(find(detailForm, (node) => node.className.includes('alert-detail'))).toBeUndefined();
		expect(detailForm.textContent).toContain('Query must be valid JSON');
	});

	it('resets pagination state when alert filters change', async () => {
		let alertCalls = 0;
		const pages = [
			{ alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } },
			{ alerts: [{ id: 'a2', text: 'second page alert', enriched: false }], pagination: { hasMore: false } },
		];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					return response(pages[alertCalls - 1] || pages[0]);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		const nextButton = findButton(listForm, 'Next page');
		expect(nextButton.disabled).toBe(false);

		listForm.elements.source.value = 'webhook';
		await listForm.elements.source.dispatch('input');

		expect(nextButton.disabled).toBe(true);
		expect(findButton(listForm, 'Previous page').disabled).toBe(true);
		expect(listForm.textContent).not.toContain('first page alert');
		expect(findButton(listForm, 'Copy JSON').hidden).toBe(true);
		expect(find(listForm, (node) => node.tagName === 'PRE' && node.textContent.includes('first page alert'))).toBeUndefined();

		await nextButton.dispatch('click');
		await flush();
		expect(alertCalls).toBe(1);
	});

	it('clears stale stored-alert cards when a later refresh fails', async () => {
		let alertCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					if (alertCalls === 1) {
						return response({ success: true, alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: {} });
					}
					return response({ error: 'boom' }, 500);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		expect(listForm.textContent).toContain('first page alert');
		expect(findButton(listForm, 'Copy JSON').hidden).toBe(false);

		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).not.toContain('first page alert');
		expect(findButton(listForm, 'Copy JSON').hidden).toBe(true);
	});

	it('resets pagination when the before cursor is edited manually', async () => {
		let alertCalls = 0;
		const pages = [
			{ alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } },
			{ alerts: [{ id: 'a2', text: 'second page alert', enriched: false }], pagination: { hasMore: false } },
		];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					return response(pages[alertCalls - 1] || pages[0]);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		const nextButton = findButton(listForm, 'Next page');
		expect(nextButton.disabled).toBe(false);

		listForm.elements.before.value = 'hand-edited-cursor';
		await listForm.elements.before.dispatch('input');

		expect(nextButton.disabled).toBe(true);
		await nextButton.dispatch('click');
		await flush();
		expect(alertCalls).toBe(1);
	});

	it('clears the raw analytics payload when a later summary refresh fails', async () => {
		let summaryCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts/summary')) {
					summaryCalls += 1;
					if (summaryCalls === 1) {
						return response({ success: true, summary: { totalAlerts: 3, window: {} } });
					}
					return response({ error: 'boom' }, 500);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
		await summaryForm.dispatch('submit');
		await flush();
		expect(findButton(summaryForm, 'Copy JSON').hidden).toBe(false);

		await summaryForm.dispatch('submit');
		await flush();

		expect(findButton(summaryForm, 'Copy JSON').hidden).toBe(true);
		const rawPre = find(summaryForm, (node) => node.tagName === 'PRE' && node.textContent.includes('totalAlerts'));
		expect(rawPre).toBeUndefined();
	});

	it('reschedules job auto-refresh after a transient status failure', async () => {
		let statusCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-live') {
					statusCalls += 1;
					if (statusCalls === 1) return response({ jobId: 'job-live', type: 'market-scanner', status: 'processing', progress: { current: 1, total: 3 } });
					if (statusCalls === 2) return response({ error: 'boom' }, 500);
					return response({ jobId: 'job-live', type: 'market-scanner', status: 'completed', progress: { current: 3, total: 3 } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-live';
		await statusForm.dispatch('submit');
		await flush();
		expect(statusCalls).toBe(1);

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);
		expect(findButton(statusForm, 'Pause auto-refresh').hidden).toBe(false);

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(3);
		expect(findButton(statusForm, 'Pause auto-refresh').hidden).toBe(true);
	});

	it('labels dry-run news alerts as generated instead of sent', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/news-monitor')) {
					return response({
						success: true,
						dryRun: true,
						summary: { analyzed: 1, alerts_sent: 1 },
						results: [{ symbol: 'BTCUSDT', status: 'analyzed', alert: { eventCategory: 'price_surge', headline: 'Breakout', confidence: 0.9 } }],
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/news-monitor');
		await form.dispatch('submit');
		await flush();

		expect(form.textContent).toContain('Alerts generated: 1');
		expect(form.textContent).not.toContain('Alerts sent');
	});

	it('clears the raw analysis payload when the next submission fails validation', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/volume-confirmation') {
					return response({ success: true, symbol: 'BINANCE:BTCUSDT', confirmed: true, decision: 'confirm', volumeRatio: 1.7, analysis: { volume_analysis: { volume_strength: 'HIGH' } } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/volume-confirmation');
		await form.dispatch('submit');
		await flush();
		expect(findButton(form, 'Copy JSON').hidden).toBe(false);

		form.elements.body.value = '{ invalid';
		await form.dispatch('submit');
		await flush();

		expect(findButton(form, 'Copy JSON').hidden).toBe(true);
		const staleRaw = find(form, (node) => node.tagName === 'PRE' && node.textContent.includes('volume_ratio'));
		expect(staleRaw).toBeUndefined();
	});

	it('disables Next when hasMore is false even if a cursor is present', async () => {
		const pages = [
			{ alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } },
			{ alerts: [{ id: 'a2', text: 'last page alert', enriched: false }], pagination: { hasMore: false, nextBefore: 'cursor-last' } },
		];
		let alertCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					return response(pages[alertCalls - 1] || pages[1]);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		expect(findButton(listForm, 'Next page').disabled).toBe(false);

		await findButton(listForm, 'Next page').dispatch('click');
		await flush();
		expect(listForm.textContent).toContain('last page alert');
		expect(findButton(listForm, 'Next page').disabled).toBe(true);
	});

	it('keeps the back-stack entry when a Next page request fails', async () => {
		let alertCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					if (alertCalls === 1) {
						return response({ alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } });
					}
					return response({ error: 'boom' }, 500);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		expect(findButton(listForm, 'Previous page').disabled).toBe(true);

		await findButton(listForm, 'Next page').dispatch('click');
		await flush();

		expect(findButton(listForm, 'Previous page').disabled).toBe(true);
	});

	it('keeps history when navigating back to a previous page fails', async () => {
		let alertCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					if (alertCalls === 3) return response({ error: 'boom' }, 500);
					return response(alertCalls === 1
						? { alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } }
						: { alerts: [{ id: 'a2', text: 'second page alert', enriched: false }], pagination: { hasMore: false } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		await findButton(listForm, 'Next page').dispatch('click');
		await flush();
		expect(listForm.textContent).toContain('second page alert');
		expect(findButton(listForm, 'Previous page').disabled).toBe(false);

		await findButton(listForm, 'Previous page').dispatch('click');
		await flush();

		expect(findButton(listForm, 'Previous page').disabled).toBe(false);
	});

	it('discards an in-flight page response after filters change', async () => {
		let alertCalls = 0;
		let releaseNext;
		const slowNext = new Promise((resolve) => { releaseNext = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					if (alertCalls === 2) return slowNext.then(() => response({ alerts: [{ id: 'a2', text: 'second page alert', enriched: false }], pagination: { hasMore: false } }));
					return response({ alerts: [{ id: 'a1', text: 'first page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();

		const click = findButton(listForm, 'Next page').dispatch('click');
		await flush();
		expect(alertCalls).toBe(2);

		listForm.elements.source.value = 'webhook';
		await listForm.elements.source.dispatch('input');

		releaseNext();
		await click;
		await flush();

		expect(listForm.textContent).not.toContain('second page alert');
		expect(findButton(listForm, 'Previous page').disabled).toBe(true);
		expect(findButton(listForm, 'Next page').disabled).toBe(true);
	});

	it('stops job polling when the user signs out mid-refresh', async () => {
		let authStateChanged;
		const user = {
			getIdToken: jest.fn().mockResolvedValue('firebase-token'),
			getIdTokenResult: jest.fn().mockResolvedValue({ claims: { roles: ['admin.operator'] } }),
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
			signOut: jest.fn(async () => {
				await authStateChanged(null);
			}),
		};
		const firebase = { initializeApp: jest.fn(), auth: jest.fn(() => auth) };
		let statusCalls = 0;
		let releasePoll;
		const slowPoll = new Promise((resolve) => { releasePoll = resolve; });
		const browser = createBrowser({
			firebase,
			fetchImpl: async (url) => {
				if (url === '/admin/auth-config') {
					return response({ enabled: true, configured: true, config: { apiKey: 'k', authDomain: 'a', projectId: 'p' } });
				}
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-live') {
					statusCalls += 1;
					if (statusCalls === 1) return response({ jobId: 'job-live', type: 'market-scanner', status: 'processing', progress: {} });
					return slowPoll.then(() => response({ jobId: 'job-live', status: 'processing', progress: {} }));
				}
				return response({});
			},
		});
		await flush();
		browser.elementsById['auth-email'].value = 'operator@example.com';
		browser.elementsById['auth-password'].value = 'password';
		await browser.elementsById['sign-in'].dispatch('click');
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-live';
		await statusForm.dispatch('submit');
		await flush();

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);

		await browser.elementsById['sign-out'].dispatch('click');
		await flush();

		releasePoll();
		await flush();
		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);
	});

	it('stops auto-refresh on definitive failures but retries transient ones', async () => {
		let statusCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/jobs/job-gone') {
					statusCalls += 1;
					if (statusCalls === 1) return response({ jobId: 'job-gone', type: 'market-scanner', status: 'processing', progress: {} });
					return response({ error: 'not found' }, 404);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = 'job-gone';
		await statusForm.dispatch('submit');
		await flush();

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		await flush();
		expect(statusCalls).toBe(2);
		expect(findButton(statusForm, 'Pause auto-refresh').hidden).toBe(true);
	});

	it('trims pasted job IDs before guarding and requesting', async () => {
		const requests = [];
		let statusCalls = 0;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.includes('/api/jobs/job-live')) {
					statusCalls += 1;
					requests.push(url);
					return response(statusCalls === 1
						? { jobId: 'job-live', type: 'market-scanner', status: 'completed', progress: { current: 1, total: 1 } }
						: {});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'jobs');

		const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		statusForm.elements['path-jobId'].value = '  job-live  ';
		await statusForm.dispatch('submit');
		await flush();

		expect(requests.some((url) => url === '/api/jobs/job-live')).toBe(true);
		expect(findButton(statusForm, 'Get job status').disabled).toBe(false);
	});

	it('clears the generated before cursor when non-cursor filters change', async () => {
		let lastUrl = '';
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					lastUrl = url;
					return response({ alerts: [{ id: 'a1', text: 'page alert', enriched: false }], pagination: { hasMore: true, nextBefore: 'cursor-2' } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();
		await findButton(listForm, 'Next page').dispatch('click');
		await flush();
		expect(lastUrl).toContain('before=cursor-2');

		listForm.elements.source.value = 'webhook';
		await listForm.elements.source.dispatch('input');
		expect(listForm.elements.before.value).toBe('');

		await listForm.dispatch('submit');
		await flush();
		expect(lastUrl).not.toContain('before=');
	});

	it('restores the list form immediately when filters change mid-request', async () => {
		let alertCalls = 0;
		let releaseSlow;
		const slowRequest = new Promise((resolve) => { releaseSlow = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					alertCalls += 1;
					if (alertCalls === 1) return slowRequest.then(() => response({ alerts: [{ id: 'a1', text: 'slow page alert', enriched: false }], pagination: { hasMore: false } }));
					return response({ alerts: [], pagination: {} });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		const loadButton = findButton(listForm, 'Load alerts');
		const click = listForm.dispatch('submit');
		await flush();
		expect(alertCalls).toBe(1);

		listForm.elements.source.value = 'webhook';
		await listForm.elements.source.dispatch('input');

		expect(loadButton.disabled).toBe(false);

		releaseSlow();
		await flush();
		expect(findButton(listForm, 'Load alerts').disabled).toBe(false);
		expect(listForm.textContent).not.toContain('slow page alert');
		expect(listForm.textContent).toContain('Filters changed');
	});

	it('invalidates pending analytics when report filters change', async () => {
		let summaryCalls = 0;
		let releaseSlow;
		const slowSummary = new Promise((resolve) => { releaseSlow = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts/summary')) {
					summaryCalls += 1;
					if (summaryCalls === 1) return slowSummary.then(() => response({ success: true, summary: { totalAlerts: 9, window: {} } }));
					return response({ success: true, summary: { totalAlerts: 1, window: {} } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
		const loadButton = findButton(summaryForm, 'Load alert analytics');
		await summaryForm.dispatch('submit');
		await flush();
		expect(summaryCalls).toBe(1);

		summaryForm.elements.source.value = 'webhook';
		await summaryForm.elements.source.dispatch('input');

		expect(loadButton.disabled).toBe(false);
		expect(findButton(summaryForm, 'Copy JSON').hidden).toBe(true);

		releaseSlow();
		await flush();
		expect(find(summaryForm, (node) => node.tagName === 'PRE' && node.textContent.includes('totalAlerts'))).toBeUndefined();
		expect(summaryForm.textContent).toContain('Filters changed');
	});
	it('keeps navigation icons as inline SVG instead of platform glyphs', () => {
		const shell = fs.readFileSync(path.join(__dirname, '../../src/admin/index.html'), 'utf8');
		expect(shell.match(/<svg class="nav-icon"/g)).toHaveLength(7);
		expect(shell).not.toMatch(/[⌂◈◉◇◌✦▷]/);
	});
});
