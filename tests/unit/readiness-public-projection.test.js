const {
	projectDependenciesForPublic,
	toPublicErrorCode,
} = require('../../src/controllers/readiness');

describe('readiness public error projection (#1296)', () => {
	it('maps Telegram getUpdates conflicts to TELEGRAM_POLLING_CONFLICT', () => {
		expect(toPublicErrorCode('Conflict: terminated by other getUpdates request')).toBe(
			'TELEGRAM_POLLING_CONFLICT',
		);
		expect(
			toPublicErrorCode('409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'),
		).toBe('TELEGRAM_POLLING_CONFLICT');
	});

	it('preserves already-stable machine tokens', () => {
		expect(toPublicErrorCode('timeout_after_3000ms')).toBe('timeout_after_3000ms');
		expect(toPublicErrorCode('firestore_not_configured')).toBe('firestore_not_configured');
		expect(toPublicErrorCode('binance_http_451')).toBe('binance_http_451');
	});

	it('collapses free-text provider messages to a stable code', () => {
		expect(
			toPublicErrorCode('9 FAILED_PRECONDITION: The query requires an index.'),
		).toBe('DEPENDENCY_PROBE_FAILED');
		expect(toPublicErrorCode('boom')).toBe('DEPENDENCY_PROBE_FAILED');
		expect(toPublicErrorCode('   ')).toBeNull();
	});

	it('returns null for absent errors', () => {
		expect(toPublicErrorCode(undefined)).toBeNull();
		expect(toPublicErrorCode('')).toBeNull();
	});

	it('projects dependencies without raw error text', () => {
		const projected = projectDependenciesForPublic({
			telegram: {
				ready: false,
				error: 'Conflict: terminated by other getUpdates request',
				latencyMs: 120,
			},
			firestore: { ready: true, backend: 'firestore', latencyMs: 40 },
			gemini: { ready: false, error: 'timeout_after_3000ms', latencyMs: 3000 },
		});
		expect(projected.telegram.error).toBeUndefined();
		expect(projected.telegram.errorCode).toBe('TELEGRAM_POLLING_CONFLICT');
		expect(projected.telegram.ready).toBe(false);
		expect(projected.telegram.latencyMs).toBe(120);
		expect(projected.gemini.errorCode).toBe('timeout_after_3000ms');
		expect(projected.firestore).toEqual({ ready: true, backend: 'firestore', latencyMs: 40 });
	});
});
