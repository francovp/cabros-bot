const CLASSIFIER_URL = 'https://classifier.dev/v1/classify';
const REQUEST_TIMEOUT_MS = 2000;
const MAX_INPUT_LENGTH = 4000;

function isEnabled() {
	return process.env.ENABLE_NEWS_MONITOR_CLASSIFIER === 'true';
}

async function classifyHeadline(text, { labels, instructions, signal, deadline } = {}) {
	if (!isEnabled() || typeof text !== 'string' || !text.trim()) return null;
	if (!Array.isArray(labels) || labels.length < 2 || labels.length > 100
		|| labels.some(label => typeof label !== 'string' || !label.trim())
		|| new Set(labels).size !== labels.length) return null;
	if (typeof instructions !== 'string' || instructions.length > 4000) return null;

	const remainingMs = Number.isFinite(deadline) ? deadline - Date.now() : REQUEST_TIMEOUT_MS;
	if (remainingMs <= 0 || signal?.aborted) return null;
	const requestSignal = AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs));
	const combinedSignal = signal ? AbortSignal.any([signal, requestSignal]) : requestSignal;

	try {
		const response = await fetch(CLASSIFIER_URL, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({
				input: text.trim().slice(0, MAX_INPUT_LENGTH),
				labels,
				instructions,
				tier: 'fast',
			}),
			signal: combinedSignal,
		});
		if (!response.ok) {
			console.warn('[ClassifierDevClient] Classification request failed:', response.status);
			return null;
		}

		const result = (await response.json())?.results?.[0];
		if (typeof result?.label !== 'string'
			|| !result.label.trim()
			|| typeof result.confidence !== 'number'
			|| !Number.isFinite(result.confidence)
			|| result.confidence < 0
			|| result.confidence > 1) {
			console.warn('[ClassifierDevClient] Classification response was invalid');
			return null;
		}
		return { label: result.label, confidence: result.confidence };
	} catch (error) {
		if (!signal?.aborted) {
			console.warn('[ClassifierDevClient] Classification unavailable:', error.name || 'request_failed');
		}
		return null;
	}
}

module.exports = { isEnabled, classifyHeadline };
