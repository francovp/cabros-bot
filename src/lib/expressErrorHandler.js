function onError(err, req, res, next) {
	// The error id is attached to `res.sentry` to be returned
	// and optionally displayed to the user for support.
	res.statusCode = err.statusCode || err.status || 500;
	res.end(res.sentry + '\n');
}

module.exports = { onError };
