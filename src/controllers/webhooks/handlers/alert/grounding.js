const { validateAlert } = require('../../../../lib/validation');
const { groundAlert } = require('../../../../services/grounding/grounding');
const { GROUNDING_MODEL_NAME } = require('../../../../services/grounding/config');

/**
 * Derives a search query from alert text
 * @param {string} alertText Raw text to derive query from
 * @param {number} maxLength Maximum length for the generated query
 * @returns {Promise<{query: string, confidence: number}>}
 */
async function deriveSearchQuery(alertText, maxLength = 150) {
	const { text } = validateAlert(alertText);

	try {
		const { query, confidence } = await groundAlert.deriveSearchQuery(text, { maxLength });
		return { query, confidence };
	} catch (error) {
		// Fallback to simple approach if LLM fails
		const cleanText = text
			.replace(/[^\w\s]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();

		// Preserve whole words up to maxLength
		let query = cleanText;
		if (query.length > maxLength) {
			query = query.substring(0, maxLength);
			query = query.substring(0, query.lastIndexOf(' '));
		}

		// Add context keywords for financial/crypto alerts
		query += ' crypto cryptocurrency market news';

		return {
			query,
			// Lower confidence when using fallback
			confidence: 0.5,
		};
	}
}

/**
 * Enriches an alert with grounded context using Gemini
 *
 * Returns an EnrichedAlert object where:
 * - `original_text` comes from the webhook request body
 * - `sources` are derived from `genaiClient.search` `searchResults`
 *
 * @see specs/004-enrich-alert-output/contracts/api.md for the full data contract
 * @param {import('./types').Alert} alert
 * @returns {Promise<import('./types').EnrichedAlert>}
 */
async function enrichAlert(alert) {
	// Support being called with either a plain text string or an object
	// { text, metadata }
	const inputText = (typeof alert === 'string') ? alert : (alert && typeof alert.text === 'string' ? alert.text : alert);
	const metadata = (alert && alert.metadata) ? alert.metadata : null;

	const validated = validateAlert(inputText, metadata);
	// validateAlert may return either a string (when mocked in tests) or an object { text, metadata }
	const text = (typeof validated === 'string') ? validated : (validated && validated.text) ? validated.text : inputText;

	try {
		const { sentiment, sentiment_score, insights, technical_levels, sources, truncated } = await groundAlert({
			text,
			options: {
				preserveLanguage: true,
			},
		});

		return {
			original_text: text,
			sentiment,
			sentiment_score,
			insights,
			technical_levels,
			sources,
			truncated,
		};
	} catch (error) {
		throw new Error(`Alert enrichment failed: ${error.message}`);
	}
}

module.exports = {
	deriveSearchQuery,
	enrichAlert,
};