'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const {
	releaseNotesService,
	DEFAULT_LIMIT,
	MAX_LIMIT,
} = require('../../services/releaseNotes/ReleaseNotesService');

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
		console.error('[ReleaseNotesController] Request failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'release-notes-controller',
			error,
			http: {
				endpoint,
				method: req.method,
				statusCode: 500,
			},
		});
		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	});
}

function getReleaseNotes(req, res) {
	return handleAsync(req, res, '/api/release-notes', async () => {
		const limit = releaseNotesService.parseLimit(req.query.limit);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${MAX_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const typesResult = releaseNotesService.parseTypes(req.query.type);
		if (typesResult && typesResult.error) {
			return res.status(400).json({
				error: typesResult.error,
				code: 'INVALID_REQUEST',
			});
		}

		const sinceResult = releaseNotesService.parseSince(req.query.since);
		if (sinceResult && sinceResult.error) {
			return res.status(400).json({
				error: sinceResult.error,
				code: 'INVALID_REQUEST',
			});
		}

		const summary = releaseNotesService.getSummary({
			limit,
			types: typesResult,
			since: sinceResult,
		});

		return res.status(200).json({
			success: true,
			summary,
		});
	});
}

function getReleaseNotesVersion(req, res) {
	return handleAsync(req, res, '/api/release-notes/:version', async () => {
		const version = req.params.version;
		if (!version) {
			return res.status(400).json({
				error: 'Missing version identifier',
				code: 'INVALID_REQUEST',
			});
		}
		const snapshot = releaseNotesService.getVersion(version);
		if (!snapshot) {
			return res.status(404).json({
				error: `No release-notes snapshot found for version "${version}".`,
				code: 'NOT_FOUND',
			});
		}
		return res.status(200).json({
			success: true,
			snapshot,
		});
	});
}

module.exports = {
	getReleaseNotes,
	getReleaseNotesVersion,
	DEFAULT_LIMIT,
	MAX_LIMIT,
};
