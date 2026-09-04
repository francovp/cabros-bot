const SERVER_TIMEOUTS = {
	headersTimeout: 10_000,
	requestTimeout: 120_000,
	keepAliveTimeout: 30_000,
};

function configureServerTimeouts(server) {
	Object.assign(server, SERVER_TIMEOUTS);
}

module.exports = { configureServerTimeouts };
