function registerDebugSentryRoute(app) {
	if (process.env.ENABLE_SENTRY_DEBUG_ROUTE !== 'true') {
		return;
	}

	app.get('/debug-sentry', function mainHandler() {
		throw new Error('Sentry debug test error!');
	});
}

module.exports = {
	registerDebugSentryRoute,
};
