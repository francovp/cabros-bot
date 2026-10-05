const validUrl = (url) => {
	try {
		new URL(url);
		return url.startsWith('http://') || url.startsWith('https://');
	} catch {
		return false;
	}
};

const extractDomain = (url) => {
	try {
		const { hostname } = new URL(url);
		return hostname;
	} catch {
		return null;
	}
};

const VALID_SIGNAL_CLASSES = new Set([
	'breakout',
	'mean_reversion',
	'trend_continuation',
	'reversal',
	'volume_spike',
	'news_event',
	'manual',
	'unknown',
]);

function createInvalidRequestError(message) {
	const error = new Error(message);
	error.statusCode = 400;
	error.code = 'INVALID_REQUEST';
	error.response = {
		error: message,
		code: 'INVALID_REQUEST',
		error_code: 400,
	};
	return error;
}

function validateSignalClass(signalClass) {
	if (signalClass === undefined || signalClass === null) {
		return 'unknown';
	}
	if (typeof signalClass !== 'string') {
		throw createInvalidRequestError(
			`Invalid signalClass. Must be one of: ${Array.from(VALID_SIGNAL_CLASSES).join(', ')}`,
		);
	}
	const normalized = signalClass.trim().toLowerCase();
	if (!VALID_SIGNAL_CLASSES.has(normalized)) {
		throw createInvalidRequestError(
			`Invalid signalClass '${signalClass}'. Must be one of: ${Array.from(VALID_SIGNAL_CLASSES).join(', ')}`,
		);
	}
	return normalized;
}

const validateAlert = (text, metadata = null, signalClass) => {
	if (!text || typeof text !== 'string' || !text.trim()) {
		throw new Error('Alert text is required and must be a string');
	}

	if (metadata && typeof metadata !== 'object') {
		throw new Error('Alert metadata must be a valid object if provided');
	}

	let targetSignalClass = signalClass;
	if (targetSignalClass === undefined && metadata && typeof metadata === 'object' && metadata.signalClass !== undefined) {
		targetSignalClass = metadata.signalClass;
	}
	const validatedSignalClass = validateSignalClass(targetSignalClass);

	// Truncate text if needed
	if (text.length > 4000) {
		text = text.substring(0, 4000) + '...';
	}

	return {
		text,
		metadata,
		signalClass: validatedSignalClass,
	};
};

const validateSearchResult = (result) => {
	const { url, title } = result;

	if (!validUrl(url)) {
		throw new Error('Invalid URL in search result');
	}

	if (!title || typeof title !== 'string') {
		throw new Error('Search result title is required and must be a string');
	}

	return {
		...result,
		sourceDomain: extractDomain(url),
	};
};

const validateGeminiResponse = (response) => {
	const { summary, citations, confidence } = response;

	if (!summary || typeof summary !== 'string') {
		throw new Error('Gemini response summary is required and must be a string');
	}

	if (!Array.isArray(citations)) {
		throw new Error('Citations must be an array of search results');
	}

	citations.forEach(validateSearchResult);

	if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
		throw new Error('Confidence must be a number between 0 and 1');
	}

	return response;
};

module.exports = {
	validUrl,
	extractDomain,
	validateAlert,
	validateSearchResult,
	validateGeminiResponse,
	VALID_SIGNAL_CLASSES,
	validateSignalClass,
};