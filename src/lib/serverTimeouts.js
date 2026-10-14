// Node enforces `headersTimeout` via a periodic connection checker that runs on
// `connectionsCheckingInterval` (default 30000ms). Without lowering that interval, a
// 10s `headersTimeout` is not enforced until the next 30s sweep, so a slow client can
// hold the socket open for ~3x the intended bound.
//
// The sweep is aligned to server start, not to each connection, so a connection that
// begins just after a sweep is first observed on the *next* sweep. The effective
// worst-case header deadline is therefore `headersTimeout + connectionsCheckingInterval`:
// with these values a slow-header client is rejected within 10-15s (measured: 10.9s,
// 12.9s, 15.0s depending on sweep phase), not 30s as it was with Node's default.
//
// Lowering the interval to 1s would tighten the bound to ~11s at the cost of waking
// the checker every second for the process lifetime; 5s is the chosen trade-off.
// A hard per-connection deadline would require a socket-level timer and is not
// worth that complexity for a slow-client DoS bound.
const SERVER_TIMEOUTS = {
	headersTimeout: 10_000,
	requestTimeout: 120_000,
	keepAliveTimeout: 30_000,
	connectionsCheckingInterval: 5_000,
};

/** Worst-case time a slow-header client can hold a socket, in milliseconds. */
const MAX_SLOW_HEADER_LIFETIME_MS =
	SERVER_TIMEOUTS.headersTimeout + SERVER_TIMEOUTS.connectionsCheckingInterval;

function configureServerTimeouts(server) {
	Object.assign(server, SERVER_TIMEOUTS);
}

module.exports = { configureServerTimeouts, SERVER_TIMEOUTS, MAX_SLOW_HEADER_LIFETIME_MS };
