const http = require('http');
const net = require('net');
const {
	configureServerTimeouts,
	SERVER_TIMEOUTS,
	MAX_SLOW_HEADER_LIFETIME_MS,
} = require('../../src/lib/serverTimeouts');

/**
 * Opens a socket that never finishes sending request headers and resolves as soon as
 * the server emits its own `clientError` for it, with the elapsed time. The timer is
 * only a failure deadline so a passing run finishes as soon as the event arrives
 * instead of always burning the full window.
 */
function measureSlowHeaderRejection(server, waitMs) {
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const onConnection = (socket) => socket.on('error', () => {});
		const onClientError = (error) => {
			cleanup();
			socket.destroy();
			resolve({ code: error.code, elapsedMs: Date.now() - startedAt });
		};
		const deadline = setTimeout(() => {
			cleanup();
			socket.destroy();
			// Null elapsedMs marks "no timeout observed within the window".
			resolve({ code: null, elapsedMs: null });
		}, waitMs);

		function cleanup() {
			clearTimeout(deadline);
			server.off('connection', onConnection);
			server.off('clientError', onClientError);
		}

		server.on('connection', onConnection);
		server.on('clientError', onClientError);

		const socket = net.connect(server.address().port, '127.0.0.1');
		socket.on('error', () => {});
		// 'GET / HTTP/1.1\r\n' with no terminating CRLF: headers stay incomplete.
		socket.write('GET / HTTP/1.1\r\n');
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

	it('checks slow connections more often than Node default', () => {
		// Node's default 30s interval means the checker would not even fire before a
		// 10s headersTimeout elapsed, so the bound would effectively be 30s.
		expect(SERVER_TIMEOUTS.connectionsCheckingInterval).toBeLessThan(30_000);
	});

	it('documents the worst-case slow-header lifetime as headersTimeout + check interval', () => {
		expect(MAX_SLOW_HEADER_LIFETIME_MS).toBe(
			SERVER_TIMEOUTS.headersTimeout + SERVER_TIMEOUTS.connectionsCheckingInterval,
		);
		// Well under Node's default 30s sweep, which is the bug this guards.
		expect(MAX_SLOW_HEADER_LIFETIME_MS).toBeLessThan(30_000);
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

	it('rejects a slow-header connection within the documented worst case', async () => {
		const server = await startServer();

		try {
			// The sweep is aligned to server start, so the worst phase is reached by
			// starting a connection partway into a sweep. 2.1s is one measured case
			// that previously took 12.9s - more than the nominal 10s.
			await new Promise((resolve) => setTimeout(resolve, 2_100));

			const observed = await measureSlowHeaderRejection(server, 25_000);

			expect(observed.code).toBe('ERR_HTTP_REQUEST_TIMEOUT');
			// Must fire at or before the documented worst case...
			expect(observed.elapsedMs).toBeLessThanOrEqual(
				MAX_SLOW_HEADER_LIFETIME_MS + 1_000,
			);
			// ...and the ceiling must be meaningfully below Node's 30s default,
			// so reverting the interval would fail this test.
			expect(observed.elapsedMs).toBeLessThan(20_000);
		} finally {
			await stopServer(server);
		}
	}, 35_000);
});
