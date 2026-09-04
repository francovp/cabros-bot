const { configureServerTimeouts } = require('../../src/lib/serverTimeouts');

describe('configureServerTimeouts', () => {
	it('sets bounded HTTP server timeouts', () => {
		const server = {};

		configureServerTimeouts(server);

		expect(server.headersTimeout).toBe(10_000);
		expect(server.requestTimeout).toBe(120_000);
		expect(server.keepAliveTimeout).toBe(30_000);
	});
});
