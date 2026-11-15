'use strict';

const {
	FIRESTORE_ERROR_CATEGORIES,
	classifyFirestoreError,
	describeFirestoreErrorCategory,
	isConfigurationErrorCategory,
	isFirestoreErrorCategory,
	isMissingIndexError,
} = require('../../src/services/storage/firestoreErrorCategories');

function grpcError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

describe('firestoreErrorCategories', () => {
	describe('classifyFirestoreError()', () => {
		it('maps numeric gRPC status codes from @google-cloud/firestore', () => {
			expect(classifyFirestoreError(grpcError(9, 'nope'))).toBe('failed_precondition');
			expect(classifyFirestoreError(grpcError(7, 'nope'))).toBe('permission_denied');
			expect(classifyFirestoreError(grpcError(16, 'nope'))).toBe('unauthenticated');
			expect(classifyFirestoreError(grpcError(14, 'nope'))).toBe('unavailable');
			expect(classifyFirestoreError(grpcError(4, 'nope'))).toBe('deadline_exceeded');
			expect(classifyFirestoreError(grpcError(5, 'nope'))).toBe('not_found');
			expect(classifyFirestoreError(grpcError(8, 'nope'))).toBe('resource_exhausted');
			expect(classifyFirestoreError(grpcError(3, 'nope'))).toBe('invalid_argument');
			expect(classifyFirestoreError(grpcError(10, 'nope'))).toBe('aborted');
			expect(classifyFirestoreError(grpcError(13, 'nope'))).toBe('internal');
		});

		it('maps numeric-string and canonical-name status shapes', () => {
			expect(classifyFirestoreError(grpcError('9', 'nope'))).toBe('failed_precondition');
			expect(classifyFirestoreError(grpcError('FAILED_PRECONDITION', 'nope'))).toBe('failed_precondition');
			expect(classifyFirestoreError(grpcError('failed-precondition', 'nope'))).toBe('failed_precondition');
			expect(classifyFirestoreError(grpcError('firestore/7', 'nope'))).toBe('permission_denied');
		});

		it('maps the google-gax status field', () => {
			const error = new Error('nope');
			error.status = 'PERMISSION_DENIED';
			expect(classifyFirestoreError(error)).toBe('permission_denied');
		});

		it('classifies transport failures as unavailable rather than blaming the query', () => {
			const error = new Error('socket hang up');
			error.errno = 'ECONNRESET';
			expect(classifyFirestoreError(error)).toBe('unavailable');
			expect(classifyFirestoreError(new Error('getaddrinfo ENOTFOUND firestore'))).toBe('unavailable');
		});

		it('falls back to unknown_error instead of inventing a category', () => {
			expect(classifyFirestoreError(new Error('something odd'))).toBe('unknown_error');
			expect(classifyFirestoreError(null)).toBe('unknown_error');
			expect(classifyFirestoreError({})).toBe('unknown_error');
		});

		it('lets an explicit context category win over the error shape', () => {
			expect(classifyFirestoreError(grpcError(7, 'nope'), {
				category: FIRESTORE_ERROR_CATEGORIES.UNINITIALIZED,
			})).toBe('uninitialized');
		});

		it('ignores an invalid context category rather than propagating it', () => {
			expect(classifyFirestoreError(grpcError(7, 'nope'), { category: 'bogus' })).toBe('permission_denied');
		});
	});

	describe('isMissingIndexError()', () => {
		it('detects the missing-index rejection that caused #1285', () => {
			const error = grpcError(
				9,
				'9 FAILED_PRECONDITION: The query requires an index. You can create an index here: '
				+ 'https://console.firebase.google.com/project/x/databases/(default)/indexes',
			);
			expect(isMissingIndexError(error)).toBe(true);
		});

		it('does not flag other FAILED_PRECONDITION causes', () => {
			expect(isMissingIndexError(grpcError(9, 'transaction aborted'))).toBe(false);
		});

		it('does not flag a non-precondition error that merely mentions an index', () => {
			expect(isMissingIndexError(grpcError(7, 'requires an index'))).toBe(false);
			expect(isMissingIndexError(null)).toBe(false);
		});
	});

	describe('isConfigurationErrorCategory()', () => {
		it('treats only credential/init failures as configuration problems', () => {
			expect(isConfigurationErrorCategory('uninitialized')).toBe(true);
			expect(isConfigurationErrorCategory('unauthenticated')).toBe(true);
			expect(isConfigurationErrorCategory('failed_precondition')).toBe(false);
			expect(isConfigurationErrorCategory('permission_denied')).toBe(false);
		});
	});

	describe('isFirestoreErrorCategory()', () => {
		it('accepts only the closed enum', () => {
			expect(isFirestoreErrorCategory('unavailable')).toBe(true);
			expect(isFirestoreErrorCategory('deployed_wrongly')).toBe(false);
			expect(isFirestoreErrorCategory(null)).toBe(false);
			expect(isFirestoreErrorCategory(7)).toBe(false);
		});
	});

	describe('describeFirestoreErrorCategory()', () => {
		it('never leaks provider text, paths, or credentials', () => {
			for (const category of Object.values(FIRESTORE_ERROR_CATEGORIES)) {
				const description = describeFirestoreErrorCategory(category);
				expect(typeof description).toBe('string');
				expect(description).not.toMatch(/projects\/|https:\/\/|BEGIN PRIVATE KEY|AIza/);
			}
		});

		it('gives a distinct actionable hint per category', () => {
			const hints = Object.values(FIRESTORE_ERROR_CATEGORIES).map(describeFirestoreErrorCategory);
			expect(new Set(hints).size).toBeGreaterThan(1);
			expect(describeFirestoreErrorCategory('failed_precondition')).toMatch(/missing composite index/i);
		});
	});
});