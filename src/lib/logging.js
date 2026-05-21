'use strict';

/**
 * Lightweight global logging configuration.
 *
 * Goals:
 * - Provide DEBUG/INFO/WARN/ERROR levels.
 * - Allow filtering via LOG_LEVEL env var.
 * - Default to DEBUG in development, INFO in production.
 * - Emit one structured JSON object per log line.
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

const BASE_CONSOLE_METHODS = {
	debug: console.debug ? console.debug.bind(console) : console.log.bind(console),
	info: console.info ? console.info.bind(console) : console.log.bind(console),
	log: console.log.bind(console),
	warn: console.warn ? console.warn.bind(console) : console.error.bind(console),
	error: console.error.bind(console),
};

const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie|dsn)/i;

function resolveLogLevel() {
	const raw = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
	const key = String(raw).toLowerCase();
	if (Object.prototype.hasOwnProperty.call(LEVELS, key)) {
		return key;
	}
	return 'info';
}

function getServiceName() {
	return process.env.SERVICE_NAME || process.env.npm_package_name || 'cabros-bot';
}

function getEnvironmentName() {
	return process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';
}

function isPlainObject(value) {
	return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeValue(value, seen = new WeakSet()) {
	if (value instanceof Error) {
		return serializeError(value);
	}

	if (value === null || typeof value !== 'object') {
		return value;
	}

	if (seen.has(value)) {
		return '[Circular]';
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((item) => normalizeValue(item, seen));
	}

	if (isPlainObject(value)) {
		return Object.entries(value).reduce((acc, [key, nestedValue]) => {
			acc[key] = SENSITIVE_KEY_PATTERN.test(key)
				? '[REDACTED]'
				: normalizeValue(nestedValue, seen);
			return acc;
		}, {});
	}

	return String(value);
}

function serializeError(error) {
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
	};
}

function stringifyMessagePart(arg) {
	if (arg instanceof Error) {
		return arg.message;
	}
	if (typeof arg === 'string') {
		return arg;
	}
	if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
		return String(arg);
	}
	if (arg === null || arg === undefined) {
		return String(arg);
	}
	return undefined;
}

function buildLogEntry(level, args) {
	const attributes = {};
	const parameters = [];
	const messageParts = [];
	let error;

	args.forEach((arg, index) => {
		const messagePart = stringifyMessagePart(arg);
		if (messagePart !== undefined) {
			messageParts.push(messagePart);
			if (index > 0 && !(arg instanceof Error)) {
				parameters.push(normalizeValue(arg));
			}
		}

		if (arg instanceof Error) {
			error = error || serializeError(arg);
			return;
		}

		if (isPlainObject(arg)) {
			Object.assign(attributes, normalizeValue(arg));
		} else if (index > 0 && messagePart === undefined) {
			parameters.push(normalizeValue(arg));
		}
	});

	const entry = {
		timestamp: new Date().toISOString(),
		level,
		message: messageParts.join(' ') || 'Log event',
		service: getServiceName(),
		environment: getEnvironmentName(),
		pid: process.pid,
	};

	if (Object.keys(attributes).length > 0) {
		entry.attributes = attributes;
	}
	if (parameters.length > 0) {
		entry.parameters = parameters;
	}
	if (error) {
		entry.error = error;
	}

	return entry;
}

function toJsonLine(entry) {
	try {
		return JSON.stringify(entry);
	} catch (error) {
		return JSON.stringify({
			timestamp: new Date().toISOString(),
			level: 'error',
			message: 'Failed to serialize log entry',
			service: getServiceName(),
			environment: getEnvironmentName(),
			pid: process.pid,
			error: serializeError(error),
		});
	}
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
			originalFn(toJsonLine(buildLogEntry(level, args)));
		};
	}

	// Map console methods to levels.
	console.debug = wrap(originalDebug, 'debug');
	console.info = wrap(originalInfo, 'info');
	console.log = wrap(originalLog, 'info');
	console.warn = wrap(originalWarn, 'warn');
	console.error = wrap(originalError, 'error');

	console.info('Logging initialized', { logLevel: levelName });
}

function _resetLoggingForTests() {
	configured = false;
	console.debug = BASE_CONSOLE_METHODS.debug;
	console.info = BASE_CONSOLE_METHODS.info;
	console.log = BASE_CONSOLE_METHODS.log;
	console.warn = BASE_CONSOLE_METHODS.warn;
	console.error = BASE_CONSOLE_METHODS.error;
}

module.exports = {
	configureLogging,
	LEVELS,
	_resetLoggingForTests,
};
