// Node enforces `headersTimeout` via a periodic connection checker that runs on
// `connectionsCheckingInterval` (default 30000ms). Without lowering that interval,
// a 10s `headersTimeout` is still not enforced until the next 30s sweep, so a slow
// client can hold the socket open for up to 3x the documented bound.
// Keep the interval at or below `headersTimeout` so the bound is real.
const SERVER_TIMEOUTS = {
	headersTimeout: 10_000,
	requestTimeout: 120_000,
	keepAliveTimeout: 30_000,
	connectionsCheckingInterval: 5_000,
};

function configureServerTimeouts(server) {
	Object.assign(server, SERVER_TIMEOUTS);
}

module.exports = { configureServerTimeouts, SERVER_TIMEOUTS };
