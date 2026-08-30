const { isValidApiKey, timingSafeMatchString } = require('../../src/lib/auth');

describe('auth: WEBHOOK_API_KEY_PREVIOUS grace key helper', () => {
	let savedKey;
	let savedPrevious;

	beforeEach(() => {
		savedKey = process.env.WEBHOOK_API_KEY;
		savedPrevious = process.env.WEBHOOK_API_KEY_PREVIOUS;
		process.env.WEBHOOK_API_KEY = 'primary-key';
	});

	afterEach(() => {
		if (savedKey === undefined) {
			delete process.env.WEBHOOK_API_KEY;
		} else {
			process.env.WEBHOOK_API_KEY = savedKey;
		}
		if (savedPrevious === undefined) {
			delete process.env.WEBHOOK_API_KEY_PREVIOUS;
		} else {
			process.env.WEBHOOK_API_KEY_PREVIOUS = savedPrevious;
		}
	});

	function buildRequest(headerValue) {
		return {
			headers: { 'x-api-key': headerValue },
			query: {},
		};
	}

	describe('timingSafeMatchString', () => {
		test('matches identical strings', () => {
			expect(timingSafeMatchString('abc', 'abc')).toBe(true);
		});

		test('rejects mismatched strings of the same length', () => {
			expect(timingSafeMatchString('abc', 'abd')).toBe(false);
		});

		test('rejects strings of different length without throwing', () => {
			expect(timingSafeMatchString('ab', 'abc')).toBe(false);
			expect(timingSafeMatchString('abc', 'ab')).toBe(false);
		});

		test('rejects non-string candidates', () => {
			expect(timingSafeMatchString(null, 'abc')).toBe(false);
			expect(timingSafeMatchString(undefined, 'abc')).toBe(false);
			expect(timingSafeMatchString(123, 'abc')).toBe(false);
		});

		test('rejects non-string expected', () => {
			expect(timingSafeMatchString('abc', null)).toBe(false);
			expect(timingSafeMatchString('abc', undefined)).toBe(false);
			expect(timingSafeMatchString('abc', 123)).toBe(false);
		});
	});

	describe('isValidApiKey with grace key rotation', () => {
		test('returns false when primary WEBHOOK_API_KEY is unset', () => {
			delete process.env.WEBHOOK_API_KEY;
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'previous-key';

			expect(isValidApiKey(buildRequest('previous-key'))).toBe(false);
		});

		test('accepts primary key when grace key is unset', () => {
			delete process.env.WEBHOOK_API_KEY_PREVIOUS;

			expect(isValidApiKey(buildRequest('primary-key'))).toBe(true);
		});

		test('rejects previous key when grace key is unset', () => {
			delete process.env.WEBHOOK_API_KEY_PREVIOUS;

			expect(isValidApiKey(buildRequest('previous-key'))).toBe(false);
		});

		test('accepts primary key when grace key is configured', () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'previous-key';

			expect(isValidApiKey(buildRequest('primary-key'))).toBe(true);
		});

		test('accepts previous key when grace key is configured', () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'previous-key';

			expect(isValidApiKey(buildRequest('previous-key'))).toBe(true);
		});

		test('rejects keys matching neither', () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'previous-key';

			expect(isValidApiKey(buildRequest('not-the-key'))).toBe(false);
		});

		test('treats empty-string grace key as not configured', () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = '';

			expect(isValidApiKey(buildRequest('previous-key'))).toBe(false);
			expect(isValidApiKey(buildRequest('primary-key'))).toBe(true);
		});

		test('returns false when request has no x-api-key header', () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'previous-key';

			expect(isValidApiKey({ headers: {}, query: {} })).toBe(false);
		});

		test('returns false when header is not a string', () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'previous-key';

			expect(isValidApiKey(buildRequest(['array-header']))).toBe(false);
		});

		test('falls back to query parameter api-key', () => {
			process.env.WEBHOOK_API_KEY_PREVIOUS = 'previous-key';

			expect(isValidApiKey({ headers: {}, query: { 'api-key': 'previous-key' } })).toBe(true);
		});
	});
});