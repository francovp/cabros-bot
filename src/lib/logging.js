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

const SENSITIVE_KEY_PATTERN = /(password|secret|token|api[-_]?key|authorization|cookie|dsn|discordWebhookUrl|webhookUrl)/i;
const CORRELATION_IDENTIFIER_KEY_PATTERN = /^(?:(?:original|parent)[_-]?)?(?:alert|job|replay)(?:[_-]?ids?)$/i;
const registeredSecrets = new Set();

function registerSecretValue(value) {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length >= 4) {
			registeredSecrets.add(trimmed);
		}
	}
}

function clearSecretValue(value) {
	if (typeof value === 'string') {
		registeredSecrets.delete(value.trim());
	}
}

function clearAllSecretValues() {
	registeredSecrets.clear();
}

function isSensitiveKeyLabel(str) {
	if (typeof str !== 'string') return false;
	const trimmed = str.trim();
	return /(?:password|secret|(?:(?:bot|auth|access)[-_]?)?token|api[-_]?key|(?:^|[\s._-])key|authorization|cookie|dsn|discordWebhookUrl|webhookUrl)\s*(?:is|[:=])?$/i.test(trimmed);
}

function isValidRequestId(value) {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= 128
		&& /^[\x21-\x7E]+$/.test(value);
}

function isUuid(value) {
	return typeof value === 'string'
		&& /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
}

function isCorrelationIdLabel(value) {
	return typeof value === 'string'
		&& /(?:^|[\s._-])(?:(?:original|parent)[_-]?)?(?:alert|job|replay)(?:[_-]?id)?s?\s*[:=]?\s*$/i.test(value.trim());
}

function calculateEntropy(value) {
	const frequencies = new Map();
	for (const character of value) {
		frequencies.set(character, (frequencies.get(character) || 0) + 1);
	}

	let entropy = 0;
	for (const count of frequencies.values()) {
		const probability = count / value.length;
		entropy -= probability * Math.log2(probability);
	}
	return entropy;
}

function isHighEntropyToken(value) {
	if (typeof value !== 'string' || value.length < 32) {
		return false;
	}

	if (!/^[A-Za-z0-9+/_=-]+$/.test(value)) {
		return false;
	}

	const isHexadecimal = /^[a-f0-9]+$/i.test(value);
	const minimumDistinctCharacters = isHexadecimal ? 12 : 16;
	if (new Set(value).size < minimumDistinctCharacters) {
		return false;
	}

	return calculateEntropy(value) >= 3.5;
}

function hasHighEntropyCredentialPathPrefix(pathTail) {
	const frequencies = new Map();
	let tokenLength = 0;
	let countLogSum = 0;
	let isHexadecimal = true;

	for (let index = 0; index < pathTail.length; index += 1) {
		let character = pathTail[index];
		if (character === '%') {
			const encodedSeparator = pathTail.slice(index, index + 3).toUpperCase();
			if (encodedSeparator === '%2F' || encodedSeparator === '%2E') {
				index += 2;
				continue;
			}
			if (encodedSeparator === '%2B') {
				character = '+';
				index += 2;
			} else if (encodedSeparator === '%3D') {
				character = '=';
				index += 2;
			} else {
				return false;
			}
		} else if (character === '/' || character === '.') {
			continue;
		}

		if (!/[A-Za-z0-9+/_=-]/.test(character)) return false;

		const previousCount = frequencies.get(character) || 0;
		if (previousCount > 0) {
			countLogSum -= previousCount * Math.log2(previousCount);
		}
		const nextCount = previousCount + 1;
		countLogSum += nextCount * Math.log2(nextCount);
		frequencies.set(character, nextCount);
		tokenLength += 1;
		isHexadecimal = isHexadecimal && /^[a-f0-9]$/i.test(character);

		const minimumDistinctCharacters = isHexadecimal ? 12 : 16;
		if (tokenLength >= 32
			&& frequencies.size >= minimumDistinctCharacters
			&& Math.log2(tokenLength) - (countLogSum / tokenLength) >= 3.5) {
			return true;
		}
	}

	return false;
}

function isHighEntropyPathSegment(value) {
	return typeof value === 'string'
		&& value.length >= 12
		&& new Set(value).size >= 12
		&& calculateEntropy(value) >= 3.5;
}

function redactSensitiveCredentialPathTokens(text) {
	return text.replace(
		/(\/api\/|\/)(session|auth|token|secret|credential|reset|login|oauth)\/((?:%2[EF]|%2B|%3D|[A-Za-z0-9+/_=.-])+)/gi,
		(_match, apiPrefix, route, pathTail) => {
			if (hasHighEntropyCredentialPathPrefix(pathTail)) return `${apiPrefix}${route}/[REDACTED]`;
			return `${apiPrefix}${route}/${pathTail}`;
		},
	);
}

function isConfigurationVariableLabel(value, offset, source) {
	if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(value)) return false;

	const prefix = source.slice(0, offset);
	const suffix = source.slice(offset + value.length);
	return /(?:^|\b)configuration warning:\s*$/i.test(prefix)
		|| (/\binvalid\s+$/i.test(prefix) && /^\s+configuration\b/i.test(suffix));
}

function getCorrelationApiId(pathname) {
	const match = /^\/api\/(alerts|jobs)\/([^/?#]+)(?:\/([^/?#]+))?\/?(?=[?#]|$)/i.exec(pathname);
	if (!match) return null;

	const collection = match[1].toLowerCase();
	const action = match[3]?.toLowerCase();
	if (collection === 'alerts' && (action === undefined || action === 'replay')) return match[2];
	return collection === 'jobs'
		&& (action === undefined || ['cancel', 'retry', 'retry-failed'].includes(action))
		? match[2]
		: null;
}

function createUrlContextResolver(source) {
	const contexts = [];
	const urlPattern = /https?:\/\/[^\s"'<>]+/gi;
	let match;
	while ((match = urlPattern.exec(source)) !== null) {
		const url = match[0];
		const urlStart = match.index;
		const authorityStart = url.indexOf('://') + 3;
		const authorityDelimiter = url.slice(authorityStart).search(/[/?#]/);
		const authorityEnd = authorityDelimiter === -1
			? urlStart + url.length
			: urlStart + authorityStart + authorityDelimiter;
		const pathStartInUrl = url.indexOf('/', authorityStart);
		const pathEndInUrl = url.search(/[?#]/);
		const pathEnd = urlStart + (pathEndInUrl === -1 ? url.length : pathEndInUrl);
		const pathStart = pathStartInUrl === -1 ? pathEnd : urlStart + pathStartInUrl;
		let parsed;
		try {
			parsed = new URL(url);
		} catch (_) {
			parsed = null;
		}

		contexts.push({
			start: urlStart,
			end: urlStart + url.length,
			authorityEnd,
			pathStart,
			pathEnd,
			correlationId: parsed ? getCorrelationApiId(parsed.pathname) : null,
			parsed,
		});
	}

	let contextIndex = 0;
	return (offset) => {
		while (contextIndex < contexts.length && offset >= contexts[contextIndex].end) contextIndex += 1;
		const context = contexts[contextIndex];
		return context && offset >= context.start && offset < context.end ? context : null;
	};
}

function isApiPathToken(candidate, offset, source, preserveRelativeApiPath, getUrlContextAt) {
	if (preserveRelativeApiPath && /^\/api\//i.test(source)) {
		const correlationId = getCorrelationApiId(source);
		if (correlationId === null) return false;
		const collectionEnd = source.indexOf('/', 5);
		const idStart = collectionEnd + 1;
		const isWholePath = offset === 0
			&& (source.length === candidate.length || ['?', '#'].includes(source[candidate.length]))
			&& getCorrelationApiId(candidate) !== null;
		return isWholePath || (candidate === correlationId && offset === idStart);
	}

	const urlContext = getUrlContextAt?.(offset);
	if (!urlContext?.parsed || !urlContext.parsed.pathname.toLowerCase().startsWith('/api/')) return false;
	if (offset + candidate.length > urlContext.pathEnd || urlContext.correlationId === null) return false;
	if (offset >= urlContext.pathStart) return candidate === urlContext.correlationId;
	return offset + candidate.length >= urlContext.pathEnd;
}

function redactHighEntropyPathSegments(text, { preserveRelativeApiPath = false } = {}) {
	const pathTokens = redactSensitiveCredentialPathTokens(text);
	const pathUrlContext = createUrlContextResolver(pathTokens);
	const redactedSegments = pathTokens.replace(
		/(?<=\/)[A-Za-z0-9+_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g,
		(candidate, offset, source) => {
			if (isApiPathToken(candidate, offset, source, preserveRelativeApiPath, pathUrlContext)) return candidate;
			return isHighEntropyToken(candidate) ? '[REDACTED]' : candidate;
		},
	);

	const redactedUrlContext = createUrlContextResolver(redactedSegments);
	return redactedSegments.replace(
		/(?<=\/)([A-Za-z0-9+_-]{12,}(?:\/[A-Za-z0-9+_-]{12,})+)/g,
		(_match, candidate, offset, source) => {
			if (isApiPathToken(candidate, offset, source, preserveRelativeApiPath, redactedUrlContext)) return candidate;
			if (!candidate.split('/').every(isHighEntropyPathSegment)) return candidate;
			return isHighEntropyToken(candidate.replaceAll('/', '')) ? '[REDACTED]' : candidate;
		},
	);
}

function isUrlPathSpanningToken(candidate, offset, getUrlContextAt) {
	if (!candidate.includes('/')) return false;
	const urlContext = getUrlContextAt(offset);
	return Boolean(urlContext
		&& urlContext.pathStart < urlContext.pathEnd
		&& offset < urlContext.pathEnd
		&& offset + candidate.length > urlContext.pathStart);
}

function isUrlAuthorityToken(offset, getUrlContextAt) {
	const urlContext = getUrlContextAt(offset);
	return Boolean(urlContext && offset < urlContext.authorityEnd);
}

function redactDotDelimitedHighEntropyTokens(text, { preserveRelativeApiPath = false } = {}) {
	const urlContextAt = createUrlContextResolver(text);
	return text.replace(
		/(?<![A-Za-z0-9+_-])[A-Za-z0-9+_-]+(?:\.[A-Za-z0-9+_-]+)+(?![A-Za-z0-9+_=.-])/g,
		(candidate, offset, source) => {
			if (isUrlAuthorityToken(offset, urlContextAt)) return candidate;
			if (isApiPathToken(candidate, offset, source, preserveRelativeApiPath, urlContextAt)) return candidate;
			return isHighEntropyToken(candidate.replaceAll('.', '')) ? '[REDACTED]' : candidate;
		},
	);
}

function redactHighEntropyTokens(text, {
	preserveRelativeApiPath = false,
	preserveConfigurationVariableLabels = false,
} = {}) {
	const redactedDotDelimitedTokens = redactDotDelimitedHighEntropyTokens(text, { preserveRelativeApiPath });
	const urlContextAt = createUrlContextResolver(redactedDotDelimitedTokens);
	return redactedDotDelimitedTokens.replace(
		/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g,
		(candidate, offset, source) => {
			if (preserveConfigurationVariableLabels && isConfigurationVariableLabel(candidate, offset, source)) {
				return candidate;
			}
			// URL path segments are screened separately; do not join ordinary slugs into one token.
			if (isUrlPathSpanningToken(candidate, offset, urlContextAt)) return candidate;

			// Only alert/job IDs on known routes are safe correlation values.
			if (isApiPathToken(candidate, offset, source, preserveRelativeApiPath, urlContextAt)) return candidate;
			return isHighEntropyToken(candidate) ? '[REDACTED]' : candidate;
		},
	);
}

function redactString(text, {
	preserveHighEntropy = false,
	preserveApiPath = false,
	preserveConfigurationVariableLabels = false,
} = {}) {
	if (typeof text !== 'string' || text.length === 0) {
		return text;
	}

	let result = text;

	// 1. Registered runtime secrets (longest first to avoid partial replacements)
	if (registeredSecrets.size > 0) {
		const secrets = Array.from(registeredSecrets).sort((a, b) => b.length - a.length);
		for (const secret of secrets) {
			if (result.includes(secret)) {
				result = result.replaceAll(secret, '[REDACTED]');
			}
		}
	}

	// 2. URL credentials, including the public key embedded in Sentry DSNs.
	result = result.replace(
		/\bhttps?:\/\/[^\s/?#@]+(?::[^\s/?#@]*)?@[^\s/?#]+(?:\/[^\s?#]*)?/gi,
		'[REDACTED]',
	);

	// 3. Discord Webhook URLs (preserve webhook base, mask token)
	result = result.replace(
		/(https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/)(?!\[REDACTED\])[^?\s/]+/gi,
		'$1[REDACTED]',
	);

	// 4. Telegram bot tokens (<id>:AA<30+ chars>)
	result = result.replace(
		/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}\b/g,
		'[REDACTED]',
	);

	// 5. OpenAI-style API keys (sk-<16+ chars>)
	result = result.replace(
		/(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}/g,
		'[REDACTED]',
	);

	// 6. URL query-string parameters with sensitive keys
	result = result.replace(
		/([?&](?:api[-_]?key|token|password|secret|access[-_]?token)=)(?!\[REDACTED\])([^&\s#"']+)/gi,
		'$1[REDACTED]',
	);

	// 7. JSON string properties with sensitive keys
	result = result.replace(
		/"(password|secret|token|api[-_]?key|authorization|cookie|dsn|discordWebhookUrl|webhookUrl)"\s*:\s*"(?!\[REDACTED\])([^"]*)"/gi,
		'"$1":"[REDACTED]"',
	);

	// 8. Authorization headers
	result = result.replace(
		/(?<=\bauthorization\s*:\s*(?:Bearer|Basic)\s+)(?!\[REDACTED\])[^\s,"'}{]+/gi,
		'[REDACTED]',
	);
	result = result.replace(
		/(?<=\bauthorization\s*:\s*)(?!(?:Bearer|Basic)\b|\[REDACTED\])[^\s,"'}{]+/gi,
		'[REDACTED]',
	);
	result = result.replace(
		/(?<=\bBearer\s+)(?!\[REDACTED\])[A-Za-z0-9._~+/-]{16,}=*/g,
		'[REDACTED]',
	);

	// 9. Key-value string patterns (e.g. api-key: value, token=value)
	result = result.replace(
		/(?<=\b(?:(?:bot|auth|access)[-_]?)?(?:token|api[-_]?key|password|secret)\s*(?:[:=]|is)\s*)(['"]?)(?!\[REDACTED\])[^\s,"'}{]+\1/gi,
		'$1[REDACTED]$1',
	);

	// 10. Generic token-shaped strings with conservative entropy and diversity thresholds.
	if (!preserveHighEntropy) {
		const requestIdValues = [];
		result = result.replace(
			/\b((?:x-)?request[-_]?id\s*=\s*)([^\s]{1,128})(?=\s|$)/gi,
			(match, label, value) => {
				const marker = `__REQUEST_ID_${requestIdValues.length}__`;
				requestIdValues.push([marker, value]);
				return `${label}${marker}`;
			},
		);
		const correlationIdValues = [];
		result = result.replace(
			/\b((?:(?:original|parent)[_-]?)?(?:alert|job|replay)(?:[_-]?id)?s?\s*[:=]?\s*)([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?![a-f0-9-])/gi,
			(_match, label, value) => {
				const marker = `__CORRELATION_ID_${correlationIdValues.length}__`;
				correlationIdValues.push([marker, value]);
				return `${label}${marker}`;
			},
		);
		result = redactHighEntropyPathSegments(result, { preserveRelativeApiPath: preserveApiPath });
		result = redactHighEntropyTokens(result, {
			preserveRelativeApiPath: preserveApiPath,
			preserveConfigurationVariableLabels,
		});
		for (const [marker, value] of requestIdValues) {
			result = result.replaceAll(marker, value);
		}
		for (const [marker, value] of correlationIdValues) {
			result = result.replaceAll(marker, value);
		}
	}

	return result;
}

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

function normalizeValue(value, seen = new WeakSet(), preserveRequestId = false, preserveApiPath = false) {
	if (value instanceof Error) {
		return serializeError(value);
	}

	if (value === null || typeof value !== 'object') {
		if (typeof value === 'string') {
			return redactString(value, {
				preserveHighEntropy: preserveRequestId && isValidRequestId(value),
				preserveApiPath,
			});
		}
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
			const preserveCorrelationId = CORRELATION_IDENTIFIER_KEY_PATTERN.test(key) && isUuid(nestedValue);
			acc[key] = SENSITIVE_KEY_PATTERN.test(key)
				? '[REDACTED]'
				: normalizeValue(
					nestedValue,
					seen,
					/^(?:x-)?request[_-]?id$/i.test(key) || preserveCorrelationId,
					/^path$/i.test(key),
				);
			return acc;
		}, {});
	}

	return redactString(String(value));
}

function serializeError(error) {
	return {
		name: error.name,
		message: redactString(error.message),
		stack: redactString(error.stack),
	};
}

function stringifyMessagePart(arg, { preserveHighEntropy = false } = {}) {
	if (arg instanceof Error) {
		return redactString(arg.message);
	}
	if (typeof arg === 'string') {
		return redactString(arg, { preserveHighEntropy, preserveConfigurationVariableLabels: true });
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
		const prevArgIsLabel = index > 0 && isSensitiveKeyLabel(args[index - 1]);
		const preserveCorrelationId = index > 0 && isCorrelationIdLabel(args[index - 1]) && isUuid(arg);
		const messagePart = stringifyMessagePart(arg, { preserveHighEntropy: preserveCorrelationId });

		if (messagePart !== undefined) {
			const finalMessagePart = prevArgIsLabel ? '[REDACTED]' : messagePart;
			messageParts.push(finalMessagePart);
			if (index > 0 && !(arg instanceof Error)) {
				const paramValue = prevArgIsLabel ? '[REDACTED]' : normalizeValue(arg, new WeakSet(), preserveCorrelationId);
				parameters.push(paramValue);
			}
		}

		if (arg instanceof Error) {
			error = error || serializeError(arg);
			return;
		}

		if (isPlainObject(arg)) {
			Object.assign(attributes, normalizeValue(arg));
		} else if (index > 0 && messagePart === undefined) {
			const paramValue = prevArgIsLabel ? '[REDACTED]' : normalizeValue(arg, new WeakSet(), preserveCorrelationId);
			parameters.push(paramValue);
		}
	});

	const rawMessage = messageParts.join(' ') || 'Log event';
	const entry = {
		timestamp: new Date().toISOString(),
		level,
		message: redactString(rawMessage, { preserveConfigurationVariableLabels: true }),
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
	registeredSecrets.clear();
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
	registerSecretValue,
	clearSecretValue,
	clearAllSecretValues,
	redactString,
};
