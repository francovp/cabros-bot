const { configureServerTimeouts } = require('../../src/lib/serverTimeouts');

describe('configureServerTimeouts', () => {
	it('sets bounded HTTP server timeouts', () => {
		const server = {};

		configureServerTimeouts(server);

		expect(server.headersTimeout).toBe(10_000);
		expect(server.requestTimeout).toBe(120_000);
		expect(server.keepAliveTimeout).toBe(30_000);
	});

	it('applies bounds to a real server before it starts listening', async () => {
		const http = require('http');
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
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
