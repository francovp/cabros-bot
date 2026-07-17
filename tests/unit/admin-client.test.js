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

const response = (body, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
	text: async () => JSON.stringify(body),
});

function createBrowser({ fetchImpl, confirm = () => true, storedKey = '' }) {
	const body = new FakeElement('body');
	const elementsById = {};
	['api-key', 'key-state', 'save-key', 'clear-key', 'view'].forEach((id) => {
		const tag = id === 'api-key' ? 'input' : id === 'view' ? 'section' : id.endsWith('key') ? 'button' : 'p';
		const node = new FakeElement(tag);
		node.id = id;
		elementsById[id] = node;
		body.append(node);
	});
	['status', 'alerts', 'presets', 'jobs', 'analysis', 'playground'].forEach((view) => {
		const button = new FakeElement('button');
		button.dataset.view = view;
		body.append(button);
	});

	const documentListeners = {};
	const document = {
		body,
		createElement: (tag) => new FakeElement(tag),
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
		fetch: jest.fn(fetchImpl),
		performance: { now: jest.fn().mockReturnValueOnce(10).mockReturnValue(20) },
		sessionStorage: {
			getItem: (key) => storage.get(key) || null,
			setItem: (key, value) => storage.set(key, value),
			removeItem: (key) => storage.delete(key),
		},
		window: { CabrosAdminRequest: helper, confirm },
	};
	vm.runInNewContext(
		fs.readFileSync(path.join(__dirname, '../../src/admin/admin.js'), 'utf8'),
		context,
	);
	documentListeners.DOMContentLoaded();

	return { body, context, elementsById, helperCalls, storage };
}

async function selectView(browser, name) {
	await find(browser.body, (node) => node.dataset.view === name).dispatch('click');
	await flush();
}

describe('admin browser client', () => {
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
