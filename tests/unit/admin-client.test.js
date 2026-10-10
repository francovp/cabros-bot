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
		this.checked = false;
		this._text = '';
		this.name = '';
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

	// `children` is a plain array here but a live HTMLCollection in the browser, so
	// anything array-only (Array#pop) type-checks in tests and throws in Chrome.
	// This getter is what keeps the live feed's trim honest.
	get lastElementChild() {
		return this.children[this.children.length - 1] || null;
	}

	get firstChild() {
		return this.children[0] || null;
	}

	append(...nodes) {
		nodes.forEach((node) => {
			const selectFirstOption = this.tagName === 'SELECT' && this.children.length === 0;
			node.parentNode = this;
			this.children.push(node);
			if (selectFirstOption) {
				const firstOpt = node.tagName === 'OPTION' ? node : find(node, (n) => n.tagName === 'OPTION');
				if (firstOpt && firstOpt.value !== undefined) this.value = firstOpt.value;
			}
		});
	}

	replaceChildren(...nodes) {
		this.children = [];
		this._text = '';
		this.append(...nodes);
	}

	// Present because the console calls prepend() and falls back to an array
	// unshift() without it. That fallback leaves parentNode unset, which makes a
	// later lastElementChild.remove() a silent no-op and hangs the live feed's
	// trim loop. Modelling prepend keeps the fake on the browser's code path.
	prepend(...nodes) {
		nodes.reverse().forEach((node) => {
			node.parentNode = this;
			this.children.unshift(node);
		});
	}

	addEventListener(type, listener) {
		(this.listeners[type] ||= []).push(listener);
	}

	// Returns the dispatched event so a test can assert `defaultPrevented`. That flag
	// is the only proxy for "the form did not navigate" here: the fake cannot perform
	// a native GET, and an unhandled submit is exactly how a password would reach the
	// URL.
	async dispatch(type) {
		const event = {
			type,
			defaultPrevented: false,
			preventDefault() { this.defaultPrevented = true; },
		};
		for (const listener of this.listeners[type] || []) await listener(event);
		return event;
	}

	setAttribute(name, value) {
		this.attributes[name] = String(value);
		if (name === 'name') this.name = String(value);
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

	// The credential forms lean on the browser's own constraints, and the fake
	// dispatches `submit` directly rather than routing through a browser, so the
	// double has to enforce them or every "invalid submit" assertion is vacuous.
	// Values are NOT trimmed: a browser's `required` accepts '   ', and a double
	// stricter than the browser would hide exactly that gap in production code.
	checkValidity() {
		const value = String(this.value == null ? '' : this.value);
		if (this.required && value === '') return false;
		if (this.type === 'email' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
		return true;
	}

	querySelector(selector) {
		const results = this.querySelectorAll(selector);
		return results[0] || null;
	}
	focus() {
		this._focused = true;
	}

	get tabIndex() {
		return this._tabIndex;
	}

	set tabIndex(value) {
		this._tabIndex = value;
	}

	querySelectorAll(selector) {
		if (selector === '[data-view]') return findAll(this, (node) => node.dataset.view);
		// Simple querySelectorAll for common selectors used in the builder functions
		return findAll(this, (node) => {
			if (selector.startsWith('select[name=') || selector.startsWith('input[name=') || selector.startsWith('textarea[name=')) {
				const attrMatch = selector.match(/\[name=([^\]]+)\]/);
				if (attrMatch && node.attributes['name'] === attrMatch[1]) return true;
				if (attrMatch && node.name === attrMatch[1]) return true;
			}
			if (selector === 'textarea[name=body]') {
				return node.tagName === 'TEXTAREA' && node.name === 'body';
			}
			if (selector.startsWith('option:checked')) {
				return node.tagName === 'OPTION' && node.selected;
			}
			return false;
		});
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

const streamResponse = ({ status = 200, retryAfter, done = false } = {}) => ({
	ok: status >= 200 && status < 300,
	status,
	headers: {
		get: (name) => name.toLowerCase() === 'retry-after' ? retryAfter : null,
	},
	body: {
		getReader: () => ({
			read: async () => ({ done }),
		}),
	},
});

// An established stream that stays open and never emits, matching a real event
// stream between events. A reader that keeps resolving { done: false } instead
// would spin the client's read loop without yielding and starve the event loop.
const idleStreamResponse = () => ({
	ok: true,
	status: 200,
	headers: { get: () => null },
	body: {
		getReader: () => ({ read: () => new Promise(() => {}) }),
	},
});

// A stream whose chunks are pushed by the test, so an SSE subscriber can be fed
// real `event:`/`data:` frames and then observed to stop receiving them.
const createControllableStream = () => {
	const encoder = new TextEncoder();
	const pending = [];
	let notify = null;
	return {
		response: () => ({
			ok: true,
			status: 200,
			headers: { get: () => null },
			body: {
				getReader: () => ({
					read: () => new Promise((resolve) => {
						if (pending.length) {
							const chunk = pending.shift();
							resolve({ done: false, value: chunk });
							return;
						}
						notify = () => {
							notify = null;
							if (pending.length) resolve({ done: false, value: pending.shift() });
						};
					}),
				}),
			},
		}),
		emit: (eventType, data) => {
			pending.push(encoder.encode(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`));
			const wake = notify;
			notify = null;
			if (wake) wake();
		},
	};
};

function createBrowser({ fetchImpl, confirm = () => true, storedKey = '', firebase, location = {} }) {
	const body = new FakeElement('body');
	const elementsById = {};
	[
		['legacy-connection', 'section', {}],
		['firebase-auth', 'section', {}],
		['auth-form', 'form', {}],
		['auth-email', 'input', { type: 'email', name: 'email', required: true, autocomplete: 'username' }],
		['auth-password', 'input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' }],
		['auth-credentials-error', 'p', { role: 'alert', hidden: true }],
		['sign-in', 'button', { type: 'submit' }],
		['sign-out', 'button', { type: 'button' }],
		['auth-state', 'p', {}],
		['api-key', 'input', { type: 'password', name: 'apiKey', required: true, autocomplete: 'off' }],
		['key-state', 'p', {}],
		['save-key', 'button', { type: 'submit' }],
		['clear-key', 'button', { type: 'button' }],
		['connection-form', 'form', {}],
		['view', 'section', {}],
		['view-status', 'p', { role: 'status' }],
		['sse-status', 'div', { role: 'status' }],
		['sse-label', 'span', {}],
		['console-shell', 'div', {}],
		['toggle-sidebar', 'button', { type: 'button' }],
	].forEach(([id, tag, attributes]) => {
		const node = new FakeElement(tag);
		node.id = id;
		node.hidden = attributes.hidden === true;
		Object.assign(node, attributes);
		node.attributes = { ...attributes };
		elementsById[id] = node;
		body.append(node);
	});
	['overview', 'status', 'diagnostics', 'alerts', 'outcomes', 'presets', 'jobs', 'orders', 'analysis', 'newsMonitor', 'trading', 'playground'].forEach((view) => {
		const button = new FakeElement('button');
		button.dataset.view = view;
		body.append(button);
	});

	const documentListeners = {};
	const downloads = [];
	const timers = new Map();
	const timerDelays = new Map();
	const timerHistory = [];
	const titleHistory = [''];
	const document = {
		body,
		createElement: (tag) => {
			const node = new FakeElement(tag);
			if (tag === 'cabros-result') Object.defineProperty(node, 'value', { set(value) { this.textContent = require('../../src/admin/admin-components').plainText(value); } });
			if (tag === 'a') node.click = () => downloads.push({ href: node.href, download: node.download });
			return node;
		},
		// Deliberately does not assert the SVG namespace, unlike admin-charts.test.js: this fake only
		// needs the nodes to be walkable by the same findAll the other DOM assertions use.
		createElementNS: (_namespaceURI, tag) => new FakeElement(tag),
		getElementById: (id) => elementsById[id],
		querySelectorAll: (selector) => body.querySelectorAll(selector),
		addEventListener: (type, listener) => { documentListeners[type] = listener; },
		execCommand: () => false,
		get title() {
			return titleHistory[titleHistory.length - 1];
		},
		set title(value) {
			titleHistory.push(String(value));
		},
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
	const windowLocation = { hostname: '', pathname: '/admin', search: '', ...location };
	const historyCalls = [];
	const windowListeners = {};
	const applyHistoryUrl = (url) => {
		const raw = String(url ?? '');
		const [pathAndQuery, hash = ''] = raw.split('#');
		const queryAt = pathAndQuery.indexOf('?');
		windowLocation.pathname = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
		windowLocation.search = queryAt === -1 ? '' : pathAndQuery.slice(queryAt);
		if (hash) windowLocation.hash = `#${hash}`;
	};
	const historyStub = {
		pushState: (_state, _title, url) => {
			historyCalls.push({ mode: 'push', url: String(url ?? '') });
			applyHistoryUrl(url);
		},
		replaceState: (_state, _title, url) => {
			historyCalls.push({ mode: 'replace', url: String(url ?? '') });
			applyHistoryUrl(url);
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
		TextDecoder,
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
			timerHistory.push(delay);
			return id;
		},
		clearTimeout: (id) => { timers.delete(id); timerDelays.delete(id); },
		window: {
			CabrosAdminRequest: helper,
			CabrosAdminComponents: require('../../src/admin/admin-components'),
			confirm,
			firebase,
			history: historyStub,
			location: windowLocation,
			addEventListener: (type, listener) => { (windowListeners[type] ||= []).push(listener); },
			URL: {
				createObjectURL: jest.fn((blob) => `blob:${blob.type}`),
				revokeObjectURL: jest.fn(),
			},
		},
	};
	context.window.fetch = context.fetch;
	// admin-charts.js, admin-diagnostics.js and admin-newsmonitor.js are evaluated in the
	// browser context, not require()d into Node: they build nodes through the ambient
	// `document`, which only exists inside this vm, and they publish their APIs onto the
	// shared `window` object that admin.js reads. Order mirrors the deferred <script> order
	// in index.html.
	[
		'admin-charts.js',
		'admin-diagnostics.js',
		'admin-newsmonitor.js',
		'admin.js',
	].forEach((relative) => {
		vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../src/admin', relative), 'utf8'), context);
	});
	documentListeners.DOMContentLoaded();

	const dispatchPopState = async () => {
		for (const listener of windowListeners.popstate || []) await listener({ type: 'popstate' });
		await flush();
	};

	return {
		body,
		context,
		elementsById,
		helperCalls,
		storage,
		downloads,
		timers,
		timerDelays,
		timerHistory,
		titleHistory,
		historyCalls,
		location: windowLocation,
		dispatchPopState,
	};
}

async function selectView(browser, name) {
	await find(browser.body, (node) => node.dataset.view === name).dispatch('click');
	await flush();
}

describe('admin browser client', () => {
	it('uses visual controls instead of editable JSON throughout the console', async () => {
		const browser = createBrowser({ fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}) });
		await flush();
		for (const name of ['alerts', 'presets', 'jobs', 'analysis', 'playground']) {
			await selectView(browser, name);
			const view = browser.elementsById.view;
			const payloads = findAll(view, (node) => ['body', 'query'].includes(node.name));
			expect(payloads.length).toBeGreaterThan(0);
			payloads.forEach((input) => expect(input.type).toBe('hidden'));
			expect(findAll(view, (node) => node.tagName === 'CABROS-FIELDS').length).toBeGreaterThan(0);
			expect(view.textContent).not.toMatch(/Request body JSON|Query JSON|Show raw|Copy JSON/);
		}
	});

	it('reconnects after the SSE stream ends cleanly', async () => {
		const browser = createBrowser({
			storedKey: 'test-key',
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/admin/events') return streamResponse({ done: true });
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await browser.elementsById['connection-form'].dispatch('submit');
		await flush();
		expect(browser.context.fetch.mock.calls.map(([url]) => url)).toContain('/api/admin/events');

		expect(browser.elementsById['sse-label'].textContent).toBe('Reconnecting…');
		expect(browser.timers.size).toBe(1);
	});

	it('does not reconnect on permanent SSE authorization failures', async () => {
		const browser = createBrowser({
			storedKey: 'test-key',
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/admin/events') return streamResponse({ status: 403 });
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await browser.elementsById['connection-form'].dispatch('submit');
		await flush();

		expect(browser.elementsById['sse-label'].textContent).toBe('Unavailable');
		expect(browser.timers.size).toBe(0);
	});

	it('honors fractional Retry-After delays for retryable SSE failures', async () => {
		const browser = createBrowser({
			storedKey: 'test-key',
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/admin/events') return streamResponse({ status: 503, retryAfter: '2.5' });
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await browser.elementsById['connection-form'].dispatch('submit');
		await flush();

		expect([...browser.timerDelays.values()]).toContain(2500);
	});

	// GH-1201: `fetch` on an SSE endpoint only settles once response headers
	// arrive, so a connection that never flushes headers left the handshake
	// pending forever and the console sat on "Connecting…" without reconnecting.
	it('aborts and reconnects a stalled SSE handshake instead of hanging on Connecting', async () => {
		const browser = createBrowser({
			storedKey: 'test-key',
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/admin/events') {
					// Resolve only when the handshake deadline aborts us.
					return new Promise((_resolve, reject) => {
						options.signal.addEventListener('abort', () => {
							const error = new Error('The operation was aborted');
							error.name = 'AbortError';
							reject(error);
						});
					});
				}
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await browser.elementsById['connection-form'].dispatch('submit');
		await flush();

		// The only armed timer must be the handshake deadline: the request is
		// still pending, so no reconnect backoff exists yet.
		expect([...browser.timerDelays.values()]).toEqual([15000]);
		expect(browser.elementsById['sse-label'].textContent).toBe('Connecting…');

		// Fire the handshake deadline.
		const [handshakeTimer] = [...browser.timers.keys()];
		await browser.timers.get(handshakeTimer)();
		await flush();

		expect(browser.elementsById['sse-label'].textContent).toBe('Reconnecting…');
	});

	it('clears the handshake deadline once headers arrive so an idle stream stays live', async () => {
		const browser = createBrowser({
			storedKey: 'test-key',
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/admin/events') return idleStreamResponse();
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await browser.elementsById['connection-form'].dispatch('submit');
		await flush();

		expect(browser.elementsById['sse-label'].textContent).toBe('Live');
		// The deadline must be armed for the handshake and then disarmed: an SSE
		// body is legitimately idle between events, so a surviving timer would
		// tear down a healthy stream.
		expect(browser.timerHistory).toContain(15000);
		expect(browser.timers.size).toBe(0);
	});

	// GH-1201: `aborted` alone cannot separate an intentional teardown from our
	// own handshake deadline. `disconnectSse()` nulls `sseAbortController`, so
	// ownership ("am I still the current stream?") is the discriminator.
	// Collapsing this back to `if (aborted) return` makes the handshake deadline
	// above convert a hang into a permanently dead stream that never reconnects.
	it('does not reconnect when an intentional disconnect aborts the handshake', async () => {
		const browser = createBrowser({
			storedKey: 'test-key',
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/admin/events') {
					return new Promise((_resolve, reject) => {
						options.signal.addEventListener('abort', () => {
							const error = new Error('The operation was aborted');
							error.name = 'AbortError';
							reject(error);
						});
					});
				}
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await browser.elementsById['connection-form'].dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toEqual([15000]);

		// clear-key is the unconditional operator teardown (sign-out routes to the
		// same disconnectSse()): it aborts the controller and clears ownership.
		await browser.elementsById['clear-key'].dispatch('click');
		await flush();

		expect(browser.elementsById['sse-label'].textContent).toBe('Offline');
		// No reconnect backoff may be armed behind a deliberate disconnect, and
		// the handshake deadline must be disarmed with the controller it guarded.
		expect([...browser.timerDelays.values()]).toEqual([]);
	});

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

	it('uses effective dependency health in overview cards', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				sentry: { status: 'ready', profiling: { status: 'misconfigured' } },
			},
		};
		const browser = createBrowser({
			fetchImpl: async (url) => url === '/openapi.json' ? response(contract) : response(status),
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'overview');
		await flush();

		expect(browser.elementsById.view.textContent).toContain('SentryNeeds attention');
	});

	it('renders the status view as a searchable dependency explorer', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production', commit: 'abc123' },
			featureFlags: { telegramBot: true },
			deliveryChannels: {
				telegram: { enabled: true, status: 'ready' },
				whatsapp: { enabled: false, status: 'disabled' },
			},
			dependencies: {
				telegram: { enabled: true, configured: true, status: 'ready', provider: 'Telegram' },
				tradingViewMcp: {
					enabled: true,
					configured: true,
					status: 'degraded',
					provider: 'MCP',
					lastCheckedAt: '2026-08-31T00:00:00Z',
					lastSuccessAt: '2026-08-30T23:00:00Z',
					lastFailureAt: '2026-08-30T23:30:00Z',
					lastErrorCategory: '<img src=x onerror=alert(1)>',
					successCount: 4,
					failureCount: 2,
				},
				scannerPresetStorage: {
					enabled: false,
					configured: false,
					status: 'disabled',
					mode: 'ephemeral',
					backend: 'memory',
				},
				groundingCoalescing: {
					enabled: true,
					windowMs: 5000,
					hits: 3,
				},
				unknownDependency: { status: 'unknown' },
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		const cards = () => findAll(view, (node) => node.className.includes('status-detail-card'));
		expect(view.textContent).toContain('Dependency health');
		expect(view.textContent).toContain('TradingView MCP');
		expect(view.textContent).toContain('Needs attention');
		expect(view.textContent).toContain('<img src=x onerror=alert(1)>');
		expect(view.textContent).toContain('Successes4');
		expect(view.textContent).toContain('ephemeral');
		expect(view.textContent).toContain('2 need attention');
		expect(cards()).toHaveLength(5);
		expect(cards()[0].textContent).toContain('TradingView MCP');
		expect(cards()[1].textContent).toContain('Unknown Dependency');
		expect(cards()[2].textContent).toContain('Grounding Coalescing');
		expect(cards().some((card) => card.textContent.includes('TradingView MCP'))).toBe(true);
		expect(cards().some((card) => card.textContent.includes('Scanner preset storage'))).toBe(true);
		expect(cards().some((card) => card.textContent.includes('Grounding Coalescing'))).toBe(true);
		expect(findAll(view, (node) => node.tagName === 'IMG')).toHaveLength(0);

		const search = find(view, (node) => node.tagName === 'INPUT' && node.name === 'dependency-search');
		search.value = 'Telegram';
		await search.dispatch('input');
		expect(cards()).toHaveLength(1);
		expect(cards()[0].textContent).toContain('Telegram');

		search.value = '';
		await search.dispatch('input');
		const tone = find(view, (node) => node.tagName === 'SELECT' && node.name === 'dependency-tone');
		tone.value = 'ready';
		await tone.dispatch('change');
		expect(cards()).toHaveLength(1);
		expect(cards()[0].textContent).toContain('Telegram');

		tone.value = 'attention';
		await tone.dispatch('change');
		expect(cards()).toHaveLength(2);
		expect(cards()[0].textContent).toContain('TradingView MCP');

		tone.value = 'unknown';
		await tone.dispatch('change');
		expect(cards()).toHaveLength(1);
		expect(cards()[0].textContent).toContain('Unknown Dependency');
	});

	it('renders Binance trading safety fields in dependency details', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				binanceTrading: {
					status: 'ready',
					environment: 'testnet',
					allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
					maxNotionalConfigured: true,
				},
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
		await selectView(browser, 'status');
		await flush();

		const card = find(browser.elementsById.view, (node) => node.className.includes('status-detail-card'));
		expect(card.textContent).toContain('Environmenttestnet');
		expect(card.textContent).toContain('Allowed symbolsBTCUSDT, ETHUSDT');
		expect(card.textContent).toContain('Max notional configuredtrue');
	});

	it('renders safe operational counters in dependency details', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				groundingCoalescing: { enabled: true, windowMs: 5000, activeEntries: 2, hits: 3, misses: 4, failures: 1 },
				alertSignalRepeatSuppression: {
					enabled: true,
					suppressedCount: 7,
					lastSuppressedAt: '2026-09-08T00:00:00Z',
					activeTrackedSignals: 2,
				},
				newsMonitorScheduler: {
					status: 'ready', intervalMs: 300000, batchLimit: 10, lastRunExecutedCount: 4, lastRunErrorCount: 1,
				},
				notificationRedrive: {
					status: 'ready', intervalMs: 60000, batchLimit: 25, maxAttempts: 5, maxAgeMs: 86400000, pendingCount: 2, deliveredCount: 9,
					exhaustedCount: 1, zeroChannelBroadcasts: 4, lastRunScannedCount: 8, lastRunRedrivenCount: 3,
				},
				whatsappCommandBridge: {
					status: 'degraded', lastPollAt: '2026-09-08T00:00:00Z',
					lastError: 'poll failed', lastErrorAt: '2026-09-08T00:01:00Z',
				},
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Window (ms)5000');
		expect(view.textContent).toContain('Active entries2');
		expect(view.textContent).toContain('Hits3');
		expect(view.textContent).toContain('Misses4');
		expect(view.textContent).toContain('Suppressed7');
		expect(view.textContent).toContain('Active tracked signals2');
		expect(view.textContent).toContain('Interval (ms)300000');
		expect(view.textContent).toContain('Batch limit10');
		expect(view.textContent).toContain('Max attempts5');
		expect(view.textContent).toContain('Max age (ms)86400000');
		expect(view.textContent).toContain('Last run executed4');
		expect(view.textContent).toContain('Last run scanned8');
		expect(view.textContent).toContain('Last run redriven3');
		expect(view.textContent).toContain('Pending2');
		expect(view.textContent).toContain('Delivered9');
		expect(view.textContent).toContain('Exhausted1');
		expect(view.textContent).toContain('Zero-channel broadcasts4');
		expect(view.textContent).toContain('Last poll');
		expect(view.textContent).toContain('Last error detailpoll failed');
		expect(view.textContent).toContain('Last error at');
	});

	it('renders durable storage readiness counters so an operator can tell unverified from misconfigured', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: { symbolAnalysisStorage: true },
			dependencies: {
				symbolAnalysisStorage: {
					enabled: true,
					configured: true,
					ready: false,
					status: 'unverified',
					readiness: 'unverified',
					failOpen: true,
					collection: 'symbolAnalyses',
					retentionDays: 7,
					writesAttempted: 0,
					writesSucceeded: 0,
					writesFailed: 0,
					readsAttempted: 2,
					readsSucceeded: 2,
					readsFailed: 0,
					consecutiveFailures: 0,
					lastWriteAt: null,
					lastFailureAt: null,
					lastErrorReason: null,
				},
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Symbol analysis storage');
		expect(view.textContent).toContain('Readinessunverified');
		expect(view.textContent).toContain('Fail opentrue');
		expect(view.textContent).toContain('CollectionsymbolAnalyses');
		expect(view.textContent).toContain('Retention (days)7');
		expect(view.textContent).toContain('Writes attempted0');
		expect(view.textContent).toContain('Writes succeeded0');
		expect(view.textContent).toContain('Reads attempted2');
		expect(view.textContent).toContain('Reads succeeded2');
	});

	it('includes nested profiling health in dependency attention', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				sentry: {
					status: 'ready',
					profiling: { status: 'misconfigured', enabled: true, configured: false },
				},
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('1 need attention');
		expect(view.textContent).not.toContain('Dependencies1 ready');
		expect(view.textContent).toContain('Profiling');
		expect(view.textContent).toContain('ProfilingNeeds attention');
		const dependencyCard = find(view, (node) => node.className.includes('status-detail-card'));
		const summaryBadge = find(dependencyCard, (node) => node.className.includes('status-badge'));
		expect(summaryBadge.className).toContain('status-misconfigured');
		expect(summaryBadge.textContent).toBe('Needs attention');
		const search = find(view, (node) => node.tagName === 'INPUT' && node.name === 'dependency-search');
		search.value = 'misconfigured';
		await search.dispatch('input');
		expect(findAll(view, (node) => node.className.includes('status-detail-card'))).toHaveLength(1);
		search.value = 'Needs attention';
		await search.dispatch('input');
		expect(findAll(view, (node) => node.className.includes('status-detail-card'))).toHaveLength(1);
		const tone = find(view, (node) => node.tagName === 'SELECT' && node.name === 'dependency-tone');
		tone.value = 'ready';
		await tone.dispatch('change');
		expect(findAll(view, (node) => node.className.includes('status-detail-card'))).toHaveLength(0);
	});

	it('renders Gemini quota cooldown telemetry in dependency details', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				geminiQuota: {
					status: 'degraded', cooldownActive: true, remainingCooldownMs: 4500,
					lastTriggeredAt: '2026-09-08T00:00:00Z', triggersTotal: 2,
					braveFallbacksDuringCooldown: 3, lastBraveFallbackAt: '2026-09-08T00:01:00Z',
					metrics: { totalRequests: 10, successRequests: 7, failureRequests: 2, timeoutRequests: 1 },
				},
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Cooldown activetrue');
		expect(view.textContent).toContain('Remaining cooldown (ms)4500');
		expect(view.textContent).toContain('Triggers total2');
		expect(view.textContent).toContain('Brave fallbacks during cooldown3');
		expect(view.textContent).toContain('Last triggered');
		expect(view.textContent).toContain('Last Brave fallback');
		expect(view.textContent).toContain('Total requests10');
		expect(view.textContent).toContain('Success requests7');
		expect(view.textContent).toContain('Failure requests2');
		expect(view.textContent).toContain('Timeout requests1');
	});

	it('clears every structured status section after a refresh failure', async () => {
		let statusRequests = 0;
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: { telegramBot: true },
			deliveryChannels: { telegram: { status: 'ready' } },
			dependencies: { telegram: { status: 'ready' } },
		};
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/status') return ++statusRequests === 1 ? response(status) : response({ error: 'temporary failure' }, 503);
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Telegram');
		expect(view.textContent).toContain('Last checked');

		await findButton(view, 'Refresh status').dispatch('click');
		await flush();

		expect(view.textContent).not.toContain('Telegram');
		expect(view.textContent).not.toContain('Telegram Bot');
		expect(view.textContent).not.toContain('Last checked');
		expect(view.textContent).toContain('Status unavailable. Check the API key and service logs.');
	});

	it('renders safe queue telemetry in dependency details', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				jobExecutionQueue: {
					status: 'disabled', mode: 'local', enqueued: 12, claimed: 10, completed: 9, failed: 1,
					lastErrorCode: 'QUEUE_TIMEOUT', lastEnqueuedAt: '2026-09-08T00:00:00Z',
				},
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Enqueued12');
		expect(view.textContent).toContain('Claimed10');
		expect(view.textContent).toContain('Completed9');
		expect(view.textContent).toContain('Failed1');
		expect(view.textContent).toContain('Last error codeQUEUE_TIMEOUT');
		expect(view.textContent).toContain('Last enqueued');
	});

	it('renders circuit breaker and Remote Config timestamps in dependency details', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				tradingViewMcp: {
					status: 'degraded',
					circuitBreaker: {
						state: 'open',
						openedAt: '2026-09-08T00:00:00Z',
						cooldownMs: 120000,
						consecutiveFailures: 3,
					},
				},
				remoteConfig: {
					status: 'ready',
					lastSuccessfulLoad: '2026-09-08T00:01:00Z',
				},
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Circuit breaker stateopen');
		expect(view.textContent).toContain('Circuit breaker opened');
		expect(view.textContent).toContain('Circuit breaker cooldown (ms)120000');
		expect(view.textContent).toContain('Circuit breaker consecutive failures3');
		expect(view.textContent).toContain('Last successful load');
	});

	it('renders alert-path enrichment telemetry in dependency details', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				tradingViewMcp: {
					status: 'ready',
					enrichment: {
						alertPath: {
							windowMs: 86400000, totalCount: 5, appliedCount: 3, failedCount: 2,
							appliedRate24h: 60, failureRate24h: 40,
						},
					},
				},
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
		await selectView(browser, 'status');
		await flush();

		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Alert path total5');
		expect(view.textContent).toContain('Alert path applied3');
		expect(view.textContent).toContain('Alert path failed2');
		expect(view.textContent).toContain('Alert path applied rate (%)60');
		expect(view.textContent).toContain('Alert path failure rate (%)40');
	});

	it('renders the signal outcome sweep lease counters in dependency details', async () => {
		const status = {
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			dependencies: {
				signalOutcomeWorker: {
					status: 'ready',
					role: 'web',
					leaseMs: 120000,
					lastRunLeaseHeld: true,
					leaseHeldSkipCount: 138,
					lastRunEvaluatedCount: 0,
				},
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
		await selectView(browser, 'status');
		await flush();

		// Without these the operator cannot tell which replica is evaluating, which
		// is the whole reason the counters exist.
		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Lease (ms)120000');
		expect(view.textContent).toContain('Last run lease heldtrue');
		expect(view.textContent).toContain('Lease-held skips138');
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
				hostname: 'cabros-bot--pr-1211-abcdef.web.app',
				search: '?backend=https%3A%2F%2Fattacker.example',
			},
			fetchImpl: async (url) => {
				requests.push(url);
				if (url.endsWith('/openapi.json')) return response(contract);
				return response({ enabled: false, configured: false });
			},
		});
		await flush();

		expect(requests[0]).toBe('https://openclaw.tail5e4271.ts.net/admin/auth-config');
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
		await selectView(browser, 'status');
		browser.elementsById['api-key'].value = 'test-key';
		const refreshButton = findButton(browser.elementsById.view, 'Refresh status');
		await refreshButton.dispatch('click');
		await flush();

		expect(browser.timers.size).toBe(1);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();

		expect(signal.aborted).toBe(true);
		expect(browser.elementsById.view.textContent).toContain('Network error');
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
					&& !url.includes('/api/webhook/volume-confirmation')
					&& !url.includes('/api/webhook/symbol-analysis')) return response({});
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

		expect([...browser.timerDelays.values()]).toContain(990000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[0].aborted).toBe(true);

		await selectView(browser, 'analysis');
		await findForm(browser.elementsById.view, 'POST /api/news-monitor').dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toContain(990000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[1].aborted).toBe(true);

		await selectView(browser, 'presets');
		await findForm(browser.elementsById.view, 'POST /api/scanner-presets/{id}/run').dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toContain(990000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[2].aborted).toBe(true);

		await selectView(browser, 'analysis');
		await findForm(browser.elementsById.view, 'POST /api/webhook/volume-confirmation').dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toContain(390000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[3].aborted).toBe(true);

		await selectView(browser, 'analysis');
		await findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis').dispatch('submit');
		await flush();
		expect([...browser.timerDelays.values()]).toContain(150000);
		for (const fireTimer of browser.timers.values()) fireTimer();
		await flush();
		expect(signals[4].aborted).toBe(true);
	});

	it('does not abort slow responses that resolve within the maximum budget for volume-confirmation and alerts', async () => {
		let volumeResolver;
		let alertResolver;
		const browser = createBrowser({
			fetchImpl: (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.includes('/api/webhook/volume-confirmation')) {
					return new Promise((resolve) => {
						volumeResolver = resolve;
					});
				}
				if (url.includes('/api/webhook/alert')) {
					return new Promise((resolve) => {
						alertResolver = resolve;
					});
				}
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';

		// Volume confirmation slow response within budget
		await selectView(browser, 'analysis');
		const volumeForm = findForm(browser.elementsById.view, 'POST /api/webhook/volume-confirmation');
		await volumeForm.dispatch('submit');
		await flush();

		expect([...browser.timerDelays.values()]).toContain(390000);
		expect(browser.timers.size).toBe(1);

		// Resolve slow valid response before deadline
		volumeResolver(response({ success: true, volumeConfirmed: true }));
		await flush();

		expect(browser.timers.size).toBe(0);
		expect(volumeForm.textContent).toContain('Volume Confirmed');

		// Webhook alert slow response within budget via Playground
		await selectView(browser, 'playground');
		const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
			&& node.textContent.includes('Operations'));
		const select = find(playground, (node) => node.tagName === 'SELECT');
		select.value = find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes('POST /api/webhook/alert')).value;
		await select.dispatch('change');
		await playground.dispatch('submit');
		await flush();

		expect([...browser.timerDelays.values()]).toContain(990000);
		expect(browser.timers.size).toBe(1);

		// Resolve slow valid response before deadline
		alertResolver(response({ success: true, messageId: '12345' }));
		await flush();

		expect(browser.timers.size).toBe(0);
		expect(playground.textContent).toContain('12345');
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
		await browser.elementsById['connection-form'].dispatch('submit');
		expect(browser.storage.has('cabros-admin-api-key')).toBe(false);
		expect(browser.elementsById['key-state'].textContent).toContain('in memory');

		browser.elementsById['auth-email'].value = 'operator@example.com';
		browser.elementsById['auth-password'].value = 'password';
		await browser.elementsById['auth-form'].dispatch('submit');
		await flush();

		const statusViewButton = find(browser.body, (node) => node.dataset.view === 'status');
		const overviewViewButton = find(browser.body, (node) => node.dataset.view === 'overview');
		expect(statusViewButton.attributes['aria-current']).toBe('page');
		expect(overviewViewButton.attributes['aria-current']).toBeUndefined();
		const refreshButton = findButton(browser.elementsById.view, 'Refresh status');
		expect(refreshButton).toBeDefined();
		await refreshButton.dispatch('click');
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

	// #951: both credential paths are real forms, so Enter submits them and the
	// browser owns constraint validation. The fake dispatches `submit` directly, so
	// the structural assertions below plus FakeElement#checkValidity carry the part
	// a real browser would do for free.
	describe('credential entry forms', () => {
		const AUTH_CONFIG = {
			enabled: true,
			configured: true,
			config: { apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros' },
		};

		const firebaseBrowser = (attempt) => {
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
				signInWithEmailAndPassword: jest.fn(async (email, password) => {
					await attempt(email, password);
					await authStateChanged(user);
				}),
				signOut: jest.fn().mockResolvedValue(undefined),
			};
			const browser = createBrowser({
				firebase: { initializeApp: jest.fn(), auth: jest.fn(() => auth) },
				fetchImpl: async (url) => {
					if (url === '/admin/auth-config') return response(AUTH_CONFIG);
					if (url === '/openapi.json') return response(contract);
					return response({});
				},
			});
			return { auth, browser };
		};

		it('declares both credential controls as native forms', () => {
			const shell = fs.readFileSync(path.join(__dirname, '../../src/admin/index.html'), 'utf8');
			const authForm = shell.match(/<form id="auth-form"[\s\S]*?<\/form>/)[0];
			const legacyForm = shell.match(/<form id="connection-form"[\s\S]*?<\/form>/)[0];

			expect(shell).not.toMatch(/<form[^>]*\bnovalidate/);
			expect(authForm).toMatch(/<label for="auth-email">/);
			expect(authForm).toMatch(/id="auth-email"[^>]*name="email"[^>]*type="email"[^>]*autocomplete="username"[^>]*required/);
			expect(authForm).toMatch(/<label for="auth-password">/);
			expect(authForm).toMatch(/id="auth-password"[^>]*name="password"[^>]*type="password"[^>]*autocomplete="current-password"[^>]*required/);
			expect(authForm).toMatch(/id="auth-email"[^>]*aria-describedby="auth-credentials-error"/);
			expect(authForm).toMatch(/id="auth-password"[^>]*aria-describedby="auth-credentials-error"/);
			expect(authForm).toMatch(/id="auth-credentials-error"[^>]*role="alert"/);
			expect(authForm).toMatch(/<button id="sign-in"[^>]*type="submit"/);

			expect(legacyForm).toMatch(/<label for="api-key">/);
			expect(legacyForm).toMatch(/id="api-key"[^>]*name="apiKey"[^>]*required[^>]*aria-describedby="key-state"/);
			expect(legacyForm).toMatch(/<button id="save-key"[^>]*type="submit"/);
			expect(shell).not.toMatch(/type="button">(?:Sign in|Use key)/);
		});

		it('submits exactly once from either credential field', async () => {
			const { auth, browser } = firebaseBrowser(async () => {});
			await flush();

			// A submit-type button is what makes Enter work, and no keydown handler
			// may swallow the key before the browser's implicit submission.
			expect(browser.elementsById['sign-in'].type).toBe('submit');
			expect(browser.elementsById['auth-email'].listeners.keydown).toBeUndefined();
			expect(browser.elementsById['auth-password'].listeners.keydown).toBeUndefined();

			browser.elementsById['auth-email'].value = 'operator@example.com';
			browser.elementsById['auth-password'].value = 'secret';
			await browser.elementsById['auth-form'].dispatch('submit');
			await flush();

			expect(auth.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
			expect(auth.signInWithEmailAndPassword).toHaveBeenCalledWith('operator@example.com', 'secret');
		});

		it('rejects blank and malformed credential input before calling the SDK', async () => {
			const { auth, browser } = firebaseBrowser(async () => {});
			await flush();
			const error = browser.elementsById['auth-credentials-error'];

			browser.elementsById['auth-email'].value = 'operator@example.com';
			await browser.elementsById['auth-form'].dispatch('submit');
			expect(auth.signInWithEmailAndPassword).not.toHaveBeenCalled();
			expect(error.hidden).toBe(false);
			expect(error.textContent).toContain('Enter an email address and password');
			expect(browser.elementsById['auth-email'].attributes['aria-invalid']).toBe('true');
			expect(browser.elementsById['auth-password'].attributes['aria-invalid']).toBe('true');

			browser.elementsById['auth-password'].value = 'super-secret';
			browser.elementsById['auth-email'].value = 'not-an-email';
			await browser.elementsById['auth-form'].dispatch('submit');
			expect(auth.signInWithEmailAndPassword).not.toHaveBeenCalled();
			expect(error.textContent).not.toContain('not-an-email');
			expect(error.textContent).not.toContain('super-secret');
		});

		it('associates a rejected sign-in with the credentials without echoing them', async () => {
			const { auth, browser } = firebaseBrowser(async () => { throw new Error('auth/invalid-credential'); });
			await flush();
			const error = browser.elementsById['auth-credentials-error'];

			browser.elementsById['auth-email'].value = 'operator@example.com';
			browser.elementsById['auth-password'].value = 'hunter2-super-secret';
			await browser.elementsById['auth-form'].dispatch('submit');
			await flush();

			expect(auth.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
			expect(error.hidden).toBe(false);
			expect(error.textContent).toContain('Sign-in failed');
			expect(error.textContent).not.toContain('hunter2-super-secret');
			expect(error.textContent).not.toContain('operator@example.com');
			expect(browser.elementsById['auth-email'].attributes['aria-invalid']).toBe('true');
			expect(browser.elementsById['auth-password'].attributes['aria-invalid']).toBe('true');
		});

		it('clears the rejected credential state when the operator edits a field', async () => {
			const { auth, browser } = firebaseBrowser(async () => {});
			await flush();
			const error = browser.elementsById['auth-credentials-error'];

			browser.elementsById['auth-email'].value = 'not-an-email';
			await browser.elementsById['auth-form'].dispatch('submit');
			expect(error.hidden).toBe(false);

			browser.elementsById['auth-email'].value = 'operator@example.com';
			await browser.elementsById['auth-email'].dispatch('input');
			expect(error.hidden).toBe(true);
			expect(error.textContent).toBe('');
			expect(browser.elementsById['auth-email'].attributes['aria-invalid']).toBeUndefined();
			expect(browser.elementsById['auth-password'].attributes['aria-invalid']).toBeUndefined();

			browser.elementsById['auth-password'].value = 'secret';
			await browser.elementsById['auth-form'].dispatch('submit');
			await flush();
			expect(auth.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
		});

		it('saves a non-empty legacy key on submit and never puts it in a URL', async () => {
			const requests = [];
			const browser = createBrowser({
				fetchImpl: async (url, options) => {
					if (url === '/openapi.json') return response(contract);
					requests.push([url, options]);
					if (url === '/api/admin/events') return idleStreamResponse();
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'session-secret';
			await browser.elementsById['connection-form'].dispatch('submit');
			await flush();

			expect(browser.storage.get('cabros-admin-api-key')).toBe('session-secret');
			expect(browser.elementsById['key-state'].textContent).toContain('saved for this browser session');
			expect(browser.elementsById['api-key'].attributes['aria-invalid']).toBeUndefined();
			expect(requests.map(([url]) => url)).toContain('/api/admin/events');
			expect(requests.every(([url]) => !url.includes('session-secret'))).toBe(true);
		});

		it('refuses to save an empty legacy key and reports it on the control', async () => {
			const requests = [];
			const browser = createBrowser({
				fetchImpl: async (url, options) => {
					if (url === '/openapi.json') return response(contract);
					requests.push([url, options]);
					return response({});
				},
			});
			await flush();
			await browser.elementsById['connection-form'].dispatch('submit');
			await flush();

			expect(browser.storage.has('cabros-admin-api-key')).toBe(false);
			expect(browser.elementsById['key-state'].textContent).toContain('Enter an API key');
			expect(browser.elementsById['key-state'].className).toBe('response-error');
			expect(browser.elementsById['api-key'].attributes['aria-invalid']).toBe('true');
			expect(requests.map(([url]) => url)).not.toContain('/api/admin/events');

			// An all-whitespace key is refused by saveKey() itself. Native `required`
			// accepts '   ', so this is production logic doing the work, not the double.
			browser.elementsById['api-key'].value = '   ';
			const whitespaceSubmit = await browser.elementsById['connection-form'].dispatch('submit');
			await flush();
			expect(whitespaceSubmit.defaultPrevented).toBe(true);
			expect(browser.storage.has('cabros-admin-api-key')).toBe(false);
			expect(browser.elementsById['key-state'].textContent).toContain('Enter an API key');
			expect(requests.map(([url]) => url)).not.toContain('/api/admin/events');

			browser.elementsById['api-key'].value = 'session-secret';
			await browser.elementsById['api-key'].dispatch('input');
			expect(browser.elementsById['api-key'].attributes['aria-invalid']).toBeUndefined();
			await browser.elementsById['connection-form'].dispatch('submit');
			await flush();
			expect(browser.storage.get('cabros-admin-api-key')).toBe('session-secret');
		});

		// #951 round 1: both forms are real <form> elements with no action, so a submit
		// that is not handled performs a native GET and writes the credentials into the
		// URL, browser history and any upstream proxy access log. The listener must exist
		// before the card is revealed, and readiness gates the SDK call rather than the
		// listener — /admin/auth-config fails open to { enabled: true, configured: false }.
		it('never lets a credential form navigate, before or without Firebase readiness', async () => {
			let releasePersistence;
			const persistencePending = new Promise((resolve) => { releasePersistence = resolve; });
			let authStateChanged;
			const auth = {
				setPersistence: jest.fn(() => persistencePending),
				onAuthStateChanged: jest.fn((listener) => {
					authStateChanged = listener;
					listener(null);
					return jest.fn();
				}),
				signInWithEmailAndPassword: jest.fn(async () => {
					await authStateChanged({
						getIdToken: jest.fn().mockResolvedValue('firebase-token'),
						getIdTokenResult: jest.fn().mockResolvedValue({ claims: { roles: ['admin.operator'] } }),
					});
				}),
				signOut: jest.fn().mockResolvedValue(undefined),
			};
			const browser = createBrowser({
				firebase: {
					initializeApp: jest.fn(),
					// Auth.Persistence is what makes setupFirebaseAuth await setPersistence,
					// which is the window this test submits inside.
					auth: Object.assign(jest.fn(() => auth), { Auth: { Persistence: { NONE: 'none' } } }),
				},
				fetchImpl: async (url) => {
					if (url === '/admin/auth-config') return response(AUTH_CONFIG);
					if (url === '/openapi.json') return response(contract);
					return response({});
				},
			});
			await flush();

			// The card is revealed while the SDK bootstrap is still in flight.
			expect(browser.elementsById['auth-form'].hidden).toBe(false);
			browser.elementsById['auth-email'].value = 'operator@example.com';
			browser.elementsById['auth-password'].value = 'PlaintextSecret123!';
			const duringLoad = await browser.elementsById['auth-form'].dispatch('submit');
			await flush();
			expect(duringLoad.defaultPrevented).toBe(true);
			expect(auth.signInWithEmailAndPassword).not.toHaveBeenCalled();
			expect(browser.elementsById['auth-credentials-error'].textContent).toContain('not available yet');

			releasePersistence();
			await flush();
			const afterReady = await browser.elementsById['auth-form'].dispatch('submit');
			await flush();
			expect(afterReady.defaultPrevented).toBe(true);
			expect(auth.signInWithEmailAndPassword).toHaveBeenCalledTimes(1);
		});

		it('withholds the credential form entirely when Firebase auth is unconfigured', async () => {
			const auth = { auth: jest.fn() };
			const browser = createBrowser({
				firebase: { initializeApp: jest.fn(), auth: jest.fn(() => auth) },
				fetchImpl: async (url) => {
					// loadAuthConfig() falls back to this shape on any timeout or error.
					if (url === '/admin/auth-config') return response({ enabled: true, configured: false });
					return response({});
				},
			});
			await flush();

			expect(browser.elementsById['firebase-auth'].hidden).toBe(false);
			expect(browser.elementsById['auth-form'].hidden).toBe(true);
			expect(browser.elementsById['auth-state'].textContent).toContain('unavailable');

			browser.elementsById['auth-email'].value = 'operator@example.com';
			browser.elementsById['auth-password'].value = 'PlaintextSecret123!';
			const submit = await browser.elementsById['auth-form'].dispatch('submit');
			await flush();
			expect(submit.defaultPrevented).toBe(true);
			expect(auth.auth).not.toHaveBeenCalled();
		});

		it('never lets the legacy key form navigate', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => (url === '/openapi.json' ? response(contract) : response({})),
			});
			await flush();

			browser.elementsById['api-key'].value = 'session-secret';
			const submit = await browser.elementsById['connection-form'].dispatch('submit');
			await flush();
			expect(submit.defaultPrevented).toBe(true);
			expect(browser.storage.get('cabros-admin-api-key')).toBe('session-secret');
		});
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
		await browser.elementsById['connection-form'].dispatch('submit');

		await selectView(browser, 'status');
		const refreshButton = findButton(browser.elementsById.view, 'Refresh status');
		await refreshButton.dispatch('click');
		await flush();

		expect(browser.helperCalls.at(-1).apiKey).toBe('current-secret');
		expect(events.at(-1)[2].headers['x-api-key']).toBe('current-secret');
		expect(browser.storage.get('cabros-admin-api-key')).toBe('current-secret');
		expect(browser.elementsById.view.textContent).toContain('[REDACTED]');
		expect(browser.elementsById.view.textContent).not.toContain('current-secret');
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
			&& node.textContent.includes('Operations'));
		const select = find(playground, (node) => node.tagName === 'SELECT');
		select.value = find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes('POST /api/alerts/{alertId}/replay')).value;
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

	it('exposes source suggestions while preserving custom alert sources', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		const sourceInput = listForm.elements.source;
		const enrichedSelect = listForm.elements.enriched;
		expect(sourceInput.tagName).toBe('INPUT');
		expect(sourceInput.attributes.list).toBe('alert-source-options');
		expect(enrichedSelect.tagName).toBe('SELECT');
		const sourceOptions = find(listForm, (node) => node.tagName === 'DATALIST');
		expect(sourceOptions.attributes.id).toBe('alert-source-options');
		const sourceValues = sourceOptions.children.map((option) => option.value);
		expect(sourceValues).toEqual(expect.arrayContaining([
			'', 'webhook', 'webhook-alert', 'webhook-message', 'news-monitor',
			'alert-replay', 'market-scanner', 'expanded-analysis',
		]));
		const enrichedValues = enrichedSelect.children.map((option) => option.value);
		expect(enrichedValues).toEqual(['', 'true', 'false']);
	});

	it('renders an active-filters header that reflects the current selection', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		const activeFilters = find(listForm, (node) => node.className === 'active-filters');
		expect(activeFilters).toBeDefined();
		expect(activeFilters.textContent).toBe('Active filters: none');

		listForm.elements.source.value = 'webhook';
		await listForm.elements.source.dispatch('change');
		await flush();
		expect(activeFilters.textContent).toContain('source=webhook');

		listForm.elements.enriched.value = 'true';
		await listForm.elements.enriched.dispatch('change');
		await flush();
		expect(activeFilters.textContent).toContain('source=webhook');
		expect(activeFilters.textContent).toContain('enriched=true');
	});

	it('clears all filter selections when the Clear filters button is clicked', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		listForm.elements.source.value = 'news-monitor';
		await listForm.elements.source.dispatch('change');
		await flush();
		listForm.elements.enriched.value = 'false';
		await listForm.elements.enriched.dispatch('change');
		await flush();

		const clearButton = findButton(listForm, 'Clear filters');
		expect(clearButton.disabled).toBe(false);
		await clearButton.dispatch('click');
		await flush();

		expect(listForm.elements.source.value).toBe('');
		expect(listForm.elements.enriched.value).toBe('');
		const activeFilters = find(listForm, (node) => node.className === 'active-filters');
		expect(activeFilters.textContent).toBe('Active filters: none');
		expect(clearButton.disabled).toBe(true);
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
		expect(findButton(summaryForm, 'Copy details').hidden).toBe(false);
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
		const exportOutput = find(exportForm, (node) => node.className.includes('response-block'));
		expect(exportOutput.className).toContain('response-error');
		expect(exportOutput.textContent).toContain('From and To are required');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
		await summaryForm.dispatch('submit');
		await flush();
		expect(requests).toHaveLength(1);
		const summaryOutput = find(summaryForm, (node) => node.className.includes('response-block'));
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

	it('renders scanner presets as structured cards with chips, storage mode badge, and raw toggle', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/scanner-presets') {
					return response({
						success: true,
						storage: { mode: 'durable', backend: 'firestore' },
						presets: [
							{
								id: 'daily_momentum',
								name: 'Daily Momentum',
								exchange: 'BINANCE',
								timeframe: '4h',
								limit: 10,
								scans: ['top_gainers', 'volume_breakout_scanner'],
								schedule: { enabled: true, cadence: '4h' },
								ranked: true,
								includeMultiTimeframe: true,
								bbwThreshold: 0.08,
								lastStatus: 'success',
								lastRunAt: '2026-03-30T12:00:00.000Z',
							},
						],
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'presets');

		const listForm = findForm(browser.elementsById.view, 'GET /api/scanner-presets');
		expect(listForm).toBeDefined();
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('Durable · Firestore');
		expect(listForm.textContent).toContain('Daily Momentum');
		expect(listForm.textContent).toContain('daily_momentum');
		expect(listForm.textContent).toContain('BINANCE · 4h · Limit 10');
		expect(listForm.textContent).toContain('top_gainers');
		expect(listForm.textContent).toContain('volume_breakout_scanner');
		expect(listForm.textContent).toContain('Schedule: 4h');
		expect(listForm.textContent).toContain('Ranked');
		expect(listForm.textContent).toContain('MTF');
		expect(listForm.textContent).toContain('BBW: 0.08');
		expect(listForm.textContent).toContain('Presets details');
	});

	it('supports running a scanner preset from its card with confirmation and structured analysis result', async () => {
		const requests = [];
		const confirmPrompts = [];
		const browser = createBrowser({
			confirm: (msg) => {
				confirmPrompts.push(msg);
				return true;
			},
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/scanner-presets') {
					return response({
						success: true,
						storage: { mode: 'durable', backend: 'firestore' },
						presets: [
							{
								id: 'crypto_breakout',
								name: 'Crypto Breakout',
								exchange: 'BINANCE',
								timeframe: '1h',
								limit: 5,
								scans: ['volume_breakout_scanner'],
							},
						],
					});
				}
				if (url.startsWith('/api/scanner-presets/crypto_breakout/run')) {
					requests.push([url, options]);
					return response({
						success: true,
						presetId: 'crypto_breakout',
						symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT'],
						report: 'Technical scan report for crypto breakout',
						storage: { mode: 'durable', backend: 'firestore' },
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'presets');

		const listForm = findForm(browser.elementsById.view, 'GET /api/scanner-presets');
		await listForm.dispatch('submit');
		await flush();

		const runBtn = findButton(listForm, 'Run');
		expect(runBtn).toBeDefined();
		await runBtn.dispatch('click');
		await flush();

		expect(confirmPrompts).toContain('Run this scanner preset?');
		expect(requests.at(-1)[0]).toContain('/api/scanner-presets/crypto_breakout/run?dryRun=false');
		expect(listForm.textContent).toContain('Technical scan report for crypto breakout');
		expect(listForm.textContent).toContain('Run details');

		let copiedTextarea;
		const createElement = browser.context.document.createElement;
		browser.context.document.createElement = (tag) => {
			const node = createElement(tag);
			if (tag === 'textarea') copiedTextarea = node;
			return node;
		};
		browser.context.document.execCommand = () => true;
		await findButton(runBtn.parentNode.parentNode, 'Copy details').dispatch('click');
		await flush();
		expect(copiedTextarea.value).toContain('Technical scan report for crypto breakout');
	});

	it('supports editing a scanner preset from its card and populates update form fields', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/scanner-presets') {
					return response({
						success: true,
						presets: [
							{
								id: 'bollinger_squeeze',
								name: 'Bollinger Squeeze',
								exchange: 'BINANCE',
								timeframe: '15m',
								limit: 8,
								scans: ['bollinger_scan'],
								bbwThreshold: 0.03,
								ranked: true,
								includeMultiTimeframe: true,
								schedule: { enabled: true, cadence: '1h' },
							},
						],
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'presets');

		const listForm = findForm(browser.elementsById.view, 'GET /api/scanner-presets');
		await listForm.dispatch('submit');
		await flush();

		const editBtn = findButton(listForm, 'Edit');
		expect(editBtn).toBeDefined();
		await editBtn.dispatch('click');
		await flush();

		const updateForm = findForm(browser.elementsById.view, 'PUT /api/scanner-presets/{id}');
		expect(updateForm.elements['path-id'].value).toBe('bollinger_squeeze');
		expect(updateForm.elements.name.value).toBe('Bollinger Squeeze');
		expect(updateForm.elements.exchange.value).toBe('BINANCE');
		expect(updateForm.elements.timeframe.value).toBe('15m');
		expect(Number(updateForm.elements.limit.value)).toBe(8);
		expect(Number(updateForm.elements.bbwThreshold.value)).toBe(0.03);
		expect(updateForm.elements.ranked.checked).toBe(true);
		expect(updateForm.elements.includeMultiTimeframe.checked).toBe(true);
		expect(updateForm.elements.schedule.value).toBe('1h');
		expect(updateForm.elements.body.value).toContain('Bollinger Squeeze');
	});

	it('supports deleting a scanner preset from its card with confirmation and removing it from view', async () => {
		const requests = [];
		const confirmPrompts = [];
		let deleteCount = 0;
		const browser = createBrowser({
			confirm: (msg) => {
				confirmPrompts.push(msg);
				return true;
			},
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/scanner-presets' && deleteCount === 0) {
					return response({
						success: true,
						storage: { mode: 'durable', backend: 'firestore' },
						presets: [
							{
								id: 'old_preset',
								name: 'Old Preset',
								exchange: 'BINANCE',
								timeframe: '4h',
								limit: 5,
								scans: ['top_gainers'],
							},
						],
					});
				}
				if (url === '/api/scanner-presets/old_preset' && options.method === 'DELETE') {
					deleteCount++;
					requests.push([url, options]);
					return response({
						success: true,
						presetId: 'old_preset',
						storage: { mode: 'durable', backend: 'firestore' },
					});
				}
				if (url === '/api/scanner-presets' && deleteCount > 0) {
					return response({
						success: true,
						storage: { mode: 'durable', backend: 'firestore' },
						presets: [],
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'presets');

		const listForm = findForm(browser.elementsById.view, 'GET /api/scanner-presets');
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('Old Preset');
		const deleteBtn = findButton(listForm, 'Delete');
		expect(deleteBtn).toBeDefined();
		await deleteBtn.dispatch('click');
		await flush();

		expect(confirmPrompts).toContain('Delete this scanner preset?');
		expect(requests.at(-1)[0]).toBe('/api/scanner-presets/old_preset');
		expect(requests.at(-1)[1].method).toBe('DELETE');
		expect(listForm.textContent).toContain('No scanner presets found.');
	});

	it('synchronizes structured form controls to JSON body and clamps limit', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
		});
		await flush();
		await selectView(browser, 'presets');

		const createForm = findForm(browser.elementsById.view, 'POST /api/scanner-presets');
		expect(createForm).toBeDefined();

		createForm.elements.name.value = 'Custom Momentum';
		await createForm.elements.name.dispatch('input');

		createForm.elements.timeframe.value = '1D';
		await createForm.elements.timeframe.dispatch('change');

		createForm.elements.limit.value = '50';
		await createForm.elements.limit.dispatch('change');

		createForm.elements.ranked.checked = true;
		await createForm.elements.ranked.dispatch('change');

		const parsedBody = JSON.parse(createForm.elements.body.value);
		expect(parsedBody.name).toBe('Custom Momentum');
		expect(parsedBody.timeframe).toBe('1D');
		expect(parsedBody.limit).toBe(20);
		expect(parsedBody.ranked).toBe(true);
	});

	it('disables preset mutation buttons for admin.viewer role', async () => {
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
		const browser = createBrowser({
			firebase,
			fetchImpl: async (url) => {
				if (url === '/admin/auth-config') {
					return response({
						enabled: true,
						configured: true,
						config: { apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros' },
					});
				}
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/scanner-presets') {
					return response({
						success: true,
						presets: [
							{
								id: 'viewer_preset',
								name: 'Viewer Preset',
								exchange: 'BINANCE',
								timeframe: '4h',
								limit: 5,
								scans: ['top_gainers'],
							},
						],
					});
				}
				return response({});
			},
		});
		await flush();

		browser.elementsById['auth-email'].value = 'viewer@example.com';
		browser.elementsById['auth-password'].value = 'password';
		await browser.elementsById['auth-form'].dispatch('submit');
		await flush();

		await selectView(browser, 'presets');

		const listForm = findForm(browser.elementsById.view, 'GET /api/scanner-presets');
		await listForm.dispatch('submit');
		await flush();

		const runBtn = findButton(listForm, 'Run');
		const editBtn = findButton(listForm, 'Edit');
		const deleteBtn = findButton(listForm, 'Delete');

		expect(runBtn.disabled).toBe(true);
		expect(runBtn.title).toBe('Requires admin.operator role');
		expect(editBtn.disabled).toBe(true);
		expect(editBtn.title).toBe('Requires admin.operator role');
		expect(deleteBtn.disabled).toBe(true);
		expect(deleteBtn.title).toBe('Requires admin.operator role');
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
		await flush();

		const output = find(browser.elementsById.view, (node) => node.className.includes('response-block'));
		expect(find(output, (node) => node.className === 'spinner')).toBeDefined();
		expect(output.textContent).toContain('Request in progress');

		resolveStatus(response({
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: {},
			deliveryChannels: {},
			dependencies: {},
		}));
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

		const copyButton = findButton(browser.elementsById.view, 'Copy details');
		expect(copyButton).toBeDefined();
		await copyButton.dispatch('click');
		await flush();
		expect(copyButton.textContent).toBe('Copy unavailable');

		for (const fireTimer of [...browser.timers.values()]) fireTimer();
		expect(copyButton.textContent).toBe('Copy details');
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
		expect(summary.textContent).toContain('Response details');
		expect(findButton(listForm, 'Copy details').hidden).toBe(false);
	});

	it('supports bulk alert selection, select-all toggle, and batch operations', async () => {
		const requests = [];
		const alertsData = {
			alerts: [
				{ id: 'alert-1', text: 'first alert', source: 'tradingview', enriched: false },
				{ id: 'alert-2', text: 'second alert', source: 'tradingview', enriched: true },
			],
			pagination: { hasMore: false },
		};
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				if (url.startsWith('/api/alerts') && (!options || !options.method || options.method === 'GET')) {
					return response(alertsData);
				}
				if (url === '/api/alerts/batch/replay') {
					return response({
						success: true,
						results: [
							{ alertId: 'alert-1', success: true, channels: ['telegram'] },
							{ alertId: 'alert-2', success: true, channels: ['telegram'] },
						],
					});
				}
				if (url === '/api/alerts/batch/export') {
					return {
						ok: true,
						status: 200,
						headers: { get: (name) => (name === 'content-type' ? 'application/x-ndjson' : null) },
						blob: async () => ({ type: 'application/x-ndjson' }),
						text: async () => 'export body',
					};
				}
				if (url === '/api/alerts/batch/delete') {
					return response({ success: true, requested: 2, deleted: 2 });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();

		const selectAll = find(listForm, (node) => node.tagName === 'INPUT' && node.className.includes('alert-select-all'));
		const countSpan = find(listForm, (node) => node.className && node.className.includes('batch-selection-count'));
		const replayBtn = findButton(listForm, 'Replay selected');
		const exportBtn = findButton(listForm, 'Export selected');
		const deleteBtn = findButton(listForm, 'Delete selected');
		const checkboxes = findAll(listForm, (node) => node.className && node.className.includes('alert-select-checkbox'));

		expect(selectAll).toBeDefined();
		expect(countSpan.textContent).toBe('0 selected');
		expect(replayBtn.disabled).toBe(true);
		expect(exportBtn.disabled).toBe(true);
		expect(deleteBtn.disabled).toBe(true);
		expect(checkboxes.length).toBe(2);

		// Select first alert
		checkboxes[0].checked = true;
		await checkboxes[0].dispatch('change');
		expect(countSpan.textContent).toBe('1 selected');
		expect(replayBtn.disabled).toBe(false);
		expect(exportBtn.disabled).toBe(false);
		expect(deleteBtn.disabled).toBe(false);
		expect(selectAll.checked).toBe(false);

		// Select-all
		selectAll.checked = true;
		await selectAll.dispatch('change');
		expect(countSpan.textContent).toBe('2 selected');
		expect(checkboxes[0].checked).toBe(true);
		expect(checkboxes[1].checked).toBe(true);
		expect(selectAll.checked).toBe(true);

		// Batch replay
		await replayBtn.dispatch('click');
		await flush();
		const replayRequest = requests.find(([url]) => url === '/api/alerts/batch/replay');
		expect(replayRequest).toBeDefined();
		const parsedReplayBody = JSON.parse(replayRequest[1].body);
		expect(parsedReplayBody.alertIds).toEqual(['alert-1', 'alert-2']);
		expect(typeof parsedReplayBody.idempotencyKey).toBe('string');
		expect(parsedReplayBody.idempotencyKey.trim().length).toBeGreaterThan(0);
		expect(listForm.textContent).toContain('Batch replay complete: 2/2 succeeded.');

		// Batch export
		await exportBtn.dispatch('click');
		await flush();
		const exportRequest = requests.find(([url]) => url === '/api/alerts/batch/export');
		expect(exportRequest).toBeDefined();
		expect(JSON.parse(exportRequest[1].body)).toEqual({ alertIds: ['alert-1', 'alert-2'], format: 'jsonl' });
		expect(browser.downloads.length).toBeGreaterThan(0);

		// Batch delete
		await deleteBtn.dispatch('click');
		await flush();
		const deleteRequest = requests.find(([url]) => url === '/api/alerts/batch/delete');
		expect(deleteRequest).toBeDefined();
		expect(JSON.parse(deleteRequest[1].body)).toEqual({ alertIds: ['alert-1', 'alert-2'] });
		expect(listForm.textContent).toContain('Batch delete complete: 2 alerts deleted.');
	});

	it('disables batch replay button when more than 50 alerts are selected', async () => {
		const alertsList = Array.from({ length: 55 }, (_, i) => ({
			id: `alert-${i + 1}`,
			text: `alert ${i + 1}`,
			source: 'webhook',
		}));
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					return response({ success: true, alerts: alertsList, pagination: { hasMore: false } });
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');

		const listForm = findForm(browser.elementsById.view, 'GET /api/alerts');
		await listForm.dispatch('submit');
		await flush();

		const selectAll = find(listForm, (node) => node.tagName === 'INPUT' && node.className.includes('alert-select-all'));
		const countSpan = find(listForm, (node) => node.className && node.className.includes('batch-selection-count'));
		const replayBtn = findButton(listForm, 'Replay selected');
		const exportBtn = findButton(listForm, 'Export selected');
		const deleteBtn = findButton(listForm, 'Delete selected');

		// Select all 55 alerts
		selectAll.checked = true;
		await selectAll.dispatch('change');
		expect(countSpan.textContent).toBe('55 selected');

		// Replay button should be disabled because 55 > 50
		expect(replayBtn.disabled).toBe(true);
		expect(replayBtn.title).toBe('Batch replay is limited to 50 alerts at a time (55 selected)');

		// Export and delete should remain enabled
		expect(exportBtn.disabled).toBe(false);
		expect(deleteBtn.disabled).toBe(false);
	});

	it('disables batch replay and delete for admin.viewer role', async () => {
		const auth = {
			onAuthStateChanged: (listener) => {
				listener({
					getIdToken: async () => 'viewer-token',
					getIdTokenResult: async () => ({ claims: { role: 'admin.viewer' } }),
				});
				return () => {};
			},
			signInWithEmailAndPassword: jest.fn(),
			signOut: jest.fn(),
		};
		const firebase = {
			initializeApp: jest.fn(),
			auth: jest.fn(() => auth),
		};
		const requests = [];
		const browser = createBrowser({
			firebase,
			fetchImpl: async (url, options) => {
				requests.push([url, options]);
				if (url === '/admin/auth-config') {
					return response({
						enabled: true,
						configured: true,
						config: { apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros' },
					});
				}
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts')) {
					return response({
						alerts: [{ id: 'alert-1', text: 'some alert', enriched: false }],
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

		const checkbox = find(listForm, (node) => node.className && node.className.includes('alert-select-checkbox'));
		checkbox.checked = true;
		await checkbox.dispatch('change');

		const replayBtn = findButton(listForm, 'Replay selected');
		const exportBtn = findButton(listForm, 'Export selected');
		const deleteBtn = findButton(listForm, 'Delete selected');

		expect(exportBtn.disabled).toBe(false);
		expect(replayBtn.disabled).toBe(true);
		expect(deleteBtn.disabled).toBe(true);

		await exportBtn.dispatch('click');
		await flush();
		const exportRequest = requests.find(([url]) => url === '/api/alerts/batch/export');
		expect(exportRequest).toBeDefined();
		expect(listForm.textContent).not.toContain('Your admin role cannot perform this operation.');
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
		expect(findButton(statusForm, 'Copy details').hidden).toBe(false);
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
	it('renders the single-symbol analysis verdict with badges, confidence meter, risk levels, indicators, and report preview', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({
						success: true,
						symbol: 'BINANCE:BTCUSDT',
						exchange: 'BINANCE',
						asset: 'BTCUSDT',
						timeframe: '1D',
						analysisStatus: 'complete',
						alertText: 'BTCUSDT Analysis: Bullish breakout above 65000',
						analysis: {
							price_data: { current_price: 65000 },
							volume_analysis: { volume_ratio: 2.1, volume_strength: 'HIGH' },
							technical_indicators: {
								RSI: 62.5,
								MACD: 'BULLISH',
								BB_position: 'UPPER',
								ATR: 1200,
								ADX: 28,
								SMA20: 63500,
							},
							risk: {
								entry_price: 65000,
								stop_loss: 63000,
								target: 69000,
								risk_reward_ratio: 2,
								valid: true,
							},
							decision: {
								action: 'BUY',
								confidence: 0.82,
								reasons: ['Confluencia: BUY', 'RSI: 62.5', 'Tendencia: BULLISH'],
								warnings: [],
								dataSufficient: true,
							},
							multi_timeframe: {
								'4h': { trend: 'BULLISH' },
								'1W': { trend: 'NEUTRAL' },
							},
						},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		expect(form).toBeDefined();
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('symbol-analysis-result'));
		expect(verdict).toBeDefined();
		expect(verdict.textContent).toContain('BUY');
		expect(verdict.textContent).toContain('Status: Complete');
		expect(verdict.textContent).toContain('BINANCE:BTCUSDT · 1D');
		expect(verdict.textContent).toContain('82% confidence');
		expect(verdict.textContent).toContain('Decision reasons');
		expect(verdict.textContent).toContain('Confluencia: BUY');
		expect(verdict.textContent).toContain('Price & Risk Levels');
		expect(verdict.textContent).toContain('Entry Price');
		expect(verdict.textContent).toContain('Stop Loss');
		expect(verdict.textContent).toContain('Target');
		expect(verdict.textContent).toContain('2:1');
		expect(verdict.textContent).toContain('Technical Indicators');
		expect(verdict.textContent).toContain('RSI: 62.5');
		expect(verdict.textContent).toContain('Volume Ratio: 2.1x');
		expect(verdict.textContent).toContain('Volume Strength: HIGH');
		expect(verdict.textContent).toContain('Multi-timeframe Analysis');
		expect(verdict.textContent).toContain('4h: BULLISH');
		expect(verdict.textContent).toContain('Report preview');
		expect(verdict.textContent).toContain('BTCUSDT Analysis: Bullish breakout above 65000');
		expect(findButton(form, 'Copy details').hidden).toBe(false);
	});

	it('renders nested multi-timeframe timeframes, alignment, and recommendation from the endpoint shape', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({
						success: true,
						symbol: 'BINANCE:BTCUSDT',
						timeframe: '1D',
						analysisStatus: 'complete',
						analysis: {
							decision: {
								action: 'SELL',
								confidence: 'HIGH',
								dataSufficient: true,
								reasons: ['Confluencia: SELL'],
								warnings: [],
							},
							multi_timeframe: {
								timeframes: { '1W': { bias: 'bearish' }, '1D': { bias: 'bearish', rsi: 77.9 } },
								alignment: { status: 'ALIGNED', confidence: 'HIGH' },
								recommendation: { action: 'SELL' },
							},
						},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('symbol-analysis-result'));
		expect(verdict).toBeDefined();
		expect(verdict.textContent).toContain('Multi-timeframe Analysis');
		// The endpoint populates multi_timeframe.timeframes[].bias; treating the
		// top-level envelope keys as timeframes both drops these and mislabels
		// `alignment` as a trading interval.
		expect(verdict.textContent).toContain('1W: Bearish');
		expect(verdict.textContent).toContain('1D: Bearish');
		expect(verdict.textContent).toContain('Alignment: ALIGNED');
		expect(verdict.textContent).toContain('Alignment confidence: HIGH');
		expect(verdict.textContent).toContain('Recommendation: SELL');
		expect(verdict.textContent).not.toContain('alignment: ALIGNED');
		expect(verdict.textContent).not.toContain('Timeframes:');

		const recommendationBadge = find(verdict, (node) => node.tagName === 'SPAN'
			&& node.textContent === 'Recommendation: SELL');
		expect(recommendationBadge.className).toContain('status-danger');
	});

	it('still renders a legacy flat multi-timeframe map without alignment or recommendation', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({
						success: true,
						symbol: 'BINANCE:ETHUSDT',
						timeframe: '4h',
						analysis: {
							decision: { action: 'BUY', confidence: 0.7, dataSufficient: true, reasons: [], warnings: [] },
							multi_timeframe: { '4h': { trend: 'BULLISH' }, '1W': { direction: 'NEUTRAL' } },
						},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('symbol-analysis-result'));
		expect(verdict).toBeDefined();
		expect(verdict.textContent).toContain('4h: BULLISH');
		expect(verdict.textContent).toContain('1W: NEUTRAL');
		expect(verdict.textContent).not.toContain('Alignment:');
		expect(verdict.textContent).not.toContain('Recommendation:');
	});

	it('renders categorical decision confidence labels instead of dropping them', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({
						success: true,
						symbol: 'NASDAQ:NVDA',
						timeframe: '1D',
						analysis: {
							decision: { action: 'BUY', confidence: 'HIGH', dataSufficient: true, reasons: [], warnings: [] },
						},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('symbol-analysis-result'));
		expect(verdict).toBeDefined();
		expect(verdict.textContent).toContain('Confidence: HIGH');
		expect(verdict.textContent).not.toContain('NaN');
		expect(find(verdict, (node) => node.tagName === 'SPAN' && node.textContent === 'Confidence: HIGH').className)
			.toContain('status-ready');
	});

	it('renders a bounded neutral confidence label and ignores non-scalar confidence values', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({
						success: true,
						symbol: 'BINANCE:BTCUSDT',
						timeframe: '1D',
						analysis: {
							decision: {
								action: 'NO_TRADE',
								confidence: 'medium',
								dataSufficient: false,
								reasons: [],
								warnings: [],
							},
						},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('symbol-analysis-result'));
		expect(verdict.textContent).toContain('Confidence: Medium');

		// Arrays and objects are not labels; they must not render as "[object Object]".
		const objectBrowser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({
						success: true,
						symbol: 'BINANCE:BTCUSDT',
						timeframe: '1D',
						analysis: { decision: { action: 'NO_TRADE', confidence: { score: 3 }, dataSufficient: false } },
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(objectBrowser, 'analysis');
		const objectForm = findForm(objectBrowser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		await objectForm.dispatch('submit');
		await flush();
		const objectVerdict = find(objectForm, (node) => node.className.includes('symbol-analysis-result'));
		expect(objectVerdict.textContent).not.toContain('Confidence');
		expect(objectVerdict.textContent).not.toContain('[object');
	});

	it('renders NO_TRADE decision action and warning chips when data is insufficient or neutral', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({
						success: true,
						symbol: 'BINANCE:ETHUSDT',
						timeframe: '4h',
						analysis: {
							decision: {
								action: 'NO_TRADE',
								confidence: 0.3,
								dataSufficient: false,
								reasons: [],
								warnings: ['Falta el RSI para una decisión accionable.', 'El riesgo calculado no tiene niveles direccionales válidos.'],
							},
						},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		await form.dispatch('submit');
		await flush();

		const verdict = find(form, (node) => node.className.includes('symbol-analysis-result'));
		expect(verdict).toBeDefined();
		expect(verdict.textContent).toContain('NO_TRADE');
		expect(verdict.textContent).toContain('Insufficient data');
		expect(verdict.textContent).toContain('30% confidence');
		expect(verdict.textContent).toContain('Warnings');
		expect(verdict.textContent).toContain('Falta el RSI para una decisión accionable.');
	});

	it('renders error response and status code on symbol-analysis failure', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url === '/api/webhook/symbol-analysis') {
					return response({ success: false, error: 'TradingView MCP service unavailable' }, 502);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'analysis');

		const form = findForm(browser.elementsById.view, 'POST /api/webhook/symbol-analysis');
		await form.dispatch('submit');
		await flush();

		const errorBlock = find(form, (node) => node.className.includes('response-error'));
		expect(errorBlock).toBeDefined();
		expect(errorBlock.textContent).toContain('502');
		expect(errorBlock.textContent).toContain('TradingView MCP service unavailable');
		const verdict = find(form, (node) => node.className.includes('symbol-analysis-result'));
		expect(verdict).toBeUndefined();
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
		expect(findButton(form, 'Copy details').hidden).toBe(false);
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

		const copyButton = findButton(browser.elementsById.view, 'Copy details');
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
		const copyButton = findButton(browser.elementsById.view, 'Copy details');
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
		const copyButton = findButton(browser.elementsById.view, 'Copy details');
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
		expect(findButton(listForm, 'Copy details').hidden).toBe(true);
		expect(find(listForm, (node) => node.className.includes('response-block') && node.textContent.includes('first page alert'))).toBeUndefined();

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
		expect(findButton(listForm, 'Copy details').hidden).toBe(false);

		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).not.toContain('first page alert');
		expect(findButton(listForm, 'Copy details').hidden).toBe(true);
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
		expect(findButton(summaryForm, 'Copy details').hidden).toBe(false);

		await summaryForm.dispatch('submit');
		await flush();

		expect(findButton(summaryForm, 'Copy details').hidden).toBe(true);
		const rawPre = find(summaryForm, (node) => node.className.includes('response-block') && node.textContent.includes('Total Alerts'));
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
		expect(findButton(form, 'Copy details').hidden).toBe(false);

		// Use form.elements to find the raw textarea by name
		const rawTextarea = form.elements.body;
		rawTextarea.value = '{ invalid';
		await form.dispatch('submit');
		await flush();

		expect(findButton(form, 'Copy details').hidden).toBe(true);
		const staleRaw = find(form, (node) => node.className.includes('response-block') && node.textContent.includes('Volume ratio'));
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
		await browser.elementsById['auth-form'].dispatch('submit');
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
		expect(findButton(summaryForm, 'Copy details').hidden).toBe(true);

		releaseSlow();
		await flush();
		expect(find(summaryForm, (node) => node.className.includes('response-block') && node.textContent.includes('Total Alerts'))).toBeUndefined();
		expect(summaryForm.textContent).toContain('Filters changed');
	});

	describe('sentiment calibration panel', () => {
		function summaryWithCalibration(calibration) {
			return {
				success: true,
				summary: {
					totalAlerts: 97,
					window: {},
					enrichment: {
						enrichedAlerts: 97,
						plainAlerts: 0,
						sentimentCalibration: calibration,
						riskMetadataCoverage: { denominator: 97, fields: {} },
					},
				},
			};
		}

		async function loadSummary(browser, calibration) {
			await flush();
			await selectView(browser, 'alerts');
			const form = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
			await form.dispatch('submit');
			await flush();
			return form;
		}

		it('surfaces a saturated verdict with the rule that fired', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.startsWith('/api/alerts/summary')) {
						return response(summaryWithCalibration({
							sampleCount: 97,
							evaluated: true,
							saturated: true,
							reason: 'top_band_concentration',
							min: 0.55,
							max: 0.85,
							p10: 0.7,
							p50: 0.8,
							p90: 0.85,
							spread: 0.15,
							distinctValueCount: 7,
							bucketCount: 4,
							buckets: [
								{ lowerBound: 0.5, upperBound: 0.6, count: 5 },
								{ lowerBound: 0.8, upperBound: 0.9, count: 45 },
							],
							topBandCount: 85,
							topBandShare: 0.876289,
							rawScoreCapCount: 13,
						}));
					}
					return response({});
				},
			});

			const form = await loadSummary(browser);

			const text = form.textContent;
			expect(text).toContain('Sentiment calibration');
			expect(text).toContain('Saturated');
			expect(text).toContain('top_band_concentration');
			expect(text).toContain('0.75');
			expect(text).toContain('13');
			const panel = find(form, (node) => node.className.includes('sentiment-calibration'));
			expect(panel).toBeDefined();
			expect(find(panel, (node) => node.className.includes('status-danger'))).toBeDefined();
		});

		it('surfaces a healthy verdict', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.startsWith('/api/alerts/summary')) {
						return response(summaryWithCalibration({
							sampleCount: 120,
							evaluated: true,
							saturated: false,
							reason: null,
							min: 0.15,
							max: 0.9,
							p10: 0.25,
							p50: 0.45,
							p90: 0.85,
							spread: 0.6,
							distinctValueCount: 34,
							bucketCount: 8,
							buckets: [],
							topBandCount: 46,
							topBandShare: 0.383333,
							rawScoreCapCount: 4,
						}));
					}
					return response({});
				},
			});

			const form = await loadSummary(browser);

			expect(form.textContent).toContain('Sentiment calibration');
			expect(form.textContent).toContain('Spread');
			const panel = find(form, (node) => node.className.includes('sentiment-calibration'));
			expect(panel).toBeDefined();
			expect(find(panel, (node) => node.className.includes('status-ready'))).toBeDefined();
		});

		it('distinguishes an unevaluated window from a healthy one', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.startsWith('/api/alerts/summary')) {
						return response(summaryWithCalibration({
							sampleCount: 3,
							evaluated: false,
							saturated: false,
							reason: 'insufficient_sample',
							min: 0.55,
							max: 0.55,
							p10: 0.55,
							p50: 0.55,
							p90: 0.55,
							spread: 0,
							distinctValueCount: 1,
							bucketCount: 1,
							buckets: [],
							topBandCount: 0,
							topBandShare: 0,
							rawScoreCapCount: 0,
						}));
					}
					return response({});
				},
			});

			const form = await loadSummary(browser);

			const text = form.textContent;
			expect(text).toContain('Sentiment calibration');
			expect(text).toContain('insufficient_sample');
			// Must not read as healthy: a small window is a non-verdict, not a pass.
			expect(text).not.toContain('Healthy');
			const panel = find(form, (node) => node.className.includes('sentiment-calibration'));
			expect(panel).toBeDefined();
			expect(find(panel, (node) => node.className.includes('status-disabled'))).toBeDefined();
			expect(find(panel, (node) => node.className.includes('status-ready'))).toBeUndefined();
		});

		it('omits the panel entirely when the API reports no calibration block', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.startsWith('/api/alerts/summary')) {
						return response({ success: true, summary: { totalAlerts: 1, window: {}, enrichment: { enrichedAlerts: 1 } } });
					}
					return response({});
				},
			});

			const form = await loadSummary(browser);

			expect(form.textContent).not.toContain('Sentiment calibration');
		});

		it('renders untrusted reason text as text, never as markup', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.startsWith('/api/alerts/summary')) {
						return response(summaryWithCalibration({
							sampleCount: 30,
							evaluated: true,
							saturated: true,
							reason: '<img src=x onerror=alert(1)>',
							min: 0.8,
							max: 0.8,
							p10: 0.8,
							p50: 0.8,
							p90: 0.8,
							spread: 0,
							distinctValueCount: 1,
							bucketCount: 1,
							buckets: [],
							topBandCount: 30,
							topBandShare: 1,
							rawScoreCapCount: 0,
						}));
					}
					return response({});
				},
			});

			const form = await loadSummary(browser);

			expect(form.querySelectorAll('img')).toHaveLength(0);
			expect(form.textContent).toContain('<img src=x onerror=alert(1)>');
		});
	});

	it('renders dedicated outcomes filters and follows the returned before cursor', async () => {
		let outcomesPage = 0;
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				if (url.startsWith('/api/outcomes')) {
					outcomesPage++;
					return response({
						success: true,
						outcomes: [
							{
								id: `doc-${outcomesPage}`,
								symbol: 'BTCUSDT',
								exchange: 'BINANCE',
								side: 'BUY',
								price: 65000,
								outcomeEvaluated: true,
								outcomes: {
									'1h': { status: 'evaluated', return: 1.5, rMultiple: 0.5, maxFavorableExcursion: 2.0, maxAdverseExcursion: -0.2, firstHit: 'target' },
								},
							},
						],
						pagination: outcomesPage === 1
							? { hasMore: true, nextBefore: 'cursor-outcome-2' }
							: { hasMore: false },
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'outcomes');

		const listForm = findForm(browser.elementsById.view, 'GET /api/outcomes');
		expect(listForm).toBeDefined();
		expect(listForm.elements.limit).toBeDefined();
		expect(listForm.elements.before).toBeDefined();
		expect(listForm.elements.symbol).toBeDefined();
		expect(listForm.elements.exchange).toBeDefined();
		expect(listForm.elements.status).toBeDefined();
		expect(listForm.elements.window).toBeDefined();
		expect(listForm.elements.from).toBeDefined();
		expect(listForm.elements.to).toBeDefined();

		listForm.elements.limit.value = '25';
		listForm.elements.symbol.value = 'BTCUSDT';
		listForm.elements.exchange.value = 'BINANCE';
		listForm.elements.status.value = 'evaluated';
		listForm.elements.window.value = '1h';
		await listForm.dispatch('submit');
		await flush();

		expect(requests.at(-1)[0]).toBe('/api/outcomes?limit=25&symbol=BTCUSDT&exchange=BINANCE&status=evaluated&window=1h');
		expect(listForm.textContent).toContain('1 outcomes on this page');
		expect(listForm.textContent).toContain('BTCUSDT · BINANCE');

		const nextButton = findButton(listForm, 'Next page');
		expect(nextButton.disabled).toBe(false);
		await nextButton.dispatch('click');
		await flush();

		expect(requests.at(-1)[0]).toBe('/api/outcomes?limit=25&before=cursor-outcome-2&symbol=BTCUSDT&exchange=BINANCE&status=evaluated&window=1h');

		const prevButton = findButton(listForm, 'Previous page');
		expect(prevButton.disabled).toBe(false);
		await prevButton.dispatch('click');
		await flush();

		expect(requests.at(-1)[0]).toBe('/api/outcomes?limit=25&symbol=BTCUSDT&exchange=BINANCE&status=evaluated&window=1h');
	});

	it('renders dedicated outcomes summary query and builds metrics dashboard', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				if (url.startsWith('/api/outcomes/summary')) {
					return response({
						success: true,
						summary: {
							totalSignalsReceived: 10,
							totalSignalsEligible: 8,
							totalSignalsEvaluated: 6,
							totalSignalsPending: 2,
							winRatePercent: 75,
							expectancyR: 1.25,
							averageReturnPercent: 2.34,
							averageMfePercent: 3.5,
							averageMaePercent: -0.8,
							windows: {
								'1h': {
									totalSignals: 6,
									hitRatePercent: 66.67,
									targetHitRatePercent: 50.0,
									stopHitRatePercent: 16.67,
									expectancyR: 1.1,
									averageReturnPercent: 1.8,
									averageMfePercent: 2.5,
									averageMaePercent: -0.5,
								},
							},
						},
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'outcomes');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/outcomes/summary');
		expect(summaryForm).toBeDefined();
		summaryForm.elements.symbol.value = 'ETHUSDT';
		summaryForm.elements.status.value = 'evaluated';
		await summaryForm.dispatch('submit');
		await flush();

		expect(requests.at(-1)[0]).toBe('/api/outcomes/summary?limit=50&symbol=ETHUSDT&status=evaluated');
		expect(summaryForm.textContent).toContain('Hit rate');
		expect(summaryForm.textContent).toContain('75%');
		expect(summaryForm.textContent).toContain('Average return');
		expect(summaryForm.textContent).toContain('+2.34%');
		expect(summaryForm.textContent).toContain('Performance by window');
		expect(summaryForm.textContent).toContain('66.67%');
	});

	it('renders dedicated outcomes calibration query and builds calibration dashboard', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				requests.push([url, options]);
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/outcomes/calibration')) {
					return response({
						success: true,
						calibration: {
							available: true,
							totalScoredAlerts: 45,
							suggestedThreshold: 0.78,
							suggestedThresholdRationale: 'Alerts at 0.78+ show 55%+ target hit rate at 4h window',
							buckets: [
								{ range: '0.70-0.75', count: 15, avgReturn1h: 0.2, avgReturn4h: 0.5, targetHitRate: 0.4 },
								{ range: '0.75-0.80', count: 30, avgReturn1h: 0.8, avgReturn4h: 1.5, targetHitRate: 0.6 },
							],
						},
					});
				}
				return response({ success: true });
			},
		});

		await flush();
		await selectView(browser, 'outcomes');

		const calibrationForm = findForm(browser.elementsById.view, 'GET /api/outcomes/calibration');
		expect(calibrationForm).toBeDefined();
		calibrationForm.elements.symbol.value = 'BTCUSDT';
		calibrationForm.elements.window.value = '4h';
		await calibrationForm.dispatch('submit');
		await flush();

		expect(requests.at(-1)[0]).toBe('/api/outcomes/calibration?limit=1000&symbol=BTCUSDT&window=4h');
		expect(calibrationForm.textContent).toContain('Scored alerts');
		expect(calibrationForm.textContent).toContain('45');
		expect(calibrationForm.textContent).toContain('Suggested threshold');
		expect(calibrationForm.textContent).toContain('0.78');
		expect(calibrationForm.textContent).toContain('Calibration buckets');
		expect(calibrationForm.textContent).toContain('0.70-0.75');
		expect(calibrationForm.textContent).toContain('60%');
	});

	it('safely renders outcome cards with excursions, barriers, and expandable detail', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/outcomes')) {
					return response({
						success: true,
						outcomes: [
							{
								id: 'outcome-detail-doc-1',
								requestId: 'req-abc-123',
								source: 'market-scanner',
								symbol: 'SOLUSDT',
								exchange: 'BINANCE',
								assetClass: 'crypto',
								timeframe: '4h',
								setupType: 'breakout',
								score: 85,
								side: 'BUY',
								price: 145.5,
								stop: 140.0,
								target: 155.0,
								entryPriceSource: 'binance',
								marketDataProvider: 'binance',
								eligibilityState: 'supported_provider',
								outcomeEvaluated: true,
								outcomes: {
									'1h': { status: 'evaluated', return: 2.1, rMultiple: 0.8, maxFavorableExcursion: 3.2, maxAdverseExcursion: -0.4, firstHit: 'target', price: 148.5 },
									'4h': { status: 'pending' },
									'1D': { status: 'unavailable', reason: 'market closed' },
								},
								tokenUsage: { inputTokens: 120, outputTokens: 60, totalTokens: 180, totalCost: 0.0005 },
								processingTimeMs: 250,
							},
						],
						pagination: { hasMore: false },
					});
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'outcomes');

		const listForm = findForm(browser.elementsById.view, 'GET /api/outcomes');
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('SOLUSDT · BINANCE');
		expect(listForm.textContent).toContain('BUY');
		expect(listForm.textContent).toContain('Evaluated');
		expect(listForm.textContent).toContain('Score: 85');
		expect(listForm.textContent).toContain('145.5');
		expect(listForm.textContent).toContain('+2.10%');
		expect(listForm.textContent).toContain('+0.80R');
		expect(listForm.textContent).toContain('+3.20% / -0.40%');
		expect(listForm.textContent).toContain('First: target');

		const detailButton = findButton(listForm, 'Show detail');
		expect(detailButton).toBeDefined();
		await detailButton.dispatch('click');
		await flush();

		expect(detailButton.textContent).toBe('Hide detail');
		expect(listForm.textContent).toContain('req-abc-123');
		expect(listForm.textContent).toContain('market-scanner');
		expect(listForm.textContent).toContain('180 total');
		expect(listForm.textContent).toContain('250 ms');
	});

	it('handles 403 FEATURE_DISABLED and 503 STORAGE_UNAVAILABLE cleanly on outcomes requests', async () => {
		let currentStatus = 403;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/outcomes')) {
					return response({
						error: currentStatus === 403 ? 'Feature disabled' : 'Storage unavailable',
						code: currentStatus === 403 ? 'FEATURE_DISABLED' : 'STORAGE_UNAVAILABLE',
					}, currentStatus);
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'outcomes');

		const listForm = findForm(browser.elementsById.view, 'GET /api/outcomes');
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('HTTP 403');
		expect(listForm.textContent).toContain('FEATURE_DISABLED');

		currentStatus = 503;
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('HTTP 503');
		expect(listForm.textContent).toContain('STORAGE_UNAVAILABLE');
	});

	it('invalidates pending outcomes list and summary responses when filters change', async () => {
		let releaseList;
		let releaseSummary;
		const slowList = new Promise((resolve) => { releaseList = resolve; });
		const slowSummary = new Promise((resolve) => { releaseSummary = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/outcomes/summary')) {
					return slowSummary.then(() => response({ success: true, summary: { totalSignalsReceived: 5 } }));
				}
				if (url.startsWith('/api/outcomes')) {
					return slowList.then(() => response({ success: true, outcomes: [{ id: 'doc-stale', symbol: 'BTCUSDT' }] }));
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'outcomes');

		const listForm = findForm(browser.elementsById.view, 'GET /api/outcomes');
		const listButton = findButton(listForm, 'Load outcomes');
		const listSubmit = listForm.dispatch('submit');
		await flush();

		listForm.elements.symbol.value = 'XRPUSDT';
		await listForm.elements.symbol.dispatch('input');

		expect(listButton.disabled).toBe(false);
		expect(findButton(listForm, 'Copy details').hidden).toBe(true);

		releaseList();
		await flush();
		await listSubmit;
		expect(listForm.textContent).toContain('Filters changed');
		expect(listForm.textContent).not.toContain('doc-stale');

		const summaryForm = findForm(browser.elementsById.view, 'GET /api/outcomes/summary');
		const summaryButton = findButton(summaryForm, 'Load outcomes summary');
		const summarySubmit = summaryForm.dispatch('submit');
		await flush();

		summaryForm.elements.symbol.value = 'ADAUSDT';
		await summaryForm.elements.symbol.dispatch('input');

		expect(summaryButton.disabled).toBe(false);

		releaseSummary();
		await flush();
		await summarySubmit;
		expect(summaryForm.textContent).toContain('Filters changed');
	});

	it('keeps navigation icons as inline SVG instead of platform glyphs', () => {
		const shell = fs.readFileSync(path.join(__dirname, '../../src/admin/index.html'), 'utf8');
		const navItems = shell.match(/<button data-view="/g) || [];
		expect(shell.match(/<svg class="nav-icon"/g)).toHaveLength(navItems.length);
		expect(navItems.length).toBeGreaterThan(0);
		expect(shell).not.toMatch(/[⌂◈◉◇◌✦▷]/);
	});

	it('loads recent Binance orders with symbol and limit filters', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return response({ success: true, environment: 'testnet', orders: [] });
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		listForm.elements.limit.value = '5';
		browser.elementsById['api-key'].value = 'session-secret';
		await listForm.dispatch('submit');
		await flush();

		const last = requests.at(-1);
		expect(last[0]).toBe('/api/trading/binance/orders?symbol=BTCUSDT&limit=5');
		expect(last[1].headers['x-api-key']).toBe('session-secret');
	});

	it('rejects exponent notation and canonicalizes integer order limits', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				requests.push(url);
				return response({ success: true, environment: 'testnet', orders: [] });
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		listForm.elements.limit.value = '1e2';
		await listForm.dispatch('submit');
		await flush();
		expect(requests.at(-1)).toBe('/api/trading/binance/orders?symbol=BTCUSDT');

		listForm.elements.limit.value = '005';
		await listForm.dispatch('submit');
		await flush();
		expect(requests.at(-1)).toBe('/api/trading/binance/orders?symbol=BTCUSDT&limit=5');
	});

	it('renders sanitized Binance order summary fields and hides provider noise', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({
					success: true,
					environment: 'testnet',
					orders: [{
						symbol: 'BTCUSDT',
						orderId: Number('9007199254740993'),
						clientOrderId: 'cb-test-001',
						price: '65000.00',
						origQty: '0.01000000',
						executedQty: '0.00500000',
						cummulativeQuoteQty: '325.00000',
						status: 'PARTIALLY_FILLED',
						type: 'LIMIT',
						side: 'BUY',
						timeInForce: 'GTC',
						transactTime: 1717000000000,
						updateTime: 1717000060000,
						time: 1717000000000,
						workingTime: 1717000000000,
						isWorking: true,
						stopPrice: '0.00000000',
						icebergQty: '0.00000000',
						origQuoteOrderQty: '0.00000000',
						orderListId: -1,
						selfTradePreventionMode: 'NONE',
						fills: [{
							price: '65000.00',
							qty: '0.00500000',
							commission: '0.00000500',
							commissionAsset: 'BNB',
							tradeId: 12345,
							hiddenField: 'hidden-noisy-data',
						}],
						hiddenProviderField: 'hidden-noise',
					}],
				});
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('BTCUSDT');
		expect(listForm.textContent).toContain('LIMIT');
		expect(listForm.textContent).toContain('BUY');
		expect(listForm.textContent).toContain('PARTIALLY_FILLED');
		expect(listForm.textContent).toContain('cb-test-001');
		expect(listForm.textContent).toContain('65000');
		expect(listForm.textContent).toContain('0.00500000');
		expect(listForm.textContent).not.toContain('hidden-noise');
		expect(listForm.textContent).not.toContain('hidden-noisy-data');
	});

	it('looks up a single Binance order by orderId through the dedicated form', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return response({
					success: true,
					environment: 'testnet',
					order: {
						symbol: 'BTCUSDT',
						orderId: 42,
						clientOrderId: 'cb-order-42',
						price: '62000.00',
						origQty: '0.02000000',
						executedQty: '0.02000000',
						status: 'FILLED',
						type: 'MARKET',
						side: 'SELL',
						transactTime: 1717000000000,
						updateTime: 1717000005000,
					},
				});
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'BTCUSDT';
		detailForm.elements['path-orderId'].value = '42';
		await detailForm.dispatch('submit');
		await flush();

		expect(requests.at(-1)[0]).toBe('/api/trading/binance/orders?symbol=BTCUSDT&orderId=42');
		expect(detailForm.textContent).toContain('FILLED');
		expect(detailForm.textContent).toContain('MARKET');
		expect(detailForm.textContent).toContain('SELL');
		expect(detailForm.textContent).toContain('cb-order-42');
	});

	it('rejects exponent notation and canonicalizes order IDs', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				requests.push(url);
				return response({ success: true, environment: 'testnet', order: { status: 'FILLED' } });
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'BTCUSDT';
		detailForm.elements['path-orderId'].value = '1e2';
		await detailForm.dispatch('submit');
		await flush();
		expect(requests).toHaveLength(0);
		expect(detailForm.textContent).toContain('orderId must be a positive integer');

		detailForm.elements['path-orderId'].value = '0042';
		await detailForm.dispatch('submit');
		await flush();
		expect(requests.at(-1)).toBe('/api/trading/binance/orders?symbol=BTCUSDT&orderId=42');
	});

	it('looks up a single Binance order by origClientOrderId through the dedicated form', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				requests.push(url);
				return response({
					success: true,
					environment: 'testnet',
					order: {
						symbol: 'ETHUSDT',
						orderId: 7,
						clientOrderId: 'cb-eth-7',
						status: 'NEW',
						type: 'LIMIT',
						side: 'BUY',
					},
				});
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'ETHUSDT';
		detailForm.elements['path-origClientOrderId'].value = 'cb-eth-7';
		await detailForm.dispatch('submit');
		await flush();

		expect(requests.at(-1)).toBe('/api/trading/binance/orders?symbol=ETHUSDT&origClientOrderId=cb-eth-7');
	});

	it('rejects invalid origClientOrderId before dispatch', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				requests.push(url);
				return response({ success: true, environment: 'testnet', order: {} });
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'ETHUSDT';
		detailForm.elements['path-origClientOrderId'].value = 'invalid/client/id';
		await detailForm.dispatch('submit');
		await flush();

		expect(requests).toHaveLength(0);
		expect(detailForm.textContent).toContain('origClientOrderId must contain 1-36 safe characters');

		detailForm.elements['path-origClientOrderId'].value = 'a'.repeat(37);
		await detailForm.dispatch('submit');
		await flush();

		expect(requests).toHaveLength(0);
		expect(detailForm.textContent).toContain('origClientOrderId must contain 1-36 safe characters');
	});

	it('rejects ambiguous single-order identifiers', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				requests.push(url);
				return response({ success: true, environment: 'testnet', order: {} });
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'BTCUSDT';
		detailForm.elements['path-orderId'].value = '42';
		detailForm.elements['path-origClientOrderId'].value = 'cb-42';
		await detailForm.dispatch('submit');
		await flush();

		expect(requests).toHaveLength(0);
		expect(detailForm.textContent).toContain('Provide exactly one order identifier');
	});

	it('renders malformed Binance order timestamps without throwing', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({
					success: true,
					environment: 'testnet',
					orders: [{ symbol: 'BTCUSDT', orderId: 42, status: 'FILLED', type: 'MARKET', time: 'not-a-timestamp' }],
				});
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		await listForm.dispatch('submit');
		await flush();

		expect(listForm.textContent).toContain('not-a-timestamp');
	});

	it('clears stale Binance orders when filters change before the response resolves', async () => {
		let releaseList;
		const slow = new Promise((resolve) => { releaseList = resolve; });
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/trading/binance/orders')) {
					return slow.then(() => response({
						success: true,
						environment: 'testnet',
						orders: [{ symbol: 'BTCUSDT', orderId: 1, side: 'BUY', status: 'NEW', type: 'LIMIT', executedQty: '0', origQty: '1' }],
					}));
				}
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		const submit = listForm.dispatch('submit');
		await flush();

		listForm.elements.symbol.value = 'ETHUSDT';
		await listForm.elements.symbol.dispatch('input');

		expect(listForm.textContent).toContain('Filters changed');

		releaseList();
		await flush();
		await submit;
		expect(listForm.textContent).not.toContain('orderId');
		expect(listForm.textContent).toContain('Filters changed');
	});

	it('surfaces ORDER_NOT_FOUND through the error UI on single-order lookup', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({
					success: false,
					error: 'Binance order not found',
					code: 'ORDER_NOT_FOUND',
				}, 404);
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'BTCUSDT';
		detailForm.elements['path-orderId'].value = '9999';
		await detailForm.dispatch('submit');
		await flush();

		expect(detailForm.textContent).toContain('HTTP 404');
		expect(detailForm.textContent).toContain('ORDER_NOT_FOUND');
	});

	it('renders an empty state when the recent-orders list has no rows', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => response(url === '/openapi.json' ? contract : { success: true, environment: 'testnet', orders: [] }),
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		await listForm.dispatch('submit');
		await flush();

		const empty = find(listForm, (node) => node.className === 'empty-state');
		expect(empty).toBeDefined();
		expect(empty.textContent).toContain('No recent orders found.');
	});

	it('disables single-order lookup unless at least one identifier is set', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({ success: true, environment: 'testnet', order: {} });
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'BTCUSDT';
		const button = findButton(detailForm, 'Get single order');
		const submitPromise = detailForm.dispatch('submit');
		await flush();
		expect(button.disabled).toBe(false);
		expect(detailForm.textContent).toContain('orderId or origClientOrderId');
		await submitPromise;
	});

	it('keeps the API key out of query strings for Binance order requests', async () => {
		const requests = [];
		const browser = createBrowser({
			fetchImpl: async (url, options) => {
				if (url === '/openapi.json') return response(contract);
				requests.push([url, options]);
				return response({ success: true, environment: 'testnet', orders: [] });
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		browser.elementsById['api-key'].value = 'should-only-be-header';
		await listForm.dispatch('submit');
		await flush();

		const last = requests.at(-1);
		expect(last[0]).not.toContain('should-only-be-header');
		expect(last[0]).not.toContain('api-key');
		expect(last[0]).not.toContain('x-api-key');
		expect(last[1].headers['x-api-key']).toBe('should-only-be-header');
	});

	it('renders the Binance environment badge for both list and lookup results', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.includes('orderId=42')) {
					return response({
						success: true,
						environment: 'live',
						order: { symbol: 'BTCUSDT', orderId: 42, side: 'SELL', status: 'FILLED', type: 'MARKET' },
					});
				}
				return response({
					success: true,
					environment: 'testnet',
					orders: [{ symbol: 'BTCUSDT', orderId: 1, side: 'BUY', status: 'NEW', type: 'LIMIT' }],
				});
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		await listForm.dispatch('submit');
		await flush();
		expect(listForm.textContent).toContain('Environment: testnet');
		const listBadge = find(listForm, (node) => node.tagName === 'SPAN' && node.className.includes('status-badge'));
		expect(listBadge.className).toBe('status-badge status-ready');

		const detailForm = findForm(browser.elementsById.view, 'Get single order');
		detailForm.elements.symbol.value = 'BTCUSDT';
		detailForm.elements['path-orderId'].value = '42';
		await detailForm.dispatch('submit');
		await flush();
		expect(detailForm.textContent).toContain('Environment: live');
		const detailBadge = find(detailForm, (node) => node.tagName === 'SPAN' && node.className.includes('status-badge'));
		expect(detailBadge.className).toBe('status-badge status-danger');
	});

	it('resets the Binance environment badge when filters change', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({
					success: true,
					environment: 'testnet',
					orders: [{ symbol: 'BTCUSDT', orderId: 1, side: 'BUY', status: 'NEW', type: 'LIMIT' }],
				});
			},
		});
		await flush();
		await selectView(browser, 'orders');

		const listForm = findForm(browser.elementsById.view, 'Load recent orders');
		listForm.elements.symbol.value = 'BTCUSDT';
		await listForm.dispatch('submit');
		await flush();
		expect(listForm.textContent).toContain('Environment: testnet');

		listForm.elements.symbol.value = 'ETHUSDT';
		await listForm.elements.symbol.dispatch('input');
		expect(listForm.textContent).toContain('Environment: —');
	});
});

describe('news monitor operations view', () => {
	const RUNNING = { paused: false, pausedAt: null, reason: null };
	const PAUSED = {
		paused: true,
		pausedAt: '2026-09-04T06:00:00.000Z',
		reason: 'Gemini quota exhausted',
	};
	// Shaped exactly like NewsAnalysisStorageService.summarizeAnalyses(): the bySymbol count
	// key is `totalAnalyses`, the byEventCategory one is `total`, confidence arrives as
	// `averageConfidence`, and there is no top-level alertRatePercent at all. A fixture
	// invented from the old OpenAPI schema is what let this view ship rendering zeros.
	const SUMMARY = {
		success: true,
		totalAnalyses: 4,
		totalAlertsSent: 2,
		bySymbol: {
			BTCUSDT: { totalAnalyses: 2, alertsSent: 2, averageConfidence: 0.84 },
			ETHUSDT: { totalAnalyses: 2, alertsSent: 0, averageConfidence: 0.52 },
		},
		byEventCategory: {
			price_surge: { total: 3, alertsSent: 2, averageConfidence: 0.73 },
			none: { total: 1, alertsSent: 0, averageConfidence: 0.41 },
		},
		falsePositiveProxy: { threshold: 0.7, totalEvaluated: 2, noFollowupCount: 1, ratePercent: 50 },
		window: { from: '2026-09-03T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z', limit: 500 },
	};
	const ANALYSES = {
		success: true,
		analyses: [
			{
				id: 'a1', createdAt: '2026-09-04T05:00:00.000Z', symbol: 'BTCUSDT', eventCategory: 'none',
				sentiment: 0.12, confidence: 0.41, headline: 'Nothing moved', alertSent: false,
				promptVersion: null, tokens: 120, expiresAt: '2026-10-04T05:00:00.000Z',
			},
		],
		nextCursor: null,
	};

	const newsMonitorRoutes = (overrides = {}) => {
		const calls = [];
		const impl = async (url, options = {}) => {
			const [path, search = ''] = String(url).split('?');
			calls.push({ path, search, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : undefined });
			if (path === '/openapi.json') return response(contract);
			if (path === '/api/news-monitor/status') return response(RUNNING);
			if (path === '/api/news-monitor/summary') return response(SUMMARY);
			if (path === '/api/news-monitor/analyses') return response(ANALYSES);
			return response({});
		};
		const { handler, ...rest } = overrides;
		return { calls, fetchImpl: handler || impl, ...rest };
	};

	const openNewsMonitor = async (overrides = {}) => {
		const setup = newsMonitorRoutes(overrides);
		const browser = createBrowser(setup);
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'newsMonitor');
		await flush();
		return { browser, ...setup };
	};

	const stateSection = (browser) => find(browser.elementsById.view, (node) => node.className.includes('dashboard-section')
		&& node.textContent.startsWith('Monitor state'));
	const stateBadge = (browser) => find(stateSection(browser), (node) => node.className.includes('status-badge'));
	// SVG nodes arrive from the chart kit through setAttribute('class'), so the class
	// attribute has to be read alongside the className property.
	const hasClass = (node, className) => Boolean(node.className && node.className.includes(className))
		|| Boolean(node.attributes && node.attributes.class && node.attributes.class.includes(className));

	it('renders a running state card that does not read as a warning', async () => {
		const { browser } = await openNewsMonitor();
		const view = browser.elementsById.view;
		const section = stateSection(browser);

		expect(stateBadge(browser).textContent).toBe('Running');
		expect(stateBadge(browser).className).toContain('status-ready');
		expect(section.className).not.toContain('banner-error');
		expect(section.textContent).toContain('Running normally');
		expect(view.textContent).not.toContain('No news alerts are being produced');
		expect(section.textContent).toContain('—');
	});

	it('renders a paused state card as a warning with the reason and pause time', async () => {
		const { browser } = await openNewsMonitor({
			handler: async (url, options = {}) => {
				if (url === '/openapi.json') return response(contract);
				if (String(url).startsWith('/api/news-monitor/status')) return response(PAUSED);
				if (String(url).startsWith('/api/news-monitor/summary')) return response(SUMMARY);
				if (String(url).startsWith('/api/news-monitor/analyses')) return response(ANALYSES);
				return response({}, options.status || 200);
			},
		});
		const view = browser.elementsById.view;
		const section = stateSection(browser);

		expect(stateBadge(browser).textContent).toBe('Paused');
		expect(stateBadge(browser).className).toContain('status-danger');
		expect(section.className).toContain('banner-error');
		expect(section.textContent).toContain('No news alerts are being produced');
		expect(section.textContent).toContain('Background sweeps skip execution');
		expect(section.textContent).toContain('Gemini quota exhausted');
		const pausedAtValue = findAll(section, (node) => node.tagName === 'DD')[0];
		expect(pausedAtValue.textContent).toContain('ago');
		expect(findAll(pausedAtValue, (node) => node.className.includes('timestamp'))[0].attributes.title)
			.toContain('2026');
	});

	// The pause response echoes the request reason back, so only a re-read whose reason
	// differs can prove the card renders the monitor's own state.
	it('pauses with the typed reason after confirming, then re-reads status instead of trusting the response', async () => {
		const confirmations = [];
		const seen = [];
		const browser = createBrowser({
			confirm: (message) => {
				confirmations.push(message);
				return true;
			},
			fetchImpl: async (url, options = {}) => {
				const [path] = String(url).split('?');
				seen.push(`${options.method || 'GET'} ${path}`);
				if (path === '/openapi.json') return response(contract);
				if (path === '/api/news-monitor/status') {
					// The pause response echoes the request back; only the re-read proves the
					// card is showing the monitor's own state.
					return response(seen.filter((entry) => entry.endsWith('status')).length > 1 ? PAUSED : RUNNING);
				}
				if (path === '/api/news-monitor/pause') {
					return response({ message: 'News monitor analysis paused', paused: true, pausedAt: '2026-09-04T05:00:00.000Z', reason: 'Gemini quota exhausted' });
				}
				if (path === '/api/news-monitor/summary') return response(SUMMARY);
				if (path === '/api/news-monitor/analyses') return response(ANALYSES);
				return response({}, options.status || 200);
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'newsMonitor');
		await flush();
		expect(stateBadge(browser).textContent).toBe('Running');

		const reason = find(browser.elementsById.view, (node) => node.name === 'news-monitor-pause-reason');
		reason.value = 'Gemini quota exhausted';
		await findButton(browser.elementsById.view, 'Pause news monitor').dispatch('click');
		await flush();

		expect(confirmations).toHaveLength(1);
		expect(confirmations[0]).toContain('Pause the news monitor?');
		expect(seen).toContain('POST /api/news-monitor/pause');
		const pauseCall = browser.helperCalls.find((call) => call.path === '/api/news-monitor/pause');
		expect(pauseCall.body).toEqual({ reason: 'Gemini quota exhausted' });
		// Ordering, not presence: a refetch that ran before the mutation would also match.
		expect(seen.lastIndexOf('POST /api/news-monitor/pause')).toBeLessThan(seen.lastIndexOf('GET /api/news-monitor/status'));
		expect(stateBadge(browser).textContent).toBe('Paused');
		expect(stateSection(browser).textContent).toContain('Gemini quota exhausted');
	});

	it('sends no reason key when the pause reason is left blank, and resumes after confirming', async () => {
		const confirmations = [];
		const seen = [];
		const { browser } = await openNewsMonitor({
			confirm: (message) => {
				confirmations.push(message);
				return true;
			},
			handler: async (url, options = {}) => {
				const [path] = String(url).split('?');
				seen.push(`${options.method || 'GET'} ${path}`);
				if (path === '/openapi.json') return response(contract);
				if (path === '/api/news-monitor/status') {
					return response(seen.filter((entry) => entry.endsWith('resume')).length > 0 ? RUNNING : PAUSED);
				}
				if (path === '/api/news-monitor/pause') return response({ message: 'paused', paused: true, pausedAt: '2026-09-04T05:00:00.000Z', reason: null });
				if (path === '/api/news-monitor/resume') return response({ message: 'resumed', paused: false, resumedAt: '2026-09-04T07:00:00.000Z', wasPaused: true });
				if (path === '/api/news-monitor/summary') return response(SUMMARY);
				if (path === '/api/news-monitor/analyses') return response(ANALYSES);
				return response({}, options.status || 200);
			},
		});
		expect(stateBadge(browser).textContent).toBe('Paused');

		await findButton(browser.elementsById.view, 'Pause news monitor').dispatch('click');
		await flush();
		const pauseCall = browser.helperCalls.find((call) => call.path === '/api/news-monitor/pause');
		expect(pauseCall).toBeDefined();
		expect(pauseCall.body).toEqual({});
		confirmations.length = 0;

		await findButton(browser.elementsById.view, 'Resume news monitor').dispatch('click');
		await flush();
		expect(confirmations).toHaveLength(1);
		expect(confirmations[0]).toContain('Resume the news monitor?');
		expect(seen).toContain('POST /api/news-monitor/resume');
		expect(seen.lastIndexOf('POST /api/news-monitor/resume')).toBeLessThan(seen.lastIndexOf('GET /api/news-monitor/status'));
		expect(stateBadge(browser).textContent).toBe('Running');
	});

	it('does not send pause or resume when the operator declines the confirmation', async () => {
		const dispatched = [];
		const { browser } = await openNewsMonitor({
			confirm: () => false,
			handler: async (url, options = {}) => {
				dispatched.push(String(url).split('?')[0]);
				if (url === '/openapi.json') return response(contract);
				if (String(url).startsWith('/api/news-monitor/status')) return response(RUNNING);
				if (String(url).startsWith('/api/news-monitor/summary')) return response(SUMMARY);
				if (String(url).startsWith('/api/news-monitor/analyses')) return response(ANALYSES);
				return response({}, options.status || 200);
			},
		});
		await findButton(browser.elementsById.view, 'Pause news monitor').dispatch('click');
		await flush();
		await findButton(browser.elementsById.view, 'Resume news monitor').dispatch('click');
		await flush();
		// The request is built before the dialog opens, so only the dispatch proves nothing
		// was sent.
		expect(dispatched).not.toContain('/api/news-monitor/pause');
		expect(dispatched).not.toContain('/api/news-monitor/resume');
		expect(stateBadge(browser).textContent).toBe('Running');
	});

	it('maps the summary onto KPI cards and derives the alert rate from the counts it does carry', async () => {
		const { browser } = await openNewsMonitor();
		const view = browser.elementsById.view;
		const cards = () => findAll(view, (node) => node.className.includes('metric-card'));

		expect(cards()).toHaveLength(4);
		expect(cards()[0].textContent).toContain('Analyses4');
		expect(cards()[1].textContent).toContain('Alerts sent2');
		// The payload has no alertRatePercent, so the KPI must be computed from the counts:
		// 2 of 4 is 50%, not the fabricated 0% a missing field used to render.
		expect(cards()[2].textContent).toContain('Alert rate50%');
		expect(cards()[2].textContent).toContain('50% of analyses became alerts');
		expect(cards()[2].textContent).toContain('(2 of 4)');
		expect(cards()[3].textContent).toContain('False-positive proxy50%');
		expect(cards()[3].textContent).toContain('1 of 2 delivered alerts had no follow-up within 24h');

		expect(view.textContent).toContain('Analyses by symbol');
		expect(view.textContent).toContain('BTCUSDT');
		expect(view.textContent).toContain('ETHUSDT');
		expect(view.textContent).toContain('Analyses by event category');
		expect(view.textContent).toContain('price_surge');
		// barChart from #1288 renders an accessible <svg>, not a bare table.
		expect(findAll(view, (node) => node.tagName === 'SVG' && hasClass(node, 'chart-bar-svg')).length).toBeGreaterThan(0);
		// Two symbols is enough for a sparkline on the KPI card.
		expect(findAll(view, (node) => node.tagName === 'SVG' && hasClass(node, 'chart-sparkline-svg')).length).toBeGreaterThan(0);
	});

	it('reads the breakdown volumes the service actually returns, sorted by volume', async () => {
		const { browser } = await openNewsMonitor();
		const view = browser.elementsById.view;
		const symbolRows = () => findAll(view, (node) => node.className.includes('table-scroll')
			&& node.attributes['aria-label'] === 'Analyses by symbol');
		const categoryRows = () => findAll(view, (node) => node.className.includes('table-scroll')
			&& node.attributes['aria-label'] === 'Analyses by event category');

		// `totalAnalyses` / `total` are the real count keys; reading a nonexistent `count`
		// rendered every volume as 0 and made every bar width zero.
		expect(symbolRows()[0].textContent).toContain('BTCUSDT');
		expect(symbolRows()[0].textContent).toContain('2');
		expect(symbolRows()[0].textContent).toContain('100%');
		expect(symbolRows()[0].textContent).toContain('0.84');
		expect(symbolRows()[0].textContent).not.toContain('0.00');
		// price_surge has 3 analyses against none's 1, so it must lead despite sorting
		// alphabetically later.
		const categoryCells = findAll(categoryRows()[0], (node) => node.tagName === 'TD').map((node) => node.textContent);
		expect(categoryCells.slice(0, 4)).toEqual(['price_surge', '3', '2', '66.67%']);

		// A zero-width bar is what a 0 volume produced; the chart must now carry real values.
		const barWidths = findAll(view, (node) => node.tagName === 'RECT').map((node) => node.attributes.width);
		expect(barWidths.some((width) => Number(width) > 0)).toBe(true);
		expect(find(view, (node) => node.tagName === 'SVG' && hasClass(node, 'chart-bar-svg')).attributes['aria-label'])
			.toMatch(/Analyses by symbol.*high 2 at BTCUSDT/);
	});

	it('renders the false-positive threshold as a 0-1 confidence fraction, not a percentage', async () => {
		const { browser } = await openNewsMonitor();
		const view = browser.elementsById.view;
		const proxy = find(view, (node) => node.textContent.startsWith('False-positive proxy') && node.className.includes('dashboard-section'));
		const terms = findAll(proxy, (node) => node.tagName === 'DT').map((node) => node.textContent);
		const values = findAll(proxy, (node) => node.tagName === 'DD').map((node) => node.textContent);

		expect(values[terms.indexOf('Threshold')]).toBe('0.70');
		expect(proxy.textContent).not.toContain('0.7%');
		// ratePercent is genuinely a percentage and must keep its sign.
		expect(values[terms.indexOf('Rate')]).toBe('50%');
	});

	it('names the window as empty rather than implying a zero alert rate', async () => {
		const { browser } = await openNewsMonitor({
			handler: async (url) => {
				if (String(url).startsWith('/openapi.json')) return response(contract);
				if (String(url).startsWith('/api/news-monitor/status')) return response(RUNNING);
				if (String(url).startsWith('/api/news-monitor/summary')) {
					return response({
						success: true,
						totalAnalyses: 0,
						totalAlertsSent: 0,
						bySymbol: {},
						byEventCategory: {},
						falsePositiveProxy: { threshold: 0.7, totalEvaluated: 0, noFollowupCount: 0, ratePercent: 0 },
						window: {},
					});
				}
				if (String(url).startsWith('/api/news-monitor/analyses')) return response(ANALYSES);
				return response({});
			},
		});
		const view = browser.elementsById.view;
		const cards = () => findAll(view, (node) => node.className.includes('metric-card'));
		expect(cards()[2].textContent).toContain('No analyses recorded in this window');
		expect(cards()[2].textContent).not.toContain('0% of analyses became alerts');
		expect(view.textContent).toContain('No analyses recorded in this window.');
	});

	it('formats an absent percentage as an em dash rather than as 0%', () => {
		const { formatPercent } = require('../../src/admin/admin-newsmonitor');
		// Number(null), Number(undefined) and Number('') are all 0, so an unguarded coercion
		// printed a real-looking 0% for a measurement that was never taken.
		expect(formatPercent(null)).toBe('—');
		expect(formatPercent(undefined)).toBe('—');
		expect(formatPercent('')).toBe('—');
		// A reported zero is still a zero and must keep reading as one.
		expect(formatPercent(0)).toBe('0%');
		expect(formatPercent(50)).toBe('50%');
	});

	it('renders an explicit empty state when no analyses match the filters', async () => {
		const { browser } = await openNewsMonitor({
			handler: async (url) => {
				if (String(url).startsWith('/openapi.json')) return response(contract);
				if (String(url).startsWith('/api/news-monitor/status')) return response(RUNNING);
				if (String(url).startsWith('/api/news-monitor/summary')) return response(SUMMARY);
				if (String(url).startsWith('/api/news-monitor/analyses')) {
					return response({ success: true, analyses: [], nextCursor: null });
				}
				return response({});
			},
		});
		const view = browser.elementsById.view;
		expect(view.textContent).not.toContain('No recorded analyses match these filters.');
		await findForm(view, '/api/news-monitor/analyses').dispatch('submit');
		await flush();
		expect(view.textContent).toContain('No recorded analyses match these filters.');
		expect(view.textContent).not.toContain('No analyses requested yet.');
	});

	it('renders recorded analyses and pages forward with the server cursor', async () => {
		const requested = [];
		const { browser } = await openNewsMonitor({
			handler: async (url) => {
				const [path, search = ''] = String(url).split('?');
				if (path === '/openapi.json') return response(contract);
				if (path === '/api/news-monitor/status') return response(RUNNING);
				if (path === '/api/news-monitor/summary') return response(SUMMARY);
				if (path === '/api/news-monitor/analyses') {
					requested.push(search);
					return search.includes('before=c2')
						? response({ success: true, analyses: [{ ...ANALYSES.analyses[0], id: 'a2', symbol: 'ETHUSDT' }], nextCursor: null })
						: response({ ...ANALYSES, nextCursor: 'c2' });
				}
				return response({});
			},
		});
		const view = browser.elementsById.view;
		const form = findForm(view, '/api/news-monitor/analyses');
		await form.dispatch('submit');
		await flush();

		expect(view.textContent).toContain('BTCUSDT');
		expect(find(view, (node) => node.tagName === 'DIV' && node.attributes['aria-label'] === 'Recorded news analyses (1)')).toBeDefined();
		expect(requested[0]).toContain('limit=50');
		expect(requested[0]).toContain('from=');
		expect(requested[0]).toContain('to=');
		expect(findButton(view, 'Previous page').disabled).toBe(true);
		expect(findButton(view, 'Next page').disabled).toBe(false);

		await findButton(view, 'Next page').dispatch('click');
		await flush();
		expect(requested.some((entry) => entry.includes('before=c2'))).toBe(true);
		expect(view.textContent).toContain('ETHUSDT');
		expect(findButton(view, 'Next page').disabled).toBe(true);
		expect(findButton(view, 'Previous page').disabled).toBe(false);

		await findButton(view, 'Previous page').dispatch('click');
		await flush();
		expect(view.textContent).toContain('BTCUSDT');
		expect(findButton(view, 'Previous page').disabled).toBe(true);
	});

	it('renders the Analyzed column from createdAt as a timestamp, never as an em dash', async () => {
		const { browser } = await openNewsMonitor();
		const view = browser.elementsById.view;
		const form = findForm(view, '/api/news-monitor/analyses');
		await form.dispatch('submit');
		await flush();

		const table = find(view, (node) => node.tagName === 'DIV' && node.attributes['aria-label'] === 'Recorded news analyses (1)');
		const headers = findAll(table, (node) => node.tagName === 'TH').map((node) => node.textContent);
		expect(headers).toContain('Analyzed');
		const cells = findAll(findAll(table, (node) => node.tagName === 'TR')[1], (node) => node.tagName === 'TD')
			.map((node) => node.textContent);
		// The record carries createdAt; reading analyzedAt rendered a permanent em dash.
		expect(cells[5]).toContain('ago');
		const analyzedCell = findAll(findAll(table, (node) => node.tagName === 'TR')[1], (node) => node.tagName === 'TD')[5];
		expect(findAll(analyzedCell, (node) => node.className.includes('timestamp'))[0].attributes.title)
			.toContain('2026');
		// The category is a string, not a number: formatting it as a fraction blanked it to
		// an em dash, which is the same "unreadable value" failure as the Analyzed column.
		expect(cells[1]).toBe('none');
	});

	it('renders an analyses record with a populated event category', async () => {
		const { browser } = await openNewsMonitor({
			handler: async (url) => {
				const [path] = String(url).split('?');
				if (path === '/openapi.json') return response(contract);
				if (path === '/api/news-monitor/status') return response(RUNNING);
				if (path === '/api/news-monitor/summary') return response(SUMMARY);
				if (path === '/api/news-monitor/analyses') {
					return response({
						success: true,
						analyses: [{ ...ANALYSES.analyses[0], eventCategory: 'price_surge' }],
						nextCursor: null,
					});
				}
				return response({});
			},
		});
		const view = browser.elementsById.view;
		await findForm(view, '/api/news-monitor/analyses').dispatch('submit');
		await flush();
		const table = find(view, (node) => node.tagName === 'DIV' && node.attributes['aria-label'] === 'Recorded news analyses (1)');
		const cells = findAll(findAll(table, (node) => node.tagName === 'TR')[1], (node) => node.tagName === 'TD')
			.map((node) => node.textContent);
		expect(cells[1]).toBe('price_surge');
		expect(cells[3]).toBe('0.41');
	});

	it('clears the cursor chain when a filter changes so paging cannot skip rows', async () => {
		const requested = [];
		const { browser } = await openNewsMonitor({
			handler: async (url) => {
				const [path, search = ''] = String(url).split('?');
				if (path === '/openapi.json') return response(contract);
				if (path === '/api/news-monitor/status') return response(RUNNING);
				if (path === '/api/news-monitor/summary') return response(SUMMARY);
				if (path === '/api/news-monitor/analyses') {
					requested.push(search);
					return response({ ...ANALYSES, nextCursor: 'c2' });
				}
				return response({});
			},
		});
		const view = browser.elementsById.view;
		const form = findForm(view, '/api/news-monitor/analyses');
		await form.dispatch('submit');
		await flush();
		expect(findButton(view, 'Next page').disabled).toBe(false);

		const symbol = find(view, (node) => node.name === 'symbol');
		symbol.value = 'BTCUSDT';
		await symbol.dispatch('input');

		expect(findButton(view, 'Next page').disabled).toBe(true);
		expect(findButton(view, 'Previous page').disabled).toBe(true);
		await form.dispatch('submit');
		await flush();
		const last = requested[requested.length - 1];
		expect(last).toContain('symbol=BTCUSDT');
		expect(last).not.toContain('before=');
	});

	it('reports the paused state as a named action instead of a generic failure', async () => {
		const pausedBody = {
			error: 'News monitor analysis is temporarily paused.',
			code: 'NEWS_MONITOR_PAUSED',
			paused: true,
			pausedAt: '2026-09-04T06:00:00.000Z',
			reason: 'Gemini quota exhausted',
			requestId: 'req-1',
		};
		const { browser } = await openNewsMonitor({
			handler: async (url) => {
				if (String(url).startsWith('/openapi.json')) return response(contract);
				if (String(url).startsWith('/api/news-monitor/status')) return response(RUNNING);
				if (String(url).startsWith('/api/news-monitor/summary')) return response(pausedBody, 503);
				if (String(url).startsWith('/api/news-monitor/analyses')) return response(ANALYSES);
				return response({});
			},
		});
		const view = browser.elementsById.view;
		expect(view.textContent).toContain('The news monitor is paused');
		expect(view.textContent).toContain('resume to continue');
		expect(view.textContent).toContain('Recorded reason: Gemini quota exhausted');
	});

	it('reports an unread pause state as unknown instead of as running', async () => {
		const { browser } = await openNewsMonitor({
			handler: async (url, options = {}) => {
				if (url === '/openapi.json') return response(contract);
				if (String(url).startsWith('/api/news-monitor/status')) return response({ error: 'Unauthorized', code: 'INVALID_API_KEY' }, 401);
				if (String(url).startsWith('/api/news-monitor/summary')) return response({ error: 'Unauthorized' }, 401);
				return response({}, options.status || 200);
			},
		});
		const view = browser.elementsById.view;
		expect(stateBadge(browser).textContent).toBe('Unavailable');
		expect(stateBadge(browser).className).toContain('status-misconfigured');
		expect(stateSection(browser).textContent).toContain('could not be read');
		expect(view.textContent).toContain('Delivery analytics unavailable.');
		expect(view.textContent).not.toContain('Running normally');
		expect(view.textContent).not.toContain('Loading delivery analytics…');
	});

	it('clears the breakdowns when a summary read fails after a good one', async () => {
		// The previous window's charts and tables are the dangerous part here: left in place
		// they sit directly beside "Delivery analytics unavailable." and read as current.
		let failSummary = false;
		const { browser } = await openNewsMonitor({
			handler: async (url) => {
				if (String(url).startsWith('/openapi.json')) return response(contract);
				if (String(url).startsWith('/api/news-monitor/status')) return response(RUNNING);
				if (String(url).startsWith('/api/news-monitor/summary')) {
					return failSummary ? response({ error: 'Unavailable' }, 503) : response(SUMMARY);
				}
				return response({});
			},
		});
		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Analyses by symbol');
		expect(view.textContent).toContain('BTCUSDT');

		failSummary = true;
		const summaryForm = find(view, (node) => node.tagName === 'FORM' && node.textContent.includes('Load analytics'));
		await summaryForm.dispatch('submit');
		await flush();

		expect(view.textContent).toContain('Delivery analytics unavailable.');
		expect(view.textContent).not.toContain('BTCUSDT');
		expect(view.textContent).not.toContain('Analyses by event category');
		expect(view.textContent).not.toContain('price_surge');
		expect(view.textContent).toContain('Breakdown unavailable');
	});

	it('claims nothing about the monitor before any status read has happened', async () => {
		// No API key and no Firebase session: the pause state was never read, so the card
		// used to render the healthy branch — a green RUNNING badge on a monitor that might
		// have been paused for months.
		const dispatched = [];
		const browser = createBrowser({
			fetchImpl: async (url) => {
				dispatched.push(String(url).split('?')[0]);
				return url === '/openapi.json' ? response(contract) : response({});
			},
		});
		await flush();
		await browser.dispatchPopState();
		browser.location.search = '?view=newsMonitor';
		await browser.dispatchPopState();
		await flush();

		const view = browser.elementsById.view;
		expect(dispatched).not.toContain('/api/news-monitor/status');
		expect(stateBadge(browser).textContent).toBe('Unavailable');
		expect(view.textContent).not.toContain('Running normally');
		expect(view.textContent).not.toContain('Background sweeps and manual analysis requests are accepted');
		expect(view.textContent).toContain('Enter an API key or sign in to load the news monitor state.');
	});

	it('deep-links the news monitor view and its filter scopes', async () => {
		const browser = createBrowser({ fetchImpl: async (url) => (url === '/openapi.json' ? response(contract) : response(RUNNING)) });
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await browser.dispatchPopState();
		browser.location.search = '?view=newsMonitor&newsMonitor.analyses.symbol=BTCUSDT';
		await browser.dispatchPopState();
		await flush();

		expect(browser.titleHistory[browser.titleHistory.length - 1]).toContain('News monitor');
		const view = browser.elementsById.view;
		expect(view.textContent).toContain('Recorded analyses');
		expect(find(view, (node) => node.name === 'symbol').value).toBe('BTCUSDT');
	});
});

// Issue #952. Every operational result table used to be a bare <table> with a header <tr>
// appended straight onto it: no caption, no thead/tbody, no `scope`, and no scroll
// container, so a nine-column outcomes table either compressed into wrapped fragments or
// set the page's own min-content width. A screen reader got no table name and no header
// relationship at all.
describe('result table semantics and narrow-viewport layout (#952)', () => {
	const hasClass = (node, name) => String(node.className || '').split(/\s+/).includes(name);
	const dataTables = (root) => findAll(root, (node) => node.tagName === 'TABLE' && hasClass(node, 'data-table'));

	// The contract every rendered table has to satisfy. Asserted per view rather than on a
	// single fixture so a new call site cannot ship without it: the point of #952 is that
	// this holds for *every* `.data-table`, not for the one table that was measured.
	const expectAccessibleTables = (root) => {
		const tables = dataTables(root);
		expect(tables.length).toBeGreaterThan(0);

		tables.forEach((table) => {
			const captions = findAll(table, (node) => node.tagName === 'CAPTION');
			expect(captions).toHaveLength(1);
			expect(captions[0].textContent.trim().length).toBeGreaterThan(0);

			const theads = findAll(table, (node) => node.tagName === 'THEAD');
			const tbodies = findAll(table, (node) => node.tagName === 'TBODY');
			expect(theads).toHaveLength(1);
			expect(tbodies).toHaveLength(1);
			// A <tr> that is a direct child of <table> is neither header nor body content,
			// which is exactly the structure the bare renderer produced.
			expect(findAll(table, (node) => node.tagName === 'TR' && node.parentNode === table)).toHaveLength(0);

			const headers = findAll(theads[0], (node) => node.tagName === 'TH');
			expect(headers.length).toBeGreaterThan(0);
			headers.forEach((header) => expect(header.attributes.scope).toBe('col'));
			// Column count is the invariant that catches a dropped or reordered column.
			expect(headers).toHaveLength(findAll(tbodies[0], (node) => node.tagName === 'TD')[0]?.children.length || headers.length);

			// The scroller is what keeps an unbreakable header from widening the page, so a
			// table outside one is a regression even though every other assertion passes.
			expect(hasClass(table.parentNode, 'table-scroll')).toBe(true);
			expect(table.parentNode.attributes.role).toBe('region');
			expect(table.parentNode.attributes.tabindex).toBe('0');
			expect(table.parentNode.attributes['aria-label']).toBe(captions[0].textContent);
		});

		return tables;
	};

	const alertsSummaryPayload = (overrides = {}) => ({
		success: true,
		summary: {
			totalAlerts: 4,
			window: {},
			delivery: { totalSuccess: 3, totalFailure: 1, byChannel: { telegram: { total: 3, success: 2, failure: 1 } } },
			enrichment: {
				enrichedAlerts: 4,
				plainAlerts: 0,
				riskMetadataCoverage: { denominator: 4, fields: { target_level: { populated: 2, percentage: 50 } } },
				sentimentCalibration: {
					sampleCount: 97, evaluated: true, saturated: false, reason: null,
					min: 0.3, max: 0.9, p10: 0.4, p50: 0.5, p90: 0.6, spread: 0.2,
					topBandCount: 1, topBandShare: 0.01, distinctValueCount: 40, bucketCount: 6,
					rawScoreCapCount: 3,
					buckets: [{ lowerBound: 0.3, upperBound: 0.5, count: 12 }, { lowerBound: 0.5, upperBound: 0.7, count: 85 }],
				},
				tokenUsage: {},
			},
		},
		...overrides,
	});

	const outcomesSummaryPayload = () => ({
		success: true,
		summary: {
			totalSignalsReceived: 40,
			totalSignalsEvaluated: 30,
			expectancyR: 0.42,
			averageReturnPercent: 1.3,
			averageMfePercent: 2.4,
			averageMaePercent: -0.7,
			windows: {
				'1h': {
					totalSignals: 40, hitRatePercent: 50, targetHitRatePercent: 40, stopHitRatePercent: 10,
					expectancyR: 0.3, averageReturnPercent: 1.0, averageMfePercent: 2.0, averageMaePercent: -0.4,
				},
			},
		},
	});

	it('gives the nine-column outcomes table a caption, scoped headers and a scroll region', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/outcomes/summary')) return response(outcomesSummaryPayload());
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'outcomes');
		const form = findForm(browser.elementsById.view, 'GET /api/outcomes/summary');
		await form.dispatch('submit');
		await flush();

		const tables = expectAccessibleTables(form);
		const performance = tables.find((table) => findAll(table, (node) => node.tagName === 'CAPTION')[0].textContent === 'Performance by window');
		expect(performance).toBeDefined();

		// Column order and the header labels themselves are the operator-facing contract;
		// only the surrounding structure may change.
		expect(findAll(findAll(performance, (node) => node.tagName === 'THEAD')[0], (node) => node.tagName === 'TH').map((node) => node.textContent))
			.toEqual(['Window', 'Evaluated', 'Hit rate', 'Target hit', 'Stop hit', 'Exp (R)', 'Avg return', 'Avg MFE', 'Avg MAE']);
		expect(findAll(findAll(performance, (node) => node.tagName === 'TBODY')[0], (node) => node.tagName === 'TD').map((node) => node.textContent))
			.toEqual(['1h', '40', '50%', '40%', '10%', '+0.3R', '+1%', '+2%', '-0.4%']);
	});

	it('gives every alert-analytics table a caption and scoped headers', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				if (url.startsWith('/api/alerts/summary')) return response(alertsSummaryPayload());
				return response({});
			},
		});
		await flush();
		await selectView(browser, 'alerts');
		const form = findForm(browser.elementsById.view, 'GET /api/alerts/summary');
		await form.dispatch('submit');
		await flush();

		const captions = expectAccessibleTables(form).map((table) => findAll(table, (node) => node.tagName === 'CAPTION')[0].textContent);
		// Delivery, risk coverage and the sentiment histogram are three separate renderers;
		// leaving one out is the regression this sweep exists to catch.
		expect(captions).toEqual(expect.arrayContaining(['Delivery by channel', 'Risk metadata coverage', 'Sentiment score buckets']));

		const channelTable = dataTables(form).find((table) => findAll(table, (node) => node.tagName === 'CAPTION')[0].textContent === 'Delivery by channel');
		expect(findAll(findAll(channelTable, (node) => node.tagName === 'THEAD')[0], (node) => node.tagName === 'TH').map((node) => node.textContent))
			.toEqual(['Channel', 'Total', 'Success', 'Failure']);
		expect(findAll(findAll(channelTable, (node) => node.tagName === 'TBODY')[0], (node) => node.tagName === 'TD').map((node) => node.textContent))
			.toEqual(['Telegram', '3', '2', '1']);
	});

	it('gives the job symbol and scanner result tables a caption and scoped headers', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({
					success: true,
					jobId: 'job-tables',
					status: 'completed',
					results: [{ symbol: 'BTCUSDT', status: 'ok', price: 123.4, rsi: 55.2 }],
					scanResults: [{
						scan: 'top_gainers',
						status: 'completed',
						scores: [{ symbol: 'ETHUSDT', score: 88, reason: 'volume', trendConfluence: { status: 'aligned', direction: 'up', confidence: 70 } }],
					}],
				});
			},
		});
		await flush();
		await selectView(browser, 'jobs');
		const form = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		form.elements['path-jobId'].value = 'job-tables';
		await form.dispatch('submit');
		await flush();

		const captions = expectAccessibleTables(form).map((table) => findAll(table, (node) => node.tagName === 'CAPTION')[0].textContent);
		expect(captions).toEqual(expect.arrayContaining(['Symbol results', 'top_gainers scores']));

		const symbolTable = dataTables(form).find((table) => findAll(table, (node) => node.tagName === 'CAPTION')[0].textContent === 'Symbol results');
		expect(findAll(findAll(symbolTable, (node) => node.tagName === 'THEAD')[0], (node) => node.tagName === 'TH').map((node) => node.textContent))
			.toEqual(['Symbol', 'Status', 'Price', 'RSI']);
		expect(findAll(findAll(symbolTable, (node) => node.tagName === 'TBODY')[0], (node) => node.tagName === 'TD').map((node) => node.textContent))
			.toEqual(['BTCUSDT', 'ok', '123.4', '55.2']);
	});

	it('keeps the empty symbol-result and error states intact', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({
					success: true,
					jobId: 'job-empty',
					status: 'failed',
					// Rows without a symbol and a status are the shape that made the bare
					// renderer emit a header with no body; the section must still disappear.
					results: [{ price: 1 }],
					scanResults: [{ scan: 'top_losers', status: 'timeout' }],
				});
			},
		});
		await flush();
		await selectView(browser, 'jobs');
		const form = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
		form.elements['path-jobId'].value = 'job-empty';
		await form.dispatch('submit');
		await flush();

		expect(form.textContent).not.toContain('Symbol results');
		expect(form.textContent).toContain('This scan did not complete');
		expect(dataTables(form)).toHaveLength(0);
	});
});


describe('structured analysis forms', () => {
	it('renders structured controls for analysis operations and provides raw JSON sync', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'analysis');
		await flush();

		const view = browser.elementsById.view;

		// 1. Volume Confirmation Form
		const vcForm = findForm(view, 'POST /api/webhook/volume-confirmation');
		expect(vcForm).toBeDefined();
		expect(vcForm.elements.symbol).toBeDefined();
		expect(vcForm.elements.timeframe).toBeDefined();
		expect(vcForm.elements.body).toBeDefined();

		// Real-time synchronization
		vcForm.elements.symbol.value = 'BINANCE:ETHUSDT';
		await vcForm.elements.symbol.dispatch('input');
		await flush();
		const vcParsed = JSON.parse(vcForm.elements.body.value);
		expect(vcParsed.symbol).toBe('BINANCE:ETHUSDT');

		// 2. Expanded Analysis Form
		const expForm = findForm(view, 'POST /api/webhook/expanded-analysis-alert');
		expect(expForm).toBeDefined();
		expect(expForm.elements.symbols).toBeDefined();
		expect(expForm.elements.timeframe).toBeDefined();
		expect(expForm.elements.analysisMode).toBeDefined();
		expect(expForm.elements.includeMultiTimeframe).toBeDefined();
		expect(expForm.elements.channel_telegram).toBeDefined();
		expect(expForm.elements.channel_whatsapp).toBeDefined();
		expect(expForm.elements.channel_discord).toBeDefined();
		expect(expForm.elements.body).toBeDefined();

		// 3. Market Scanner Form
		const scanForm = findForm(view, 'POST /api/webhook/market-scanner-alert');
		expect(scanForm).toBeDefined();
		expect(scanForm.elements.exchange).toBeDefined();
		expect(scanForm.elements.timeframe).toBeDefined();
		expect(scanForm.elements.scan_top_gainers).toBeDefined();
		expect(scanForm.elements.scan_top_losers).toBeDefined();
		expect(scanForm.elements.scan_volume_breakout_scanner).toBeDefined();
		expect(scanForm.elements.scan_smart_volume_scanner).toBeDefined();
		expect(scanForm.elements.scan_bollinger_scan).toBeDefined();
		expect(scanForm.elements.limit).toBeDefined();
		expect(scanForm.elements.bbw_threshold).toBeDefined();
		expect(scanForm.elements.body).toBeDefined();

		// 4. Symbol Analysis Form
		const symForm = findForm(view, 'POST /api/webhook/symbol-analysis');
		expect(symForm).toBeDefined();
		expect(symForm.elements.symbol).toBeDefined();
		expect(symForm.elements.timeframe).toBeDefined();
		expect(symForm.elements.analysisMode).toBeDefined();
		expect(symForm.elements.body).toBeDefined();

		// 5. News Monitor Form (POST)
		const newsPostForm = findForm(view, 'POST /api/news-monitor');
		expect(newsPostForm).toBeDefined();
		expect(newsPostForm.elements.crypto).toBeDefined();
		expect(newsPostForm.elements.stocks).toBeDefined();
		expect(newsPostForm.elements.channel_telegram).toBeDefined();
		expect(newsPostForm.elements.channel_whatsapp).toBeDefined();
		expect(newsPostForm.elements.channel_discord).toBeDefined();
		expect(newsPostForm.elements.body).toBeDefined();

		// News monitor sync
		newsPostForm.elements.crypto.value = 'SOLUSDT,ADAUSDT';
		await newsPostForm.elements.crypto.dispatch('input');
		await flush();
		const newsParsed = JSON.parse(newsPostForm.elements.body.value);
		expect(newsParsed.crypto).toEqual(['SOLUSDT', 'ADAUSDT']);
	});

	it('validates symbol format on structured analysis submit and prevents invalid requests', async () => {
		let requestedUrl = null;
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				requestedUrl = url;
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';
		await selectView(browser, 'analysis');
		await flush();

		const vcForm = findForm(browser.elementsById.view, 'POST /api/webhook/volume-confirmation');
		vcForm.elements.symbol.value = 'MALFORMED_SYMBOL';
		await vcForm.elements.symbol.dispatch('input');
		await flush();

		await vcForm.dispatch('submit');
		await flush();

		expect(requestedUrl).toBeNull();
		expect(vcForm.textContent).toContain('Malformed symbol');
	});

	describe('structured job builder and auto-handoff', () => {
		it('renders structured job builder with expanded-analysis controls and contract enums', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			await selectView(browser, 'jobs');
			await flush();

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			expect(createForm).toBeDefined();
			expect(createForm.elements.type.value).toBe('expanded-analysis');
			expect(createForm.elements.symbols.value).toBe('BINANCE:BTCUSDT');
			expect(createForm.elements.timeframe.value).toBe('1D');
			expect(createForm.elements.includeMultiTimeframe.checked).toBe(false);
			expect(createForm.elements.body).toBeDefined();

			const initialPayload = JSON.parse(createForm.elements.body.value);
			expect(initialPayload).toEqual({
				type: 'expanded-analysis',
				symbols: ['BINANCE:BTCUSDT'],
				timeframe: '1D',
			});
		});

		it('switches job builder to market-scanner, updating controls and timeframe options', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			await selectView(browser, 'jobs');
			await flush();

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			createForm.elements.type.value = 'market-scanner';
			await createForm.elements.type.dispatch('change');
			await flush();

			expect(createForm.elements.exchange.value).toBe('BINANCE');
			expect(createForm.elements.timeframe.value).toBe('4h');
			expect(Number(createForm.elements.limit.value)).toBe(5);
			expect(Number(createForm.elements.bbw_threshold.value)).toBe(0.05);
			expect(createForm.elements.ranked.checked).toBe(true);
			expect(createForm.elements.includeMultiTimeframe.checked).toBe(true);
			expect(createForm.elements.scan_top_gainers.checked).toBe(true);
			expect(createForm.elements.scan_top_losers.checked).toBe(true);
			expect(createForm.elements.scan_volume_breakout_scanner.checked).toBe(true);

			// Verify limit clamping
			createForm.elements.limit.value = '50';
			await createForm.elements.limit.dispatch('input');
			await flush();
			expect(Number(createForm.elements.limit.value)).toBe(20);

			const msPayload = JSON.parse(createForm.elements.body.value);
			expect(msPayload.type).toBe('market-scanner');
			expect(msPayload.exchange).toBe('BINANCE');
			expect(msPayload.limit).toBe(20);
			expect(msPayload.ranked).toBe(true);
			expect(msPayload.includeMultiTimeframe).toBe(true);
		});

		it('validates symbol format on submit and displays inline feedback without sending request', async () => {
			let dispatched = false;
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url === '/api/jobs/tradingview-analysis') {
						dispatched = true;
						return response({ success: true, jobId: 'job-invalid' }, 201);
					}
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'jobs');
			await flush();

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			createForm.elements.symbols.value = 'INVALID_SYMBOL';
			await createForm.elements.symbols.dispatch('input');
			await flush();

			await createForm.dispatch('submit');
			await flush();

			expect(dispatched).toBe(false);
			expect(createForm.textContent).toContain('Malformed symbol(s): INVALID_SYMBOL');
		});

		it('generates and transmits idempotency-key in headers and displays in response summary', async () => {
			let capturedOptions = null;
			const browser = createBrowser({
				fetchImpl: async (url, options) => {
					if (url === '/openapi.json') return response(contract);
					if (url === '/api/jobs/tradingview-analysis') {
						capturedOptions = options;
						return response({ success: true, jobId: 'job-123-idem' }, 201);
					}
					if (url.startsWith('/api/jobs/job-123-idem')) {
						return response({
							success: true,
							jobId: 'job-123-idem',
							type: 'expanded-analysis',
							status: 'pending',
							progress: { fraction: 0.1, currentPhase: 'queued' },
						});
					}
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-session-key';
			await selectView(browser, 'jobs');
			await flush();

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			createForm.elements.symbols.value = 'BINANCE:BTCUSDT\nBINANCE:ETHUSDT';
			await createForm.elements.symbols.dispatch('input');
			await flush();

			await createForm.dispatch('submit');
			await flush();

			expect(capturedOptions).toBeDefined();
			expect(capturedOptions.method).toBe('POST');
			expect(capturedOptions.headers['x-api-key']).toBe('test-session-key');
			const sentKey = capturedOptions.headers['idempotency-key'];
			expect(typeof sentKey).toBe('string');
			expect(sentKey.length).toBeGreaterThan(5);

			expect(createForm.textContent).toContain(`Idempotency: ${sentKey}`);
		});

		it('shows retry button on error that reuses the exact same idempotency key', async () => {
			const sentKeys = [];
			let attempt = 0;
			const browser = createBrowser({
				fetchImpl: async (url, options) => {
					if (url === '/openapi.json') return response(contract);
					if (url === '/api/jobs/tradingview-analysis') {
						attempt += 1;
						sentKeys.push(options.headers['idempotency-key']);
						if (attempt === 1) {
							return response({ success: false, error: 'Internal server error' }, 500);
						}
						return response({ success: true, jobId: 'job-retried' }, 201);
					}
					if (url.startsWith('/api/jobs/job-retried')) {
						return response({
							success: true,
							jobId: 'job-retried',
							type: 'expanded-analysis',
							status: 'pending',
							progress: {},
						});
					}
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-session-key';
			await selectView(browser, 'jobs');
			await flush();

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			await createForm.dispatch('submit');
			await flush();

			expect(attempt).toBe(1);
			expect(sentKeys.length).toBe(1);
			const firstKey = sentKeys[0];

			const retryBtn = find(createForm, (node) => node.tagName === 'BUTTON' && node.textContent.includes('Retry submission'));
			expect(retryBtn).toBeDefined();
			expect(retryBtn.hidden).toBe(false);

			await retryBtn.dispatch('click');
			await flush();

			expect(attempt).toBe(2);
			expect(sentKeys.length).toBe(2);
			expect(sentKeys[1]).toBe(firstKey);
		});

		it('auto-handoff: on 201 Created with data.jobId, fills status form and loads progress immediately', async () => {
			const requests = [];
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					requests.push(url);
					if (url === '/api/jobs/tradingview-analysis') {
						return response({ success: true, jobId: 'job-auto-handoff-789' }, 201);
					}
					if (url.startsWith('/api/jobs/job-auto-handoff-789')) {
						return response({
							success: true,
							jobId: 'job-auto-handoff-789',
							type: 'expanded-analysis',
							status: 'processing',
							progress: { fraction: 0.65, currentPhase: 'analysis' },
							createdAt: new Date().toISOString(),
						});
					}
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-session-key';
			await selectView(browser, 'jobs');
			await flush();

			const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
			expect(statusForm.elements['path-jobId'].value).toBe('');

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			await createForm.dispatch('submit');
			await flush();

			expect(statusForm.elements['path-jobId'].value).toBe('job-auto-handoff-789');
			expect(requests).toContain('/api/jobs/job-auto-handoff-789');
			expect(statusForm.textContent).toContain('job-auto-handoff-789');
			expect(statusForm.textContent).toContain('processing');
		});

		it('synchronizes advanced callback and channel options into raw JSON', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			await selectView(browser, 'jobs');
			await flush();

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			createForm.elements.channel_telegram.checked = true;
			await createForm.elements.channel_telegram.dispatch('change');
			createForm.elements.telegramChatId.value = '-1009999';
			await createForm.elements.telegramChatId.dispatch('input');
			createForm.elements.callbackUrl.value = 'https://webhook.site/test';
			await createForm.elements.callbackUrl.dispatch('input');
			await flush();

			const payload = JSON.parse(createForm.elements.body.value);
			expect(payload.channels).toEqual(['telegram']);
			expect(payload.telegramChatId).toBe('-1009999');
			expect(payload.callbackUrl).toBe('https://webhook.site/test');
			expect(payload.callbackEvents).toEqual(['completed', 'failed', 'cancelled', 'timed_out']);
		});

		it('retry: exposes same-key retry when network error or transport failure occurs', async () => {
			const sentKeys = [];
			let attempts = 0;
			const browser = createBrowser({
				fetchImpl: async (url, options) => {
					if (url === '/openapi.json') return response(contract);
					if (url === '/api/jobs/tradingview-analysis') {
						attempts += 1;
						sentKeys.push(options.headers['idempotency-key']);
						if (attempts === 1) {
							throw new Error('Failed to fetch: connection timeout');
						}
						return response({ success: true, jobId: 'recovered-job-111' }, 201);
					}
					if (url.startsWith('/api/jobs/recovered-job-111')) {
						return response({ success: true, jobId: 'recovered-job-111', status: 'queued' });
					}
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-session-key';
			await selectView(browser, 'jobs');
			await flush();

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			const retryBtn = find(createForm, (node) => node.tagName === 'BUTTON' && node.textContent.includes('Retry submission'));
			expect(retryBtn.hidden).toBe(true);

			await createForm.dispatch('submit');
			await flush();

			expect(attempts).toBe(1);
			expect(retryBtn.hidden).toBe(false);
			const firstKey = sentKeys[0];
			expect(typeof firstKey).toBe('string');

			// Clicking retry re-submits with the same idempotency key
			await retryBtn.dispatch('click');
			await flush();

			expect(attempts).toBe(2);
			expect(sentKeys[1]).toBe(firstKey);
		});

		it('auto-handoff: on 503 JOB_QUEUE_ACCEPTANCE_UNKNOWN, fills status form with returned jobId and begins auto-loading', async () => {
			const requests = [];
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					requests.push(url);
					if (url === '/api/jobs/tradingview-analysis') {
						return response({
							error: 'The queue acceptance state could not be determined.',
							code: 'JOB_QUEUE_ACCEPTANCE_UNKNOWN',
							jobId: 'unknown-queue-job-503',
						}, 503);
					}
					if (url.startsWith('/api/jobs/unknown-queue-job-503')) {
						return response({
							success: true,
							jobId: 'unknown-queue-job-503',
							status: 'queued',
						});
					}
					return response({ success: true, jobs: [] });
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-session-key';
			await selectView(browser, 'jobs');
			await flush();

			const statusForm = findForm(browser.elementsById.view, 'GET /api/jobs/{jobId}');
			expect(statusForm.elements['path-jobId'].value).toBe('');

			const createForm = findForm(browser.elementsById.view, 'POST /api/jobs/tradingview-analysis');
			await createForm.dispatch('submit');
			await flush();

			expect(statusForm.elements['path-jobId'].value).toBe('unknown-queue-job-503');
			expect(requests).toContain('/api/jobs/unknown-queue-job-503');
			expect(statusForm.textContent).toContain('unknown-queue-job-503');
			expect(statusForm.textContent).toContain('queued');

			// Retry button is also visible on 503 so the operator can retry with same key if desired
			const retryBtn = find(createForm, (node) => node.tagName === 'BUTTON' && node.textContent.includes('Retry submission'));
			expect(retryBtn.hidden).toBe(false);
		});
	});

	describe('Playground UX improvements', () => {
		it('renders schema-aware inputs omitting query or body fields when inapplicable', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');

			// POST /api/jobs/tradingview-analysis has body but NO query parameters
			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('POST /api/jobs/tradingview-analysis')).value;
			await select.dispatch('change');

			expect(playground.elements.body).toBeDefined();
			expect(playground.elements.query).toBeUndefined();

			// GET /api/alerts has query parameters but NO request body
			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('GET /api/alerts —')).value;
			await select.dispatch('change');

			expect(playground.elements.query).toBeDefined();
			expect(playground.elements.body).toBeUndefined();

			// GET /api/scanner-presets/{id} has path parameters but NEITHER query nor body
			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('GET /api/scanner-presets/{id}')).value;
			await select.dispatch('change');

			expect(playground.elements['path-id']).toBeDefined();
			expect(playground.elements.query).toBeUndefined();
			expect(playground.elements.body).toBeUndefined();
		});

		it('groups operations into optgroups and supports real-time text filtering', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
			});
			await flush();
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');
			const optgroups = findAll(select, (node) => node.tagName === 'OPTGROUP');

			expect(optgroups.length).toBeGreaterThanOrEqual(5);
			const groupLabels = optgroups.map((g) => g.label || g.attributes.label);
			expect(groupLabels).toContain('Webhooks');
			expect(groupLabels).toContain('Alerts');
			expect(groupLabels).toContain('Jobs');

			// Filter operations
			const filterInput = playground.elements.filterOperations;
			filterInput.value = 'volume-confirmation';
			await filterInput.dispatch('input');

			const filteredOptions = findAll(select, (node) => node.tagName === 'OPTION');
			expect(filteredOptions.length).toBe(1);
			expect(filteredOptions[0].textContent).toContain('/api/webhook/volume-confirmation');

			// Reset filter
			filterInput.value = '';
			await filterInput.dispatch('input');
			const allOptions = findAll(select, (node) => node.tagName === 'OPTION');
			expect(allOptions.length).toBeGreaterThan(10);
		});

		it('preserves user input across operation switches within the session', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
			});
			await flush();
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');

			// Select POST /api/webhook/alert and enter custom body
			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('POST /api/webhook/alert')).value;
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ message: 'Custom alert message 42' });
			await playground.elements.body.dispatch('input');

			// Switch to GET /api/alerts
			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('GET /api/alerts —')).value;
			await select.dispatch('change');
			expect(playground.elements.body).toBeUndefined();

			// Switch back to POST /api/webhook/alert
			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('POST /api/webhook/alert')).value;
			await select.dispatch('change');
			expect(playground.elements.body.value).toContain('Custom alert message 42');
		});

		it('preserves operation input when filtering auto-selects another operation', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
			});
			await flush();
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');
			const optionValue = (route) => find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes(route)).value;
			const alertOperation = optionValue('POST /api/webhook/alert');
			const volumeOperation = optionValue('POST /api/webhook/volume-confirmation');

			select.value = alertOperation;
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ message: 'Original alert payload' });

			const filter = playground.elements.filterOperations;
			filter.value = 'volume-confirmation';
			await filter.dispatch('input');
			expect(select.value).toBe(volumeOperation);
			playground.elements.body.value = JSON.stringify({ symbol: 'BINANCE:BTCUSDT', timeframe: '1h' });

			filter.value = '';
			await filter.dispatch('input');
			select.value = alertOperation;
			await select.dispatch('change');
			expect(playground.elements.body.value).toContain('Original alert payload');

			select.value = volumeOperation;
			await select.dispatch('change');
			expect(playground.elements.body.value).toContain('BINANCE:BTCUSDT');
		});

		it('does not let an empty filter result erase previously cached operation inputs', async () => {
			const dispatched = [];
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					dispatched.push(url);
					return response({});
				},
			});
			await flush();
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');
			const submitButton = find(playground, (node) => node.tagName === 'BUTTON' && node.textContent === 'Send request');
			const curlButton = find(playground, (node) => node.tagName === 'BUTTON' && node.textContent.includes('cURL'));
			const optionValue = (route) => find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes(route)).value;
			const alertOperation = optionValue('POST /api/webhook/alert');
			const volumeOperation = optionValue('POST /api/webhook/volume-confirmation');

			select.value = alertOperation;
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ message: 'Alert draft that must survive' });
			await playground.elements.body.dispatch('input');

			select.value = volumeOperation;
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ symbol: 'BINANCE:BTCUSDT', timeframe: '4h' });
			await playground.elements.body.dispatch('input');

			select.value = alertOperation;
			await select.dispatch('change');

			const filter = playground.elements.filterOperations;

			// A blank `select.value` must mean "no operation selected", never index 0:
			// `Number('') === 0`, so an unguarded lookup silently resolves to the first
			// definition and leaves the dispatch controls armed against a route the
			// operator never picked.
			filter.value = 'zzz-no-operation-matches';
			await filter.dispatch('input');
			expect(select.value).toBe('');
			expect(playground.elements.body).toBeUndefined();
			expect(playground.elements.query).toBeUndefined();
			expect(playground.elements['path-alertId']).toBeUndefined();
			expect(submitButton.disabled).toBe(true);
			expect(curlButton.disabled).toBe(true);

			await playground.dispatch('submit');
			await flush();
			expect(dispatched).toEqual([]);

			filter.value = 'volume-confirmation';
			await filter.dispatch('input');
			expect(select.value).toBe(volumeOperation);
			expect(playground.elements.body.value).toContain('BINANCE:BTCUSDT');

			select.value = alertOperation;
			await select.dispatch('change');
			expect(playground.elements.body.value).toContain('Alert draft that must survive');

			select.value = volumeOperation;
			await select.dispatch('change');
			expect(playground.elements.body.value).toContain('BINANCE:BTCUSDT');
		});

		it('keeps the Playground submit locked across an operation switch while a request is pending', async () => {
			let pendingResolver;
			const dispatched = [];
			const browser = createBrowser({
				fetchImpl: (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.includes('/api/webhook/alert')) {
						dispatched.push(url);
						return new Promise((resolve) => { pendingResolver = resolve; });
					}
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');
			const submitButton = find(playground, (node) => node.tagName === 'BUTTON' && node.textContent === 'Send request');
			const optionValue = (route) => find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes(route)).value;

			select.value = optionValue('POST /api/webhook/alert');
			await select.dispatch('change');
			await playground.dispatch('submit');
			await flush();

			expect(dispatched.length).toBe(1);
			expect(submitButton.disabled).toBe(true);

			// Switching operations re-renders the fields while the first request is still in flight.
			select.value = optionValue('POST /api/webhook/volume-confirmation');
			await select.dispatch('change');
			await flush();
			expect(submitButton.disabled).toBe(true);

			// A second dispatch attempt must not reach the network while the first is pending.
			await playground.dispatch('submit');
			await flush();
			expect(dispatched.length).toBe(1);

			pendingResolver(response({ success: true, messageId: '12345' }));
			await flush();

			expect(dispatched.length).toBe(1);
			expect(submitButton.disabled).toBe(false);
		});

		it('keeps the Playground submit locked when filtering auto-selects another operation during a pending request', async () => {
			let pendingResolver;
			const dispatched = [];
			const browser = createBrowser({
				fetchImpl: (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.includes('/api/webhook/alert')) {
						dispatched.push(url);
						return new Promise((resolve) => { pendingResolver = resolve; });
					}
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');
			const submitButton = find(playground, (node) => node.tagName === 'BUTTON' && node.textContent === 'Send request');
			const optionValue = (route) => find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes(route)).value;

			select.value = optionValue('POST /api/webhook/alert');
			await select.dispatch('change');
			await playground.dispatch('submit');
			await flush();
			expect(dispatched.length).toBe(1);

			// Filter-driven selection re-renders through populateOptions() rather than the select.
			const filter = playground.elements.filterOperations;
			filter.value = 'volume-confirmation';
			await filter.dispatch('input');
			await flush();

			expect(select.value).toBe(optionValue('POST /api/webhook/volume-confirmation'));
			expect(submitButton.disabled).toBe(true);

			await playground.dispatch('submit');
			await flush();
			expect(dispatched.length).toBe(1);

			pendingResolver(response({ success: true, messageId: '12345' }));
			await flush();

			expect(dispatched.length).toBe(1);
			expect(submitButton.disabled).toBe(false);
		});

		it('renders structured results and provides collapsible raw JSON toggle', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.includes('/api/webhook/volume-confirmation')) {
						return response({
							success: true,
							symbol: 'BINANCE:BTCUSDT',
							timeframe: '1h',
							confirmed: true,
							volumeRatio: 2.15,
							currentVolume: 12000,
							smaVolume: 5580,
						});
					}
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');

			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('POST /api/webhook/volume-confirmation')).value;
			await select.dispatch('change');
			await playground.dispatch('submit');
			await flush();

			// Structured result host should contain the volume confirmation verdict
			const structuredResult = find(playground, (n) => n.className === 'playground-structured-result');
			expect(structuredResult.textContent).toContain('Confirmed');
			expect(structuredResult.textContent).toContain('2.15x');

			// Raw toggle should be visible with copy button and formatted JSON
			const rawToggle = find(playground, (n) => n.tagName === 'DETAILS' && n.className === 'raw-status');
			expect(rawToggle.hidden).toBe(false);
			expect(rawToggle.textContent).toContain('Response details');
			expect(rawToggle.textContent).toContain('2.15');
		});

		it('records request history with redacted credentials and allows restoration', async () => {
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.includes('/api/webhook/alert')) {
						return response({ success: true, messageId: 'm-101' });
					}
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');

			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('POST /api/webhook/alert')).value;
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ message: 'Buy BTC', apiKey: 'super-secret-key-999' });
			await playground.dispatch('submit');
			await flush();

			const historyItems = findAll(playground, (n) => n.className === 'history-item');
			expect(historyItems.length).toBe(1);
			expect(historyItems[0].textContent).toContain('POST');
			expect(historyItems[0].textContent).toContain('/api/webhook/alert');
			expect(historyItems[0].textContent).toContain('HTTP 200');

			// Verify secrets are redacted in history
			expect(playground.textContent).not.toContain('super-secret-key-999');

			// Change the current form to another operation
			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('GET /api/alerts —')).value;
			await select.dispatch('change');
			expect(playground.elements.body).toBeUndefined();

			// Restore from history
			const restoreBtn = find(historyItems[0], (n) => n.tagName === 'BUTTON' && n.textContent === 'Restore');
			await restoreBtn.dispatch('click');
			await flush();

			// Form should be back to POST /api/webhook/alert with restored body
			const currentSelected = find(select, (o) => o.value === select.value);
			expect(currentSelected.textContent).toContain('POST /api/webhook/alert');
			expect(playground.elements.body).toBeDefined();
			expect(playground.elements.body.value).toContain('Buy BTC');
			expect(playground.elements.body.value).toContain('[REDACTED]');
		});

		it('records the submitted query payload when operations change mid-flight', async () => {
			let releaseRequest;
			const pendingRequest = new Promise((resolve) => { releaseRequest = resolve; });
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.includes('/api/selftest/run')) {
						await pendingRequest;
						return response({ success: true, results: [] });
					}
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');
			const optionValue = (route) => find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes(route)).value;

			select.value = optionValue('POST /api/selftest/run');
			await select.dispatch('change');
			playground.elements.query.value = JSON.stringify({ only: 'submitted-check-1162' });
			playground.elements.body.value = JSON.stringify({ only: 'submitted-body-1162' });

			await playground.dispatch('submit');
			await flush();

			// The response is still in flight: switch operation and type a different query.
			select.value = optionValue('GET /api/alerts —');
			await select.dispatch('change');
			playground.elements.query.value = JSON.stringify({ limit: 5 });
			await playground.dispatch('input');

			releaseRequest();
			await flush();
			await flush();

			const historyItems = findAll(playground, (n) => n.className === 'history-item');
			expect(historyItems.length).toBe(1);

			const restoreBtn = find(historyItems[0], (n) => n.tagName === 'BUTTON' && n.textContent === 'Restore');
			await restoreBtn.dispatch('click');
			await flush();

			const currentSelected = find(select, (o) => o.value === select.value);
			expect(currentSelected.textContent).toContain('POST /api/selftest/run');
			expect(playground.elements.query.value).toContain('submitted-check-1162');
			expect(playground.elements.query.value).not.toContain('"limit"');
			expect(playground.elements.body.value).toContain('submitted-body-1162');
		});

		it('records the submitted body payload when operations change mid-flight', async () => {
			let releaseRequest;
			const pendingRequest = new Promise((resolve) => { releaseRequest = resolve; });
			const browser = createBrowser({
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url.includes('/api/webhook/alert')) {
						await pendingRequest;
						return response({ success: true, messageId: 'm-1162' });
					}
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await selectView(browser, 'playground');
			await flush();

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');
			const optionValue = (route) => find(select, (option) => option.tagName === 'OPTION' && option.textContent.includes(route)).value;

			select.value = optionValue('POST /api/webhook/alert');
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ text: 'submitted alert 1162' });

			await playground.dispatch('submit');
			await flush();

			// The response is still in flight: switch operation and type a different body.
			select.value = optionValue('POST /api/jobs/tradingview-analysis');
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ symbols: ['BINANCE:BTCUSDT'] });
			await playground.dispatch('input');

			releaseRequest();
			await flush();
			await flush();

			const historyItems = findAll(playground, (n) => n.className === 'history-item');
			expect(historyItems.length).toBe(1);

			const restoreBtn = find(historyItems[0], (n) => n.tagName === 'BUTTON' && n.textContent === 'Restore');
			await restoreBtn.dispatch('click');
			await flush();

			const currentSelected = find(select, (o) => o.value === select.value);
			expect(currentSelected.textContent).toContain('POST /api/webhook/alert');
			expect(playground.elements.body.value).toContain('submitted alert 1162');
			expect(playground.elements.body.value).not.toContain('BINANCE:BTCUSDT');
		});

		it('generates a curl command with literal $WEBHOOK_API_KEY placeholder and never leaks actual key', async () => {
			let capturedTextarea = null;
			const browser = createBrowser({
				fetchImpl: async (url) => response(url === '/openapi.json' ? contract : {}),
			});
			await flush();
			browser.elementsById['api-key'].value = 'actual-production-secret-key-12345';
			await selectView(browser, 'playground');
			await flush();

			// Intercept textarea creation for execCommand copy
			const origCreateElement = browser.context.document.createElement;
			browser.context.document.createElement = (tag) => {
				const el = origCreateElement(tag);
				if (tag === 'textarea') capturedTextarea = el;
				return el;
			};
			browser.context.document.execCommand = () => true;

			const playground = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
				&& node.textContent.includes('Operations'));
			const select = find(playground, (node) => node.tagName === 'SELECT');

			select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes('POST /api/webhook/alert')).value;
			await select.dispatch('change');
			playground.elements.body.value = JSON.stringify({ message: 'Hello cURL' });

			const curlBtn = find(playground, (n) => n.tagName === 'BUTTON' && n.textContent.includes('Copy as cURL'));
			expect(curlBtn).toBeDefined();

			await curlBtn.dispatch('click');
			await flush();

			expect(capturedTextarea).not.toBeNull();
			const curlCommand = capturedTextarea.value;
			expect(curlCommand).toContain('curl -X POST');
			expect(curlCommand).toContain('/api/webhook/alert');
			expect(curlCommand).toContain('-H "x-api-key: $WEBHOOK_API_KEY"');
			expect(curlCommand).toContain('-H "Content-Type: application/json"');
			expect(curlCommand).toContain('Hello cURL');
			// Crucial security check: the actual API key MUST NOT appear anywhere in the curl output
			expect(curlCommand).not.toContain('actual-production-secret-key-12345');
		});

		describe('request history records the actual outcome', () => {
			const openPlayground = async (options) => {
				const browser = createBrowser({
					fetchImpl: async (url) => {
						if (url === '/openapi.json') return response(contract);
						return response({});
					},
					...options,
				});
				await flush();
				browser.elementsById['api-key'].value = 'test-key';
				await selectView(browser, 'playground');
				await flush();
				const form = find(browser.elementsById.view, (node) => node.tagName === 'FORM'
					&& node.textContent.includes('Operations'));
				const select = find(form, (node) => node.tagName === 'SELECT');
				const choose = async (route) => {
					select.value = find(select, (o) => o.tagName === 'OPTION' && o.textContent.includes(route)).value;
					await select.dispatch('change');
				};
				return { browser, form, select, choose };
			};

			const badgeOf = (historyItem) => find(historyItem, (node) => typeof node.className === 'string'
				&& node.className.startsWith('status-badge'));

			it('labels a network failure as a network error instead of 200 OK', async () => {
				const { form, choose } = await openPlayground({
					fetchImpl: async (url) => {
						if (url === '/openapi.json') return response(contract);
						throw new TypeError('Failed to fetch');
					},
				});
				await choose('POST /api/webhook/alert');
				form.elements.body.value = JSON.stringify({ text: 'network failure probe' });
				await form.dispatch('submit');
				await flush();

				const historyItems = findAll(form, (n) => n.className === 'history-item');
				expect(historyItems.length).toBe(1);
				const badge = badgeOf(historyItems[0]);
				expect(badge.textContent).toBe('Network error');
				expect(badge.textContent).not.toContain('200');
				expect(badge.className).toContain('status-danger');
			});

			it('distinguishes a client-side request timeout from a generic network error', async () => {
				const abortError = new Error('The operation was aborted');
				abortError.name = 'AbortError';
				const { form, choose } = await openPlayground({
					fetchImpl: async (url) => {
						if (url === '/openapi.json') return response(contract);
						throw abortError;
					},
				});
				await choose('POST /api/webhook/alert');
				form.elements.body.value = JSON.stringify({ text: 'timeout probe' });
				await form.dispatch('submit');
				await flush();

				const historyItems = findAll(form, (n) => n.className === 'history-item');
				expect(badgeOf(historyItems[0]).textContent).toBe('Timed out');
			});

			it('labels a declined confirmation as cancelled and never sends the request', async () => {
				const sent = [];
				const { form, choose } = await openPlayground({
					confirm: () => false,
					fetchImpl: async (url) => {
						if (url === '/openapi.json') return response(contract);
						sent.push(url);
						return response({ success: true });
					},
				});
				await choose('POST /api/alerts/{alertId}/replay');
				form.elements['path-alertId'].value = 'alert-1163';
				await form.dispatch('submit');
				await flush();

				expect(sent.some((url) => url.includes('/api/alerts/alert-1163/replay'))).toBe(false);
				const historyItems = findAll(form, (n) => n.className === 'history-item');
				expect(historyItems.length).toBe(1);
				const badge = badgeOf(historyItems[0]);
				expect(badge.textContent).toBe('Cancelled');
				expect(badge.className).toContain('status-danger');
			});

			it('labels an authorization refusal as not authorized and never sends the request', async () => {
				const sent = [];
				const auth = {
					onAuthStateChanged: (listener) => {
						listener({
							email: 'viewer@example.com',
							getIdToken: async () => 'viewer-token',
							getIdTokenResult: async () => ({ claims: { role: 'admin.viewer' } }),
						});
						return () => {};
					},
					setPersistence: async () => undefined,
					signInWithEmailAndPassword: jest.fn(),
					signOut: jest.fn(),
				};
				const { form, choose } = await openPlayground({
					firebase: { initializeApp: jest.fn(), auth: jest.fn(() => auth) },
					fetchImpl: async (url) => {
						if (url === '/admin/auth-config') {
							return response({
								enabled: true,
								configured: true,
								config: { apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros' },
							});
						}
						if (url === '/openapi.json') return response(contract);
						sent.push(url);
						return response({ success: true });
					},
				});
				await choose('POST /api/webhook/alert');
				form.elements.body.value = JSON.stringify({ text: 'viewer must not mutate' });
				await form.dispatch('submit');
				await flush();

				expect(sent.some((url) => url.includes('/api/webhook/alert'))).toBe(false);
				const historyItems = findAll(form, (n) => n.className === 'history-item');
				expect(historyItems.length).toBe(1);
				const badge = badgeOf(historyItems[0]);
				expect(badge.textContent).toBe('Not authorized');
				expect(badge.className).toContain('status-danger');
			});

			it('records a real 4xx response as its own HTTP status and a non-success tone', async () => {
				const { form, choose } = await openPlayground({
					fetchImpl: async (url) => {
						if (url === '/openapi.json') return response(contract);
						if (url.includes('/api/webhook/alert')) {
							return response({
								success: false,
								error: 'text is required',
								code: 'INVALID_REQUEST',
								requestId: 'req-1163',
								retryable: false,
							}, 400);
						}
						return response({});
					},
				});
				await choose('POST /api/webhook/alert');
				form.elements.body.value = JSON.stringify({});
				await form.dispatch('submit');
				await flush();

				const historyItems = findAll(form, (n) => n.className === 'history-item');
				expect(historyItems.length).toBe(1);
				const badge = badgeOf(historyItems[0]);
				expect(badge.textContent).toBe('HTTP 400');
				expect(badge.className).toContain('status-danger');
			});

			it('records a real 2xx response as an HTTP status and a success tone', async () => {
				const { form, choose } = await openPlayground({
					fetchImpl: async (url) => {
						if (url === '/openapi.json') return response(contract);
						if (url.includes('/api/webhook/alert')) return response({ success: true, messageId: 'm-1163' });
						return response({});
					},
				});
				await choose('POST /api/webhook/alert');
				form.elements.body.value = JSON.stringify({ text: 'successful delivery probe' });
				await form.dispatch('submit');
				await flush();

				const historyItems = findAll(form, (n) => n.className === 'history-item');
				expect(historyItems.length).toBe(1);
				const badge = badgeOf(historyItems[0]);
				expect(badge.textContent).toBe('HTTP 200');
				expect(badge.className).toContain('status-ready');
			});
		});
	});
	it('moves focus to the view region and updates the document title on every view switch', async () => {
		const browser = createBrowser({
			fetchImpl: async (url) => {
				if (url === '/openapi.json') return response(contract);
				return response({});
			},
		});
		await flush();
		browser.elementsById['api-key'].value = 'test-key';

		const view = browser.elementsById.view;
		// Initial load focuses the overview view region.
		expect(view._focused).toBe(true);
		expect(browser.titleHistory.at(-1)).toMatch(/Overview/);

		view._focused = false;
		await selectView(browser, 'status');
		expect(view._focused).toBe(true);
		expect(view.tabIndex).toBe(-1);
		expect(browser.titleHistory.at(-1)).toMatch(/Status/);

		view._focused = false;
		await selectView(browser, 'alerts');
		expect(view._focused).toBe(true);
		expect(browser.titleHistory.at(-1)).toMatch(/Alerts/);

		view._focused = false;
		await selectView(browser, 'overview');
		expect(view._focused).toBe(true);
		expect(browser.titleHistory.at(-1)).toMatch(/Overview/);
	});

	it('keeps the view region focusable for screen readers', () => {
		const shell = fs.readFileSync(path.join(__dirname, '../../src/admin/index.html'), 'utf8');
		expect(shell).toMatch(/<section id="view"[^>]*tabindex="-1"/);
	});

	it('does not announce the whole workspace as a live region', () => {
		const shell = fs.readFileSync(path.join(__dirname, '../../src/admin/index.html'), 'utf8');
		const viewTag = shell.match(/<section id="view"[^>]*>/)[0];
		expect(viewTag).not.toMatch(/aria-live/);
		expect(shell).toMatch(/id="view-status"[^>]*role="status"[^>]*aria-live="polite"/);
	});

	describe('deep-linkable views and filter state', () => {
		const editField = async (input, value) => {
			input.value = value;
			await input.dispatch('input');
			await flush();
		};

		const alertSummaryQuery = (browser, route = '/api/alerts/summary') => {
			const call = [...browser.helperCalls].reverse().find((input) => input.path === route);
			return call && call.query;
		};

		const alertFilterFields = (browser, route) => {
			const form = findForm(browser.elementsById.view, route);
			const field = (name) => find(form, (node) => node.name === name
				&& ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName));
			return {
				form,
				from: field('from'),
				to: field('to'),
				limit: field('limit'),
				source: field('source'),
				enriched: field('enriched'),
			};
		};

		const openApi = async (url) => {
			if (url.endsWith('/openapi.json')) return response(contract);
			if (url.startsWith('/api/alerts/summary')) return response({ success: true, summary: { totalAlerts: 1, window: {} } });
			return response({ enabled: false, configured: false });
		};

		it('writes the active view into the URL on navigation', async () => {
			const browser = createBrowser({ fetchImpl: openApi });
			await flush();

			await selectView(browser, 'alerts');

			const lastCall = browser.historyCalls.at(-1);
			expect(lastCall.mode).toBe('push');
			expect(lastCall.url).toContain('view=alerts');
			expect(browser.location.search).toContain('view=alerts');
			expect(browser.titleHistory.at(-1)).toMatch(/Alerts/);
		});

		it('round-trips alert filters through the query string', async () => {
			const browser = createBrowser({ fetchImpl: openApi });
			await flush();
			await selectView(browser, 'alerts');

			const fields = alertFilterFields(browser, '/api/alerts/summary');
			await editField(fields.from, '2026-08-01T00:00');
			await editField(fields.to, '2026-08-02T00:00');
			await editField(fields.limit, '42');
			await editField(fields.source, 'webhook');
			await editField(fields.enriched, 'true');
			await fields.form.dispatch('submit');
			await flush();

			const serialised = browser.location.search;
			expect(serialised).toContain('view=alerts');
			expect(serialised).toContain('alerts.summary.from=2026-08-01T00%3A00');
			expect(serialised).toContain('alerts.summary.limit=42');
			expect(serialised).toContain('alerts.summary.source=webhook');
			expect(serialised).toContain('alerts.summary.enriched=true');
			const originalQuery = alertSummaryQuery(browser);

			const restored = createBrowser({ fetchImpl: openApi, location: { search: serialised } });
			await flush();

			expect(find(browser.body, (node) => node.dataset.view === 'alerts').attributes['aria-current']).toBe('page');
			expect(browser.elementsById.view.textContent).toContain('Load alert analytics');

			const restoredFields = alertFilterFields(restored, '/api/alerts/summary');
			expect(restoredFields.from.value).toBe('2026-08-01T00:00');
			expect(restoredFields.to.value).toBe('2026-08-02T00:00');
			expect(restoredFields.limit.value).toBe('42');
			expect(restoredFields.source.value).toBe('webhook');
			expect(restoredFields.enriched.value).toBe('true');

			await restoredFields.form.dispatch('submit');
			await flush();
			expect(alertSummaryQuery(restored)).toEqual(originalQuery);
		});

		it('keeps the summary and export filter sets independent', async () => {
			const browser = createBrowser({ fetchImpl: openApi });
			await flush();
			await selectView(browser, 'alerts');

			const summary = alertFilterFields(browser, '/api/alerts/summary');
			await editField(summary.limit, '11');
			await summary.form.dispatch('submit');
			await flush();

			const exportFields = alertFilterFields(browser, '/api/alerts/export');
			expect(exportFields.limit.value).not.toBe('11');
			expect(browser.location.search).toContain('alerts.summary.limit=11');
			expect(browser.location.search).not.toContain('alerts.export.limit=11');
		});

		it('round-trips outcomes symbol and status filters', async () => {
			const browser = createBrowser({ fetchImpl: openApi });
			await flush();
			await selectView(browser, 'outcomes');

			const form = findForm(browser.elementsById.view, '/api/outcomes');
			const symbol = find(form, (node) => node.name === 'symbol');
			const status = find(form, (node) => node.name === 'status');
			await editField(symbol, 'BTCUSDT');
			await editField(status, 'evaluated');
			await form.dispatch('submit');
			await flush();

			const serialised = browser.location.search;
			expect(serialised).toContain('outcomes.list.symbol=BTCUSDT');
			expect(serialised).toContain('outcomes.list.status=evaluated');

			const restored = createBrowser({ fetchImpl: openApi, location: { search: serialised } });
			await flush();
			const restoredForm = findForm(restored.elementsById.view, '/api/outcomes');
			expect(find(restoredForm, (node) => node.name === 'symbol').value).toBe('BTCUSDT');
			expect(find(restoredForm, (node) => node.name === 'status').value).toBe('evaluated');
		});

		it('falls back to the overview view and rewrites an unknown view value', async () => {
			const browser = createBrowser({ fetchImpl: openApi, location: { search: '?view=does-not-exist' } });
			await flush();

			expect(browser.location.search).toBe('?view=overview');
			expect(browser.historyCalls.some((call) => call.mode === 'replace' && call.url.includes('view=overview'))).toBe(true);
			expect(browser.elementsById.view.textContent.length).toBeGreaterThan(0);
			expect(find(browser.body, (node) => node.dataset.view === 'overview').attributes['aria-current']).toBe('page');
			expect(browser.titleHistory.at(-1)).toMatch(/Overview/);
		});

		it('moves between views on Back and Forward without reloading', async () => {
			const browser = createBrowser({ fetchImpl: openApi });
			await flush();
			expect(browser.titleHistory.at(-1)).toMatch(/Overview/);

			await selectView(browser, 'alerts');
			const alertsUrl = browser.location.search;
			await selectView(browser, 'outcomes');
			expect(browser.titleHistory.at(-1)).toMatch(/Outcomes/);

			browser.location.search = alertsUrl;
			await browser.dispatchPopState();

			expect(browser.titleHistory.at(-1)).toMatch(/Alerts/);
			expect(browser.elementsById.view.textContent).toContain('Load alert analytics');
			expect(find(browser.body, (node) => node.dataset.view === 'alerts').attributes['aria-current']).toBe('page');
			expect(find(browser.body, (node) => node.dataset.view === 'outcomes').attributes['aria-current']).toBeUndefined();
			expect(browser.elementsById.view._focused).toBe(true);

			browser.location.search = '?view=outcomes';
			await browser.dispatchPopState();
			expect(browser.titleHistory.at(-1)).toMatch(/Outcomes/);
			expect(browser.elementsById.view.textContent).toContain('Load outcomes');
		});

		it('does not fire an API request before sign-in on a deep link', async () => {
			const requests = [];
			let authStateChanged;
			const user = {
				email: 'ops@example.com',
				getIdToken: jest.fn().mockResolvedValue('firebase-token'),
				getIdTokenResult: jest.fn().mockResolvedValue({ claims: { 'admin.operator': true } }),
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
			const firebase = { initializeApp: jest.fn(), auth: jest.fn(() => auth) };
			const browser = createBrowser({
				firebase,
				location: { search: '?view=alerts&alerts.summary.limit=7' },
				fetchImpl: async (url) => {
					requests.push(url);
					if (url === '/admin/auth-config') {
						return response({
							enabled: true,
							configured: true,
							config: { apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros' },
						});
					}
					if (url === '/openapi.json') return response(contract);
					return response({});
				},
			});
			await flush();

			expect(requests.filter((url) => url !== '/admin/auth-config')).toEqual([]);
			expect(browser.elementsById.view.textContent).toContain('Sign in required.');
			expect(browser.elementsById['auth-form'].hidden).toBe(false);
			expect(browser.titleHistory).not.toContain('Alerts · Cabros Bot Console');

			browser.elementsById['auth-email'].value = 'ops@example.com';
			browser.elementsById['auth-password'].value = 'password';
			await browser.elementsById['auth-form'].dispatch('submit');
			await flush();

			expect(requests).toContain('/openapi.json');
			expect(browser.titleHistory.at(-1)).toMatch(/Alerts/);
			expect(browser.elementsById.view.textContent).toContain('Load alert analytics');
			expect(alertFilterFields(browser, '/api/alerts/summary').limit.value).toBe('7');
		});

		it('keeps the backend origin allowlist intact alongside deep-link state', async () => {
			const requests = [];
			const browser = createBrowser({
				location: {
					hostname: 'cabros-bot.web.app',
					search: '?backend=https%3A%2F%2Fattacker.example&view=alerts',
				},
				fetchImpl: async (url) => {
					requests.push(url);
					if (url.endsWith('/openapi.json')) return response(contract);
					return response({ enabled: false, configured: false });
				},
			});
			await flush();

			expect(requests.some((url) => url.includes('attacker.example'))).toBe(false);
			expect(requests[0]).toBe('https://openclaw.tail5e4271.ts.net/admin/auth-config');
			expect(browser.titleHistory.at(-1)).toMatch(/Alerts/);
			expect(browser.location.search).toContain('view=alerts');

			await selectView(browser, 'outcomes');
			expect(browser.location.search).toContain('backend=https%3A%2F%2Fattacker.example');
		});

		it('keeps an allowlisted backend origin while navigating views', async () => {
			const requests = [];
			const browser = createBrowser({
				location: {
					hostname: 'cabros-bot.web.app',
					search: '?backend=https%3A%2F%2Fcabros-bot-production.up.railway.app&view=alerts',
				},
				fetchImpl: async (url) => {
					requests.push(url);
					if (url.endsWith('/openapi.json')) return response(contract);
					return response({ enabled: false, configured: false });
				},
			});
			await flush();
			await selectView(browser, 'outcomes');

			expect(requests.some((url) => url.startsWith('https://cabros-bot-production.up.railway.app/'))).toBe(true);
			expect(browser.location.search).toContain('backend=https%3A%2F%2Fcabros-bot-production.up.railway.app');
			expect(browser.location.search).toContain('view=outcomes');
		});
	});

	describe('trading dashboard', () => {
		const TRADING_WINDOWS_FOR_TEST = ['1h', '4h', '1D', '1W'];
		// Faithful to SignalOutcomeService.summarizeOutcomes(): the four per-window
		// averages live under windows[<window>], never at the top level. The
		// per-window values are deliberately distinct so the pooled "All windows"
		// figures (hit rate 59.00, return +1.30) differ both from any single window
		// (1D is 65.00 / +1.25) and from an unweighted mean of the four
		// percentages (63.75 / +1.44), so a wrong pooling weight cannot pass.
		const outcomeSummary = (overrides = {}) => ({
			success: true,
			summary: {
				available: true,
				totalSignalsReceived: 40,
				totalSignalsEligible: 36,
				totalSignalsEvaluated: 30,
				totalSignalsPending: 4,
				totalSignalsUnavailable: 2,
				coveragePercent: 75,
				isCoverageComplete: false,
				expectancyR: 0.42,
				targetHitRatePercent: 55,
				stopHitRatePercent: 21,
				populationNote: 'Metrics represent 30 evaluated signals out of 40 total received signals (75% coverage).',
				exchangeBreakdown: {},
				providerBreakdown: {},
				entryPriceSourceBreakdown: {},
				eligibilityBreakdown: {},
				windows: {
					'1h': { totalSignals: 40, hitRatePercent: 50, averageReturnPercent: 1.0, averageMfePercent: 2.0, averageMaePercent: -0.4 },
					'4h': { totalSignals: 30, hitRatePercent: 60, averageReturnPercent: 1.5, averageMfePercent: 2.4, averageMaePercent: -0.6 },
					'1D': { totalSignals: 20, hitRatePercent: 65, averageReturnPercent: 1.25, averageMfePercent: 2.6, averageMaePercent: -0.9 },
					'1W': { totalSignals: 10, hitRatePercent: 80, averageReturnPercent: 2.0, averageMfePercent: 3.0, averageMaePercent: -1.1 },
				},
				drawdownProxy: { averageMaxAdverseExcursionPercent: -0.63, absoluteMaxAdverseExcursionPercent: -1.1 },
				falsePositiveCandidatesCount: 0,
				falsePositiveCandidates: [],
				latencyCostMetadata: { averageProcessingTimeMs: 120, tokenUsage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } },
				...overrides,
			},
		});

		const statusPayload = (binance = {}) => ({
			success: true,
			service: { name: 'cabros-bot', environment: 'production' },
			featureFlags: { binanceTrading: true, signalOutcomeTracking: true },
			dependencies: {
				binanceTrading: {
					enabled: true,
					configured: true,
					ready: true,
					status: 'ready',
					environment: 'testnet',
					allowedSymbols: ['BTCUSDT'],
					maxNotionalConfigured: true,
					...binance,
				},
			},
		});

		const outcomeRecord = ({ id, symbol, setupType, receivedAt, win, source = 'webhook' }) => ({
			id,
			receivedAt,
			source,
			symbol,
			exchange: 'BINANCE',
			setupType,
			side: 'BUY',
			outcomeEvaluated: true,
			outcomes: { '1D': { status: 'evaluated', return: win, rMultiple: win / 2 } },
		});

		const outcomeList = (records) => ({
			success: true,
			outcomes: records,
			pagination: { hasMore: false, limit: 100, nextBefore: null },
		});

		const defaultOutcomes = [
			outcomeRecord({ id: 'o1', symbol: 'BTCUSDT', setupType: 'breakout', receivedAt: '2026-10-01T10:00:00.000Z', win: 3 }),
			outcomeRecord({ id: 'o2', symbol: 'BTCUSDT', setupType: 'breakout', receivedAt: '2026-10-01T18:00:00.000Z', win: -1 }),
			outcomeRecord({ id: 'o3', symbol: 'ETHUSDT', setupType: 'trend_continuation', receivedAt: '2026-10-02T09:00:00.000Z', win: 2 }),
		];

		// Stands in for the trade-ledger contract (#1275) so the panel's pending and populated
		// states can both be exercised without that API shipping first.
		const contractWithLedger = {
			...contract,
			paths: { ...contract.paths, '/api/trading/ledger/summary': { get: { operationId: 'getTradeLedger', responses: {} } } },
		};

		const createTradingBrowser = ({
			outcomes = defaultOutcomes,
			summary = outcomeSummary(),
			summaryStatus = 200,
			audit = { success: true, records: [], audit: [], pagination: { hasMore: false, limit: 20, nextBefore: null } },
			status = statusPayload(),
			ledger,
			firebase,
			authEnabled = false,
			contract: apiContract = contract,
		} = {}) => createBrowser({
			firebase,
			fetchImpl: async (url) => {
				if (url === '/admin/auth-config') {
					return response({
						enabled: authEnabled,
						configured: authEnabled,
						config: { apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros' },
					});
				}
				if (url === '/openapi.json') return response(apiContract);
				if (url.startsWith('/api/outcomes/summary')) {
					// Mirror the server instead of matching on startsWith: an empty
					// `?window=` is a 400 there (parseWindow('') is null), so a console
					// that forgets to filter the empty select option fails here.
					const sent = new URL(url, 'https://console.test').searchParams;
					if (sent.has('window') && sent.get('window') === '') {
						return response({ error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.', code: 'INVALID_REQUEST' }, 400);
					}
					return response(typeof summary === 'function' ? summary(url) : summary, summaryStatus);
				}
				if (url.startsWith('/api/outcomes')) return response(outcomeList(outcomes));
				if (url.startsWith('/api/trading/binance/orders/audit')) return response(audit);
				if (url.startsWith('/api/status')) return response(status);
				if (ledger) return ledger(url);
				return response({});
			},
		});

		const tradingView = (browser) => browser.elementsById.view;
		const kpiCards = (root) => findAll(root, (node) => node.className.includes('trading-kpi'));
		const hasClass = (node, name) => String(node.className || '').split(/\s+/).includes(name);
		const quickControlButtons = (root) => findAll(root, (node) => node.tagName === 'BUTTON' && hasClass(node, 'quick-control'));
		const kpiText = (root, label) => {
			const card = kpiCards(root).find((node) => node.textContent.includes(label));
			return card ? card.textContent : null;
		};

		it('keeps the summary fixture aligned with the published OutcomesSummary schema', () => {
			const declared = new Set(Object.keys(contract.components.schemas.OutcomesSummary.properties));
			const declaredWindow = new Set(Object.keys(contract.components.schemas.WindowStats.properties));
			const summary = outcomeSummary().summary;

			Object.keys(summary).forEach((key) => {
				expect(declared.has(key)).toBe(true);
			});
			Object.entries(summary.windows).forEach(([windowKey, block]) => {
				expect(TRADING_WINDOWS_FOR_TEST).toContain(windowKey);
				Object.keys(block).forEach((key) => {
					expect(declaredWindow.has(key)).toBe(true);
				});
			});
			// The regression this guards: the console read four names the service
			// never returns, and only a fixture that invented them kept it green.
			expect(declared.has('winRatePercent')).toBe(false);
			expect(declared.has('averageReturnPercent')).toBe(false);
		});

		it('renders paper P&L KPIs from the window block, not names the API never returns', async () => {
			const browser = createTradingBrowser();
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			expect(kpiText(view, 'Signals recorded')).toContain('40');
			// Pooled across all four windows, weighted by each window's own
			// denominator. 63.75 is the unweighted mean of the same percentages.
			expect(kpiText(view, 'Hit rate')).toContain('59.00%');
			expect(kpiText(view, 'Average return')).toContain('+1.30%');
			expect(kpiText(view, 'Expectancy')).toContain('+0.42R');
			expect(kpiText(view, 'Coverage')).toContain('75%');
			expect(kpiText(view, 'Hit rate')).not.toContain('63.75');
			expect(kpiText(view, 'MFE / MAE')).toContain('2.34% / -0.63%');
			expect(kpiCards(view).length).toBeGreaterThanOrEqual(6);
		});

		it('does not 400 its own request when the default All windows filter is selected', async () => {
			const requests = [];
			const browser = createTradingBrowser({
				summary: (url) => {
					requests.push(url);
					return outcomeSummary();
				},
			});
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			const summaryRequest = requests.find((url) => url.startsWith('/api/outcomes/summary'));
			expect(summaryRequest).toBeTruthy();
			expect(new URL(summaryRequest, 'https://console.test').searchParams.has('window')).toBe(false);
			expect(view.textContent).not.toMatch(/HTTP 400/);
			expect(view.textContent).not.toMatch(/invalid filter/i);
			expect(kpiText(view, 'Hit rate')).toContain('59.00%');
		});

		it('reads the selected window block when a window is chosen', async () => {
			const requests = [];
			const browser = createTradingBrowser({
				summary: (url) => {
					requests.push(url);
					return outcomeSummary();
				},
			});
			await flush();
			await selectView(browser, 'trading');
			const windowSelect = findAll(tradingView(browser), (node) => node.name === 'window')[0];
			windowSelect.value = '1D';
			await findAll(tradingView(browser), (node) => node.tagName === 'FORM')[0].dispatch('submit');
			await flush();

			const summaryRequest = requests.filter((url) => url.startsWith('/api/outcomes/summary')).pop();
			expect(new URL(summaryRequest, 'https://console.test').searchParams.get('window')).toBe('1D');
			const view = tradingView(browser);
			// 1D's own figures, not the pooled ones.
			expect(kpiText(view, 'Hit rate')).toContain('65.00%');
			expect(kpiText(view, 'Average return')).toContain('+1.25%');
			expect(kpiText(view, 'Hit rate')).not.toContain('59.00');
			expect(kpiText(view, 'MFE / MAE')).toContain('2.60% / -0.90%');
			expect(view.textContent).toContain('1D window');
		});

		it('blames the console request, not a feature flag, when the summary filter is rejected', async () => {
			const browser = createTradingBrowser({
				summary: { error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.', code: 'INVALID_REQUEST' },
				summaryStatus: 400,
			});
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			expect(view.textContent).toMatch(/invalid filter/i);
			expect(view.textContent).not.toMatch(/may be disabled/i);
			expect(view.textContent).not.toMatch(/ENABLE_SIGNAL_OUTCOME_TRACKING/);
		});

		it('treats a 503 summary as a dependency state rather than a disabled feature', async () => {
			const browser = createTradingBrowser({
				summary: { error: 'Storage unavailable', code: 'STORAGE_UNAVAILABLE' },
				summaryStatus: 503,
			});
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			expect(view.textContent).toMatch(/temporarily unavailable/i);
			expect(view.textContent).not.toMatch(/ENABLE_SIGNAL_OUTCOME_TRACKING/);
		});

		it('keeps the paper vs real panel with a named state when the summary fails', async () => {
			const browser = createTradingBrowser({
				summary: { error: 'Storage unavailable', code: 'STORAGE_UNAVAILABLE' },
				summaryStatus: 503,
			});
			await flush();
			await selectView(browser, 'trading');
			const compare = findAll(tradingView(browser), (node) => node.className.includes('paper-vs-real-panel'))[0];

			expect(compare).toBeTruthy();
			expect(compare.textContent).toMatch(/temporarily unavailable/i);
		});

		it('labels every KPI card with its environment provenance', async () => {
			const browser = createTradingBrowser();
			await flush();
			await selectView(browser, 'trading');
			const cards = kpiCards(tradingView(browser));

			expect(cards.length).toBeGreaterThan(0);
			const allowedProvenance = ['Paper · signals', 'Measured', 'Not measured', 'Environment: testnet'];
			cards.forEach((card) => {
				const badges = findAll(card, (node) => hasClass(node, 'trading-kpi-badge'));
				expect(badges).toHaveLength(1);
				expect(allowedProvenance).toContain(badges[0].textContent);
			});
			expect(tradingView(browser).textContent).toContain('Environment: testnet');
		});

		it('renders an empty state instead of an error when the trade ledger API is not available yet', async () => {
			const browser = createTradingBrowser({
				ledger: async () => response({ success: false, error: 'Trading ledger is disabled', code: 'FEATURE_DISABLED' }, 403),
			});
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			const panel = findAll(view, (node) => node.className.includes('real-pnl-panel'))[0];
			expect(panel).toBeTruthy();
			expect(panel.textContent).toMatch(/not available/i);
			expect(panel.textContent).toMatch(/trade ledger/i);
			expect(view.textContent).not.toContain('undefined');
			expect(view.textContent).not.toMatch(/NaN/);
		});

		it('never renders a fabricated zero for metrics the ledger does not provide yet', async () => {
			const browser = createTradingBrowser({
				ledger: async () => response({ success: false, error: 'Trading ledger is disabled', code: 'FEATURE_DISABLED' }, 403),
			});
			await flush();
			await selectView(browser, 'trading');
			const panel = findAll(tradingView(browser), (node) => node.className.includes('real-pnl-panel'))[0];

			['Realized P&L', 'Unrealized P&L', 'ROI', 'Profit factor', 'Fees', 'Avg hold'].forEach((label) => {
				expect(panel.textContent).toContain(label);
				expect(panel.textContent).not.toMatch(new RegExp(`${label}[^—]*\\$?0(\\.0+)?\\b`));
			});
		});

		it('renders the unavailable state for a 503 without raising an error', async () => {
			const browser = createTradingBrowser({
				contract: contractWithLedger,
				ledger: async () => response({ success: false, error: 'Storage unavailable', code: 'STORAGE_UNAVAILABLE' }, 503),
			});
			await flush();
			await selectView(browser, 'trading');
			const panel = findAll(tradingView(browser), (node) => node.className.includes('real-pnl-panel'))[0];

			expect(panel.textContent).toMatch(/unavailable/i);
			expect(panel.className).not.toContain('response-error');
		});

		it('fills the real-money panel from a ledger response once the contract ships it', async () => {
			const browser = createTradingBrowser({
				contract: contractWithLedger,
				ledger: async () => response({
					success: true,
					realizedPnl: 412.55,
					unrealizedPnl: -18.2,
					roiPercent: 7.4,
					profitFactor: 1.92,
					feesPaid: 9.81,
					averageHoldMinutes: 96,
					openExposure: 250,
				}),
			});
			await flush();
			await selectView(browser, 'trading');
			const panel = findAll(tradingView(browser), (node) => hasClass(node, 'real-pnl-panel'))[0];

			expect(panel.textContent).toContain('412.55');
			expect(panel.textContent).toContain('7.4');
			expect(panel.textContent).not.toMatch(/not deployed/);
		});

		it('gives every chart an accessible text alternative and a data table', async () => {
			const browser = createTradingBrowser();
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);
			const charts = findAll(view, (node) => node.tagName === 'SVG' && node.attributes.role === 'img');

			expect(charts.length).toBeGreaterThanOrEqual(2);
			charts.forEach((chart) => expect(chart.attributes['aria-label']).toBeTruthy());
			expect(findAll(view, (node) => node.tagName === 'TABLE').length).toBeGreaterThanOrEqual(2);
		});

		it('plots real values on the curve instead of an empty axis', async () => {
			const browser = createTradingBrowser();
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			// A non-finite accumulator reaches the chart kit as null and renders an empty
			// plot, which still satisfies an aria-label assertion. The painted polyline is
			// the only proof the cumulative series actually carries values.
			const labels = findAll(view, (node) => node.tagName === 'SVG' && node.attributes.role === 'img')
				.map((chart) => chart.attributes['aria-label']);
			expect(labels.some((label) => label.includes('no plottable values'))).toBe(false);
			expect(labels.some((label) => /high [+-]?\d/.test(label))).toBe(true);
			expect(findAll(view, (node) => node.tagName === 'POLYLINE').length).toBeGreaterThan(0);
			expect(view.textContent).not.toMatch(/NaN|Infinity/);
		});

		it('states plainly that the curve is signal returns rather than account equity', async () => {
			const browser = createTradingBrowser();
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			expect(view.textContent).toMatch(/not account equity/i);
			expect(view.textContent).toMatch(/paper/i);
		});

		it('groups attribution by symbol and by setup type', async () => {
			const browser = createTradingBrowser();
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);
			const bySymbol = findAll(view, (node) => node.className.includes('attribution-symbols'))[0];
			const bySetup = findAll(view, (node) => node.className.includes('attribution-setups'))[0];

			expect(bySymbol.textContent).toContain('BTCUSDT');
			expect(bySymbol.textContent).toContain('ETHUSDT');
			expect(bySetup.textContent).toContain('breakout');
			expect(bySetup.textContent).toContain('trend_continuation');
		});

		it('shows an empty state when no outcomes have been evaluated', async () => {
			const browser = createTradingBrowser({ outcomes: [] });
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			expect(view.textContent).toMatch(/no evaluated signals/i);
			expect(findAll(view, (node) => node.className === 'svg' && node.attributes.role === 'img').length).toBe(0);
		});

		it('hides every mutation control from an admin.viewer role', async () => {
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
			const browser = createTradingBrowser({
				firebase: { initializeApp: jest.fn(), auth: jest.fn(() => auth) },
				authEnabled: true,
			});
			await flush();
			browser.elementsById['auth-email'].value = 'viewer@example.com';
			browser.elementsById['auth-password'].value = 'secret';
			await browser.elementsById['auth-form'].dispatch('submit');
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			const controls = quickControlButtons(view);
			expect(controls.map((control) => control.textContent)).toEqual(['Load order audit']);
			expect(view.textContent).not.toMatch(/Pause news monitor|Resume news monitor|Run self-test|Send test alert|Retry job/);
		});

		it('exposes quick controls to an operator and keeps destructive confirmations', async () => {
			const browser = createTradingBrowser();
			await flush();
			await selectView(browser, 'trading');
			const view = tradingView(browser);

			const controls = quickControlButtons(view);
			expect(controls.length).toBe(5);
			const pause = findButton(view, 'Pause news monitor');
			const confirmations = [];
			browser.context.window.confirm = (message) => {
				confirmations.push(message);
				return false;
			};
			await pause.dispatch('click');
			await flush();
			expect(confirmations.some((message) => /pause/i.test(message))).toBe(true);
		});

		it('renders the recent order audit in the operations rail', async () => {
			const browser = createTradingBrowser({
				audit: {
					success: true,
					records: [{
						id: 'audit-1',
						orderId: 'local-1',
						action: 'submit',
						status: 'FILLED',
						symbol: 'BTCUSDT',
						side: 'BUY',
						environment: 'testnet',
						timestamp: '2026-10-01T10:00:00.000Z',
						operator: 'operator@example.com',
					}],
					audit: [],
					pagination: { hasMore: false, limit: 20, nextBefore: null },
				},
			});
			await flush();
			await selectView(browser, 'trading');
			const rail = findAll(tradingView(browser), (node) => node.className.includes('ops-rail'))[0];

			expect(rail.textContent).toContain('BTCUSDT');
			expect(rail.textContent).toContain('FILLED');
			expect(rail.textContent).toContain('testnet');
		});

		it('streams SSE events into the live feed and unsubscribes when the view is left', async () => {
			const stream = createControllableStream();
			const browser = createBrowser({
				storedKey: 'test-key',
				fetchImpl: async (url) => {
					if (url === '/openapi.json') return response(contract);
					if (url === '/api/admin/events') return stream.response();
					if (url.startsWith('/api/outcomes/summary')) return response(outcomeSummary());
					if (url.startsWith('/api/outcomes')) return response(outcomeList(defaultOutcomes));
					if (url.startsWith('/api/status')) return response(statusPayload());
					return response({});
				},
			});
			await flush();
			browser.elementsById['api-key'].value = 'test-key';
			await browser.elementsById['connection-form'].dispatch('submit');
			await flush();
			await selectView(browser, 'trading');
			// Exact match: an `includes('live-feed')` probe also matches the wrapping
			// `live-feed-panel` section, whose children are a heading plus the feed.
			const feed = findAll(tradingView(browser), (node) => node.className === 'live-feed')[0];

			expect(feed).toBeTruthy();
			expect(feed.textContent).toMatch(/no events yet/i);

			await stream.emit('alert-delivered', { symbol: 'BTCUSDT', channels: ['telegram'] });
			await flush();
			expect(feed.textContent).toContain('BTCUSDT');
			expect(feed.children.length).toBe(1);

			// MAX_ROWS is 40, so the trim is only reachable past that. The old
			// `feed.children.pop()` threw a TypeError in Chrome because an
			// HTMLCollection has no pop(); the array-backed fake DOM accepted it,
			// which is why this needed a real-browser check to find.
			for (let index = 0; index < 55; index += 1) {
				await stream.emit('alert-delivered', { symbol: `SYM${index}` });
			}
			await flush();
			expect(feed.children.length).toBe(40);
			expect(feed.textContent).toContain('SYM54');
			expect(feed.textContent).not.toContain('BTCUSDT');

			await selectView(browser, 'overview');
			await stream.emit('delivery-failure', { symbol: 'ETHUSDT', channel: 'whatsapp', error: 'boom' });
			await flush();
			expect(feed.children.length).toBe(40);
		});
	});

	describe('Diagnostics self-test view', () => {
		const selfTestResult = (overrides = {}) => ({
			status: 'fail',
			summary: { pass: 2, warn: 1, fail: 1, skipped: 1 },
			checks: [
				{ id: 'telegram.bot_info', status: 'pass', message: 'Bot @cabros_bot is up', durationMs: 12, evidence: { id: 4242 } },
				{ id: 'auth.api_key', status: 'pass', message: 'API key is configured', durationMs: 0 },
				{ id: 'gemini.grounding', status: 'warn', message: 'Grounding returned 0 sources', durationMs: 3100, evidence: { sources: [], attempts: 2 } },
				{ id: 'firestore.collections', status: 'fail', message: 'Firestore read failed: permission_denied', durationMs: 4980, evidence: { reason: 'permission_denied', retryable: false } },
				{ id: 'binance.trading', status: 'skipped', message: 'ENABLE_BINANCE_TRADING is not enabled', durationMs: 0 },
			],
			service: { name: 'cabros-crypto-bot', version: '1.2.3', commit: 'abc1234', uptimeSec: 90061, nodeVersion: 'v24.18.0' },
			startedAt: '2026-10-05T02:00:00.000Z',
			finishedAt: '2026-10-05T02:00:09.000Z',
			durationMs: 9000,
			requestId: 'selftest-request-1',
			cached: true,
			...overrides,
		});

		const diagnosticsBrowser = (fetchImpl, options = {}) => {
			const requests = [];
			const browser = createBrowser({
				storedKey: 'selftest-key',
				...options,
				fetchImpl: async (url, requestOptions) => {
					requests.push([url, requestOptions]);
					if (url.endsWith('/openapi.json')) return response(contract);
					return fetchImpl(url, requestOptions);
				},
			});
			return { browser, requests };
		};

		it('leads with the overall status badge and names service identity and timings', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult()));
			await flush();
			await selectView(browser, 'diagnostics');

			const view = browser.elementsById.view;
			const badges = findAll(view, (node) => node.className.includes('status-badge'));
			expect(badges[0].textContent).toBe('Fail');
			expect(badges[0].className).toContain('status-danger');
			expect(view.textContent).toContain('cabros-crypto-bot');
			expect(view.textContent).toContain('v24.18.0');
			expect(view.textContent).toContain('Started');
			expect(view.textContent).toContain('Finished');
			expect(view.textContent).toContain('9000 ms');
		});

		it('sorts failing and unknown checks before passing and skipped ones', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult({
				checks: [
					{ id: 'channels.enabled', status: 'pass', message: 'Telegram enabled', durationMs: 1 },
					{ id: 'service.metadata', status: 'skipped', message: 'No metadata', durationMs: 0 },
					{ id: 'telegram.bot_info', status: 'unknown', message: 'Bot handle not resolved', durationMs: 7 },
					{ id: 'auth.api_key', status: 'pass', message: 'API key configured', durationMs: 0 },
					{ id: 'gemini.grounding', status: 'fail', message: 'Grounding unreachable', durationMs: 5000 },
				],
			})));
			await flush();
			await selectView(browser, 'diagnostics');

			const renderedIds = findAll(browser.elementsById.view, (node) => node.className === 'mono-line')
				.map((node) => node.textContent);
			expect(renderedIds).toEqual([
				'gemini.grounding',
				'telegram.bot_info',
				'auth.api_key',
				'channels.enabled',
				'service.metadata',
			]);
		});

		it('renders nested evidence as a readable definition list', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult({
				status: 'warn',
				checks: [
					{
						id: 'telegram.env',
						status: 'pass',
						message: 'Bot is up',
						durationMs: 42,
						evidence: {
							chatId: -1001234,
							topicRoutes: { webhookSignal: 7, newsMonitor: 11 },
							allowedChatIds: ['-1001234', '-1009999'],
							nested: { deep: { value: true } },
						},
					},
				],
			})));
			await flush();
			await selectView(browser, 'diagnostics');

			const view = browser.elementsById.view;
			const evidenceList = find(view, (node) => node.tagName === 'DL' && node.className.includes('evidence-list'));
			expect(evidenceList).toBeDefined();
			expect(evidenceList.textContent).toContain('Chat Id');
			expect(evidenceList.textContent).toContain('-1001234');
			expect(evidenceList.textContent).toContain('Topic Routes');
			expect(evidenceList.textContent).toContain('Allowed Chat Ids');
			expect(evidenceList.textContent).toContain('Nested');
			expect(evidenceList.textContent).toContain('Value');
			expect(evidenceList.textContent).not.toContain('{"');
			expect(evidenceList.textContent).not.toContain('":');
		});

		it('says in words when the result is cached or expired', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult({ expired: true })));
			await flush();
			await selectView(browser, 'diagnostics');

			const notice = browser.elementsById.view.textContent;
			expect(notice).toContain('Cached result');
			expect(notice).toContain('no longer current');
			expect(notice).toContain('Run self-test');
		});

		it('says in words when the result is a fresh cached read', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult({ cached: true })));
			await flush();
			await selectView(browser, 'diagnostics');

			const notice = browser.elementsById.view.textContent;
			expect(notice).toContain('Cached result');
			expect(notice).not.toContain('no longer current');
		});

		it('confirms before running and shows the fresh result without a cached notice', async () => {
			const confirmations = [];
			const { browser, requests } = diagnosticsBrowser(async (url) => {
				if (url === '/api/selftest/run') return response(selfTestResult({ cached: false, status: 'pass' }));
				return response(selfTestResult());
			}, {
				confirm: (message) => {
					confirmations.push(message);
					return true;
				},
			});
			await flush();
			await selectView(browser, 'diagnostics');

			const runButton = findButton(browser.elementsById.view, 'Run self-test');
			expect(runButton).toBeDefined();
			expect(requests.some(([url]) => url === '/api/selftest/run')).toBe(false);

			await runButton.dispatch('click');
			await flush();

			expect(confirmations).toHaveLength(1);
			expect(confirmations[0]).toContain('outbound checks');
			expect(requests.at(-1)[0]).toBe('/api/selftest/run');
			expect(browser.elementsById.view.textContent).toContain('Pass');
			expect(browser.elementsById.view.textContent).not.toContain('Cached result');
			expect(runButton.disabled).toBe(false);
		});

		it('never dispatches the run when the operator declines the confirmation', async () => {
			const { browser, requests } = diagnosticsBrowser(async () => response(selfTestResult()), {
				confirm: () => false,
			});
			await flush();
			await selectView(browser, 'diagnostics');

			const runButton = findButton(browser.elementsById.view, 'Run self-test');
			await runButton.dispatch('click');
			await flush();

			expect(requests.some(([url]) => url === '/api/selftest/run')).toBe(false);
		});

		it('leaves the loaded report untouched when the operator declines the run confirmation', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult()), {
				confirm: () => false,
			});
			await flush();
			await selectView(browser, 'diagnostics');

			const view = browser.elementsById.view;
			expect(findAll(view, (node) => node.className === 'mono-line')).toHaveLength(5);

			await findButton(view, 'Run self-test').dispatch('click');
			await flush();

			// sendRequest resolves with undefined for an HTTP failure and for a declined
			// confirm alike. Collapsing the two replaced a five-check Fail verdict with an
			// "Unavailable" report while the sibling response block still read HTTP 200.
			expect(findAll(view, (node) => node.textContent === 'Unavailable')).toHaveLength(0);
			expect(findAll(view, (node) => node.className === 'mono-line')).toHaveLength(5);
			expect(view.textContent).toContain('Firestore read failed: permission_denied');
			expect(view.textContent).toContain('Self-test verdict');
			expect(view.textContent).not.toContain('Treat this as unknown, not as a pass');
			expect(findAll(view, (node) => node.className.includes('status-badge'))[0].textContent).toBe('Fail');
		});

		it('still repaints the report when the refresh is dispatched and then fails', async () => {
			let reads = 0;
			const { browser } = diagnosticsBrowser(async (url) => {
				if (url === '/api/selftest' && (reads += 1) > 1) throw new TypeError('Failed to fetch');
				return response(selfTestResult());
			});
			await flush();
			await selectView(browser, 'diagnostics');

			const view = browser.elementsById.view;
			expect(findAll(view, (node) => node.className === 'mono-line')).toHaveLength(5);

			await findButton(view, 'Refresh report').dispatch('click');
			await flush();

			// An attempted request that failed is new evidence about the endpoint, unlike a
			// declined dialog, so the report is allowed to change.
			expect(findAll(view, (node) => node.textContent === 'Unavailable')).toHaveLength(1);
			expect(findAll(view, (node) => node.className === 'mono-line')).toHaveLength(0);
		});

		it('locks the run button while the request is in flight', async () => {
			let releaseRun;
			const runPending = new Promise((resolve) => { releaseRun = resolve; });
			const { browser } = diagnosticsBrowser(async (url) => {
				if (url === '/api/selftest/run') {
					await runPending;
					return response(selfTestResult({ cached: false }));
				}
				return response(selfTestResult());
			}, { confirm: () => true });
			await flush();
			await selectView(browser, 'diagnostics');

			const runButton = findButton(browser.elementsById.view, 'Run self-test');
			await runButton.dispatch('click');
			expect(runButton.disabled).toBe(true);

			releaseRun();
			await flush();
			expect(runButton.disabled).toBe(false);
		});

		it('states plainly when no self-test has been run yet', async () => {
			const { browser } = diagnosticsBrowser(async () => response({
				status: 'unknown',
				message: 'No self-test has been run yet. POST /api/selftest/run to trigger one.',
				requestId: 'selftest-request-empty',
				cached: false,
			}));
			await flush();
			await selectView(browser, 'diagnostics');

			const view = browser.elementsById.view;
			expect(view.textContent).toContain('No self-test has been run yet');
			expect(view.textContent).toContain('Unknown');
			expect(findAll(view, (node) => node.className === 'mono-line')).toHaveLength(0);
		});

		it('states plainly when the self-test endpoint is unavailable', async () => {
			const { browser } = diagnosticsBrowser(async (url) => {
				if (url === '/api/selftest') {
					return response({ error: 'Self-test is not available in this deployment.', code: 'FEATURE_DISABLED', requestId: 'r-1' }, 503);
				}
				return response({});
			});
			await flush();
			await selectView(browser, 'diagnostics');

			const view = browser.elementsById.view;
			expect(view.textContent).toContain('Self-test is not available in this deployment.');
			expect(view.textContent).toContain('unavailable');
			expect(findAll(view, (node) => node.className === 'mono-line')).toHaveLength(0);
		});

		it('renders a degraded suite without pretending it passed', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult({
				status: 'warn',
				summary: { pass: 1, warn: 2, fail: 0, skipped: 1 },
				checks: [
					{ id: 'tradingview_mcp.endpoint', status: 'warn', message: 'MCP handshake slow', durationMs: 4800 },
					{ id: 'channels.enabled', status: 'warn', message: 'Admin Telegram delivery at 0%', durationMs: 2 },
					{ id: 'auth.api_key', status: 'pass', message: 'API key is configured', durationMs: 0 },
					{ id: 'binance.trading', status: 'skipped', message: 'ENABLE_BINANCE_TRADING is not enabled', durationMs: 0 },
				],
			})));
			await flush();
			await selectView(browser, 'diagnostics');

			const view = browser.elementsById.view;
			const badges = findAll(view, (node) => node.className.includes('status-badge'));
			expect(badges[0].textContent).toBe('Warning');
			expect(badges[0].className).toContain('status-active');
			expect(view.textContent).toContain('MCP handshake slow');
			expect(view.textContent).toContain('Admin Telegram delivery at 0%');
		});

		it('keeps the admin.viewer read and admin.operator run roles distinct', async () => {
			const dispatched = [];
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
			const browser = createBrowser({
				firebase: { initializeApp: jest.fn(), auth: jest.fn(() => auth) },
				confirm: () => true,
				fetchImpl: async (url) => {
					if (url === '/admin/auth-config') {
						return response({ enabled: true, configured: true, config: {
							apiKey: 'public-key', authDomain: 'cabros.firebaseapp.com', projectId: 'cabros',
						} });
					}
					if (url.endsWith('/openapi.json')) return response(contract);
					dispatched.push(url);
					return response(selfTestResult());
				},
			});
			await flush();
			browser.elementsById['auth-email'].value = 'viewer@example.com';
			browser.elementsById['auth-password'].value = 'password';
			await browser.elementsById['auth-form'].dispatch('submit');
			await flush();
			await selectView(browser, 'diagnostics');

			expect(dispatched).toContain('/api/selftest');

			const runButton = findButton(browser.elementsById.view, 'Run self-test');
			await runButton.dispatch('click');
			await flush();

			expect(dispatched).not.toContain('/api/selftest/run');
			expect(browser.elementsById.view.textContent).toContain('admin role cannot perform');
		});

		it('renders safely when the diagnostics module failed to load', async () => {
			const { browser } = diagnosticsBrowser(async () => response(selfTestResult()));
			delete browser.context.window.CabrosAdminDiagnostics;
			await flush();
			await selectView(browser, 'diagnostics');

			expect(browser.elementsById.view.textContent).toContain('Diagnostics module unavailable');
			expect(browser.titleHistory.at(-1)).toContain('Diagnostics');
		});
	});

});
