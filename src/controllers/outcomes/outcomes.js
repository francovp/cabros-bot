'use strict';

/**
 * Outcomes controller — shadow-mode signal outcome summary endpoint.
 *
 * GET /api/outcomes/summary
 *   Returns aggregate metrics over recorded shadow-mode trading signals.
 *   Protected by validateApiKey.
 *   Returns 403 FEATURE_DISABLED when ENABLE_SIGNAL_OUTCOME_TRACKING is not set.
 *   Returns 503 STORAGE_UNAVAILABLE when Firestore is enabled but unreadable.
 *
 * Query parameters:
 *   limit  - max records to analyze (default 200, max 500)
 *   source - filter by source: 'webhook', 'news-monitor', 'scanner', 'expanded-analysis'
 *   symbol - filter by symbol (e.g. BTCUSDT)
 */

const signalOutcomeService = require('../../services/storage/SignalOutcomeService');

/**
 * GET /api/outcomes/summary
 */
async function getOutcomesSummary(req, res) {
	if (!signalOutcomeService.isEnabled()) {
		return res.status(403).json({
			error: 'FEATURE_DISABLED',
			message: 'Signal outcome tracking is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
		});
	}

	const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
	const { source, symbol } = req.query;

	try {
		const summary = await signalOutcomeService.getSummary({ limit, source, symbol });

		if (summary.error === 'STORAGE_UNAVAILABLE') {
			return res.status(503).json({
				error: 'STORAGE_UNAVAILABLE',
				message: summary.message,
			});
		}

		return res.json(summary);
	} catch (error) {
		console.error('[OutcomesController] Unexpected error in getOutcomesSummary:', error);
		return res.status(500).json({
			error: 'INTERNAL_ERROR',
			message: error.message,
		});
	}
}

module.exports = { getOutcomesSummary };
