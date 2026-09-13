'use strict';

const EventEmitter = require('events');
const { AdminSseService } = require('../../src/services/sse/AdminSseService');

class MockRequest extends EventEmitter {
	constructor(headers = {}) {
		super();
		this.headers = headers;
	}
}

class MockResponse extends EventEmitter {
	constructor() {
		super();
		this.statusCode = 200;
		this.headers = {};
		this.chunks = [];
		this.writableEnded = false;
	}

	writeHead(statusCode, headers = {}) {
		this.statusCode = statusCode;
		Object.entries(headers).forEach(([k, v]) => {
			this.headers[k.toLowerCase()] = v;
		});
		return this;
	}

	status(code) {
		this.statusCode = code;
		return this;
	}

	setHeader(name, value) {
		this.headers[name.toLowerCase()] = value;
		return this;
	}

	json(data) {
		this.body = data;
		this.writableEnded = true;
		return this;
	}

	write(chunk) {
		if (this.writableEnded) {
			throw new Error('Write after end');
		}
		this.chunks.push(chunk);
		return true;
	}

	end(chunk) {
		if (chunk) {
			this.chunks.push(chunk);
		}
		this.writableEnded = true;
		this.emit('finish');
		return this;
	}
}

describe('AdminSseService', () => {
	let sseService;

	beforeEach(() => {
		sseService = new AdminSseService();
	});

	afterEach(() => {
		sseService.closeAll();
	});

	it('initializes SSE client with appropriate headers and handshake events', () => {
		const req = new MockRequest();
		const res = new MockResponse();

		sseService.addClient(req, res, 'client-1');

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('text/event-stream');
		expect(res.headers['cache-control']).toBe('no-cache, no-transform');
		expect(res.headers['connection']).toBe('keep-alive');
		expect(res.headers['x-accel-buffering']).toBe('no');

		const fullOutput = res.chunks.join('');
		expect(fullOutput).toContain('retry: 5000\n\n');
		expect(fullOutput).toContain(':connected\n\n');
		expect(fullOutput).toContain('event: connected\n');
		expect(sseService.getClientCount()).toBe(1);
	});

	it('enforces client key connection limit by evicting oldest connection gracefully', () => {
		sseService.maxClientConnections = 3;

		const clients = [];
		for (let i = 0; i < 3; i++) {
			const req = new MockRequest();
			const res = new MockResponse();
			sseService.addClient(req, res, 'user:123');
			clients.push({ req, res });
		}

		expect(sseService.getClientCount()).toBe(3);

		// 4th connection for same user:123 evicts the 1st
		const req4 = new MockRequest();
		const res4 = new MockResponse();
		sseService.addClient(req4, res4, 'user:123');

		expect(sseService.getClientCount()).toBe(3);
		expect(clients[0].res.writableEnded).toBe(true);
		expect(clients[0].res.chunks.join('')).toContain(':closing superseded by new connection\n\n');
		expect(clients[1].res.writableEnded).toBe(false);
		expect(clients[2].res.writableEnded).toBe(false);
		expect(res4.writableEnded).toBe(false);
	});

	it('enforces global total connection limit by rejecting with 503', () => {
		sseService.maxTotalConnections = 2;

		const req1 = new MockRequest();
		const res1 = new MockResponse();
		sseService.addClient(req1, res1, 'user:1');

		const req2 = new MockRequest();
		const res2 = new MockResponse();
		sseService.addClient(req2, res2, 'user:2');

		expect(sseService.getClientCount()).toBe(2);

		const req3 = new MockRequest();
		const res3 = new MockResponse();
		const result = sseService.addClient(req3, res3, 'user:3');

		expect(result).toEqual({
			ok: false,
			status: 503,
			code: 'SSE_CONNECTION_LIMIT_EXCEEDED',
			message: 'Server has reached maximum SSE connection capacity. Please retry shortly.',
		});
		expect(sseService.getClientCount()).toBe(2);
	});

	it('cleans up client and decrements counter when request closes', () => {
		const req = new MockRequest();
		const res = new MockResponse();

		sseService.addClient(req, res, 'user:1');
		expect(sseService.getClientCount()).toBe(1);

		req.emit('close');
		expect(sseService.getClientCount()).toBe(0);
	});

	it('broadcasts formatted SSE event to all connected clients', () => {
		const req1 = new MockRequest();
		const res1 = new MockResponse();
		const req2 = new MockRequest();
		const res2 = new MockResponse();

		sseService.addClient(req1, res1, 'user:1');
		sseService.addClient(req2, res2, 'user:2');

		sseService.broadcast('job-progress', { jobId: 'job-123', status: 'completed' });

		const expectedSnippet = 'event: job-progress\ndata: {"jobId":"job-123","status":"completed"}\n\n';
		expect(res1.chunks.join('')).toContain(expectedSnippet);
		expect(res2.chunks.join('')).toContain(expectedSnippet);
	});

	it('fails open on broadcast write errors and removes broken client', () => {
		const req = new MockRequest();
		const res = new MockResponse();

		sseService.addClient(req, res, 'user:1');
		res.write = jest.fn(() => {
			throw new Error('Broken pipe');
		});

		expect(() => {
			sseService.broadcast('alert-delivered', { symbol: 'BTCUSDT' });
		}).not.toThrow();

		expect(sseService.getClientCount()).toBe(0);
	});

	it('sends heartbeat keepalive comments and stops on closeAll', () => {
		jest.useFakeTimers();
		try {
			const sseWithTimer = new AdminSseService();
			sseWithTimer.heartbeatIntervalMs = 1000;

			const req = new MockRequest();
			const res = new MockResponse();
			sseWithTimer.addClient(req, res, 'user:1');

			jest.advanceTimersByTime(1000);
			expect(res.chunks.join('')).toContain(':keepalive\n\n');

			sseWithTimer.closeAll();
			expect(res.writableEnded).toBe(true);
			expect(sseWithTimer.getClientCount()).toBe(0);
		} finally {
			jest.useRealTimers();
		}
	});

	it('gracefully shuts down all connections on closeAll', () => {
		const req1 = new MockRequest();
		const res1 = new MockResponse();
		const req2 = new MockRequest();
		const res2 = new MockResponse();

		sseService.addClient(req1, res1, 'user:1');
		sseService.addClient(req2, res2, 'user:2');

		sseService.closeAll();

		expect(res1.writableEnded).toBe(true);
		expect(res1.chunks.join('')).toContain(':closing server shutdown\n\n');
		expect(res2.writableEnded).toBe(true);
		expect(res2.chunks.join('')).toContain(':closing server shutdown\n\n');
		expect(sseService.getClientCount()).toBe(0);
	});

	it('dynamically reads RemoteConfig overrides when available', () => {
		const RemoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
		const originalGetRuntimeConfig = RemoteConfigService.getRuntimeConfig;

		try {
			RemoteConfigService.getRuntimeConfig = () => ({
				ADMIN_SSE_HEARTBEAT_MS: 15000,
				ADMIN_SSE_MAX_CLIENT_CONNECTIONS: 10,
				ADMIN_SSE_MAX_TOTAL_CONNECTIONS: 200,
			});

			const dynamicService = new AdminSseService();
			expect(dynamicService.getEffectiveHeartbeatIntervalMs()).toBe(15000);
			expect(dynamicService.getEffectiveMaxClientConnections()).toBe(10);
			expect(dynamicService.getEffectiveMaxTotalConnections()).toBe(200);
		} finally {
			RemoteConfigService.getRuntimeConfig = originalGetRuntimeConfig;
		}
	});
});
