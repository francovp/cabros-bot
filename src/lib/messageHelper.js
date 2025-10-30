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

module.exports = {
  truncateMessage,
};
