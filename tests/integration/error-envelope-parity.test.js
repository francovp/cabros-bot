'use strict';

/**
 * Contract test: every `/api/*` endpoint adopted in issue #1231 must return the
 * standardized error envelope — `success: false`, a machine-readable `code`, a
 * `requestId` correlation id, and a `retryable` flag that is CORRECT for the
 * HTTP status — while keeping the HTTP status code itself unchanged.
 *
 * The motivating gap: an automated monitor could not distinguish a transient
 * provider failure from a permanently disabled feature, because endpoints
 * returned raw `{ error, code }` bodies with no `retryable` signal.
 */

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	listOutcomes: jest.fn(),
	summarizeOutcomes: jest.fn(),
	getOutcomesCalibration: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
	INVALID_CURSOR_MESSAGE: 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.',
}));

jest.mock('../../src/services/storage/SymbolAnalysisStorageService', () => ({
	isEnabled: jest.fn(),
	listAnalyses: jest.fn(),
	summarizeAnalyses: jest.fn(),
}));

jest.mock('../../src/services/preferences/ChatPreferenceService', () => ({
	chatPreferenceService: {
		getPreferences: jest.fn(),
		setPreferences: jest.fn(),
		deletePreferences: jest.fn(),
	},
}));

jest.mock('../../src/services/diagnostics/SelfTestService', () => ({
	createSelfTestService: jest.fn(() => ({
		getLastResult: jest.fn(() => null),
		run: jest.fn(),
	})),
}));

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const symbolAnalysisStorageService = require('../../src/services/storage/SymbolAnalysisStorageService');
const { chatPreferenceService } = require('../../src/services/preferences/ChatPreferenceService');
const { createSelfTestService } = require('../../src/services/diagnostics/SelfTestService');

const AUTH = { 'x-api-key': 'test-key' };

/** Assert the standardized envelope shape and a status-correct `retryable`. */
function expectEnvelope(body, { status, retryable }) {
	expect(body).toEqual(expect.objectContaining({
		success: false,
		requestId: expect.any(String),
		retryable,
	}));
	expect(typeof body.error).toBe('string');
	expect(body.error.length).toBeGreaterThan(0);
	expect(typeof body.code).toBe('string');
	expect(body.code.length).toBeGreaterThan(0);
	// The envelope must never weaken the status it was derived from.
	expect(status).toBeGreaterThanOrEqual(400);
}

describe('Error envelope parity across adopted /api endpoints (#1231)', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'true',
			ENABLE_SYMBOL_ANALYSIS_STORAGE: 'true',
		});
		jest.clearAllMocks();
		signalOutcomeService.isEnabled.mockReturnValue(true);
		symbolAnalysisStorageService.isEnabled.mockReturnValue(true);
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = savedEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	describe('GET /api/outcomes', () => {
		it('400 INVALID_REQUEST is permanent, not retryable', async () => {
			const res = await request(app)
				.get('/api/outcomes?limit=not-a-number')
				.set(AUTH)
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expectEnvelope(res.body, { status: 400, retryable: false });
		});

		it('403 FEATURE_DISABLED is permanent', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(false);

			const res = await request(app)
				.get('/api/outcomes')
				.set(AUTH)
				.expect(403);

			expect(res.body.code).toBe('FEATURE_DISABLED');
			expectEnvelope(res.body, { status: 403, retryable: false });
		});

		it('503 STORAGE_UNAVAILABLE is retryable', async () => {
			signalOutcomeService.listOutcomes.mockRejectedValueOnce(
				Object.assign(new Error('Signal outcome tracking is enabled but Firestore is unavailable.'), {
					code: 'STORAGE_UNAVAILABLE',
				})
			);

			const res = await request(app)
				.get('/api/outcomes')
				.set(AUTH)
				.expect(503);

			expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
			expectEnvelope(res.body, { status: 503, retryable: true });
		});
	});

	describe('GET /api/symbol-analyses', () => {
		it('400 INVALID_REQUEST is permanent', async () => {
			const res = await request(app)
				.get('/api/symbol-analyses?limit=9999')
				.set(AUTH)
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expectEnvelope(res.body, { status: 400, retryable: false });
		});

		it('403 FEATURE_DISABLED is permanent', async () => {
			symbolAnalysisStorageService.isEnabled.mockReturnValue(false);

			const res = await request(app)
				.get('/api/symbol-analyses')
				.set(AUTH)
				.expect(403);

			expect(res.body.code).toBe('FEATURE_DISABLED');
			expectEnvelope(res.body, { status: 403, retryable: false });
		});
	});

	describe('GET /api/preferences/:channel/:chatId', () => {
		it('400 INVALID_REQUEST is permanent for an unsupported channel', async () => {
			const res = await request(app)
				.get('/api/preferences/carrier-pigeon/123')
				.set(AUTH)
				.expect(400);

			expectEnvelope(res.body, { status: 400, retryable: false });
		});

		it('500 INTERNAL_ERROR is retryable when the service throws', async () => {
			chatPreferenceService.getPreferences.mockRejectedValueOnce(new Error('boom'));

			const res = await request(app)
				.get('/api/preferences/telegram/123')
				.set(AUTH)
				.expect(500);

			expect(res.body.code).toBe('INTERNAL_ERROR');
			expectEnvelope(res.body, { status: 500, retryable: true });
		});
	});

	describe('PUT /api/preferences/:channel/:chatId', () => {
		it('400 INVALID_REQUEST is permanent for a non-object body', async () => {
			const res = await request(app)
				.put('/api/preferences/telegram/123')
				.set(AUTH)
				.set('Content-Type', 'application/json')
				.send('[]')
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expectEnvelope(res.body, { status: 400, retryable: false });
		});
	});

	describe('POST /api/selftest/run', () => {
		it('500 INTERNAL_ERROR is retryable and keeps its requestId', async () => {
			createSelfTestService.mockReturnValueOnce({
				getLastResult: jest.fn(() => null),
				run: jest.fn().mockRejectedValue(new Error('self-test exploded')),
			});

			const res = await request(app)
				.post('/api/selftest/run')
				.set(AUTH)
				.send({})
				.expect(500);

			expect(res.body.code).toBe('INTERNAL_ERROR');
			expect(res.body.requestId).toEqual(expect.any(String));
			expect(res.body).toEqual(expect.objectContaining({ success: false, retryable: true }));
		});
	});

	describe('GET /api/jobs', () => {
		it('400 INVALID_REQUEST is permanent for a bad limit', async () => {
			const res = await request(app)
				.get('/api/jobs?limit=0')
				.set(AUTH)
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expectEnvelope(res.body, { status: 400, retryable: false });
		});
	});

	describe('GET /api/jobs/:jobId', () => {
		it('404 NOT_FOUND is permanent', async () => {
			const res = await request(app)
				.get('/api/jobs/does-not-exist')
				.set(AUTH)
				.expect(404);

			expect(res.body.code).toBe('NOT_FOUND');
			expectEnvelope(res.body, { status: 404, retryable: false });
		});
	});

	describe('POST /api/jobs/tradingview-analysis', () => {
		it('400 INVALID_REQUEST is permanent when type is missing', async () => {
			const res = await request(app)
				.post('/api/jobs/tradingview-analysis')
				.set(AUTH)
				.send({})
				.expect(400);

			expect(res.body.code).toBe('INVALID_REQUEST');
			expectEnvelope(res.body, { status: 400, retryable: false });
		});
	});

	describe('GET /api/scanner-presets/:id', () => {
		it('404 NOT_FOUND is permanent', async () => {
			const res = await request(app)
				.get('/api/scanner-presets/missing-preset')
				.set(AUTH)
				.expect(404);

			expect(res.body.code).toBe('NOT_FOUND');
			expectEnvelope(res.body, { status: 404, retryable: false });
		});
	});
});
