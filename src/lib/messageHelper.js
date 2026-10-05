/**
 * messageHelper - Utility for message text manipulation
 * Handles truncation and formatting for multi-channel delivery
 */

/**
 * Truncate message text to maximum character limit
 * If truncation occurs, appends "…" indicator
 * @param {string} text - Text to truncate
 * @param {number} maxChars - Maximum characters allowed (default: 20000)
 * @returns {string} Truncated text with "…" if needed
 */
function truncateMessage(text, maxChars = 20000) {
	if (!text || typeof text !== 'string') {
		return '';
	}

	// If text is exactly at limit or under, no truncation needed
	if (text.length <= maxChars) {
		return text;
	}

	// Text exceeds limit; truncate and add "…"
	return text.substring(0, maxChars) + '…';
}

/**
 * Split message text into ordered chunks that respect a maximum size.
 * Prefers paragraph and line breaks, then whitespace, before falling back to a hard split.
 * @param {string} text - Text to split
 * @param {number} maxChars - Maximum characters per chunk
 * @returns {Array<string>} Ordered chunks ready for sequential delivery
 */
function splitMessageIntoChunks(text, maxChars = 20000) {
	if (!text || typeof text !== 'string') {
		return [''];
	}

	const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 20000;

	if (text.length <= limit) {
		return [text];
	}

	const chunks = [];
	let remaining = text;

	while (remaining.length > limit) {
		const minSplitPoint = Math.floor(limit / 2);
		let splitAt = remaining.lastIndexOf('\n\n', limit);

		if (splitAt < minSplitPoint) {
			splitAt = remaining.lastIndexOf('\n', limit);
		}

		if (splitAt < minSplitPoint) {
			splitAt = remaining.lastIndexOf(' ', limit);
		}

		if (splitAt <= 0) {
			splitAt = limit;
		}

		const chunk = remaining.slice(0, splitAt).trimEnd();
		chunks.push(chunk || remaining.slice(0, limit));
		remaining = remaining.slice(splitAt).trimStart();
	}

	if (remaining) {
		chunks.push(remaining);
	}

	return chunks;
}

const CHANNEL_CHUNK_LIMITS = Object.freeze({
	telegram: 1,
	whatsapp: 20000,
	discord: 2000,
});

/**
 * Estimate per-channel chunk count for a given message text.
 * @param {string} text - Message text
 * @returns {{ telegram: number, whatsapp: number, discord: number }} Per-channel chunk counts
 */
function estimateMessageChunks(text) {
	if (!text || typeof text !== 'string') {
		return {
			telegram: 1,
			whatsapp: 1,
			discord: 1,
		};
	}

	return {
		telegram: 1,
		whatsapp: splitMessageIntoChunks(text, CHANNEL_CHUNK_LIMITS.whatsapp).length,
		discord: splitMessageIntoChunks(text, CHANNEL_CHUNK_LIMITS.discord).length,
	};
}

module.exports = {
	truncateMessage,
	splitMessageIntoChunks,
	estimateMessageChunks,
	CHANNEL_CHUNK_LIMITS,
};
