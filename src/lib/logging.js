'use strict';

/**
 * Lightweight global logging configuration.
 *
 * Goals:
 * - Provide DEBUG/INFO/WARN/ERROR levels.
 * - Allow filtering via LOG_LEVEL env var.
 * - Default to DEBUG in development, INFO in production.
 * - Keep existing console.* call sites working without changes.
 */

const LEVELS = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
	silent: 50,
};

let configured = false;

function resolveLogLevel() {
	const raw = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
	const key = String(raw).toLowerCase();
	if (Object.prototype.hasOwnProperty.call(LEVELS, key)) {
		return key;
	}
	return 'info';
}

function configureLogging() {
	if (configured) {
		return;
	}
	configured = true;

	const levelName = resolveLogLevel();
	const currentLevel = LEVELS[levelName];

	const originalDebug = console.debug ? console.debug.bind(console) : console.log.bind(console);
	const originalInfo = console.info ? console.info.bind(console) : console.log.bind(console);
	const originalLog = console.log.bind(console);
	const originalWarn = console.warn ? console.warn.bind(console) : console.error.bind(console);
	const originalError = console.error.bind(console);

	function shouldLog(level) {
		return LEVELS[level] >= currentLevel;
	}

	function wrap(originalFn, level) {
		return (...args) => {
			if (!shouldLog(level)) return;
			originalFn(...args);
		};
	}

	// Map console methods to levels.
	console.debug = wrap(originalDebug, 'debug');
	console.info = wrap(originalInfo, 'info');
	console.log = wrap(originalLog, 'info');
	console.warn = wrap(originalWarn, 'warn');
	console.error = wrap(originalError, 'error');

	// Emit a single startup line at INFO level about logging configuration.
	if (shouldLog('info')) {
		originalInfo(`[Logging] Initialized with level=${levelName.toUpperCase()}`);
	}
}

module.exports = {
	configureLogging,
	LEVELS,
};
