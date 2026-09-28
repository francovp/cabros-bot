const http = require('http');
const net = require('net');
const { configureServerTimeouts, SERVER_TIMEOUTS } = require('../../src/lib/serverTimeouts');

/**
 * Opens a socket that never finishes sending request headers and resolves with
 * the elapsed time until the server emits its own `clientError` for it.
 */
function measureSlowHeaderRejection(server, waitMs) {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const events = [];

		const onConnection = (socket) => {
			socket.on('error', () => {});
		};
		const onClientError = (error) => {
			events.push({ type: 'clientError', code: error.code, elapsedMs: Date.now() - startedAt });
		};

		server.on('connection', onConnection);
		server.on('clientError', onClientError);

		const socket = net.connect(server.address().port, '127.0.0.1');
		socket.on('error', () => {});
		// 'GET / HTTP/1.1\r\n' with no terminating CRLF: headers stay incomplete.
		socket.write('GET / HTTP/1.1\r\n');

		setTimeout(() => {
			server.off('connection', onConnection);
			server.off('clientError', onClientError);
			socket.destroy();
			resolve(events);
		}, waitMs);
	});
}

async function startServer() {
	const server = http.createServer((_req, res) => res.end('ok'));
	const listening = new Promise((resolve) => server.listen(0, resolve));
	configureServerTimeouts(server);
	await listening;
	return server;
}

async function stopServer(server) {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
}

describe('configureServerTimeouts', () => {
	it('sets bounded HTTP server timeouts', () => {
		const server = {};

		configureServerTimeouts(server);

		expect(server.headersTimeout).toBe(10_000);
		expect(server.requestTimeout).toBe(120_000);
		expect(server.keepAliveTimeout).toBe(30_000);
	});

	it('checks slow connections no later than the headers timeout', () => {
		// Node only enforces headersTimeout when connectionsCheckingInterval fires.
		// With Node's 30s default, a 10s headersTimeout is not honored until ~30s.
		expect(SERVER_TIMEOUTS.connectionsCheckingInterval).toBeLessThanOrEqual(
			SERVER_TIMEOUTS.headersTimeout,
		);
	});

	it('applies bounds to a real server before it starts listening', async () => {
		const server = http.createServer((_req, res) => res.end('ok'));

		// Same ordering index.js uses: listen() first, then configure the timeouts.
		const listening = new Promise((resolve) => server.listen(0, resolve));
		configureServerTimeouts(server);
		await listening;

		try {
			expect(server.listening).toBe(true);
			expect(server.headersTimeout).toBe(10_000);
			expect(server.requestTimeout).toBe(120_000);
			expect(server.keepAliveTimeout).toBe(30_000);
			expect(server.connectionsCheckingInterval).toBe(5_000);
		} finally {
			await stopServer(server);
		}
	});

	it('rejects a slow-header connection near 10s rather than Node default 30s', async () => {
		const server = await startServer();

		try {
			// 20s window: long enough to observe the 10s bound, short enough that
			// Node's default 30s checking interval would show up as "not rejected".
			const events = await measureSlowHeaderRejection(server, 20_000);

			expect(events).toHaveLength(1);
			expect(events[0].code).toBe('ERR_HTTP_REQUEST_TIMEOUT');
			expect(events[0].elapsedMs).toBeGreaterThanOrEqual(9_000);
			expect(events[0].elapsedMs).toBeLessThan(20_000);
		} finally {
			await stopServer(server);
		}
	}, 30_000);
});
