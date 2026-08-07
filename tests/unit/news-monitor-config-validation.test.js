const {
	parseNewsTimeoutMs,
	parseNewsAlertThreshold,
	NewsAnalyzer,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
const {
	parseNewsCacheTtlHours,
	NewsCache,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');

describe('News Monitor Configuration Validation', () => {
	let originalEnv;
	let warnSpy;

	beforeEach(() => {
		originalEnv = saveEnv();
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		restoreEnv(originalEnv);
		warnSpy.mockRestore();
	});

	describe('parseNewsTimeoutMs', () => {
		it('should return parsed integer for valid positive integer strings', () => {
			expect(parseNewsTimeoutMs('30000')).toBe(30000);
			expect(parseNewsTimeoutMs('15000')).toBe(15000);
			expect(parseNewsTimeoutMs('   60000   ')).toBe(60000);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should return fallback (30000) when value is undefined or empty string', () => {
			expect(parseNewsTimeoutMs(undefined)).toBe(30000);
			expect(parseNewsTimeoutMs('')).toBe(30000);
			expect(parseNewsTimeoutMs('   ')).toBe(30000);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should warn and return fallback (30000) for non-numeric, partial, or NaN values', () => {
			expect(parseNewsTimeoutMs('30000ms')).toBe(30000);
			expect(parseNewsTimeoutMs('invalid')).toBe(30000);
			expect(parseNewsTimeoutMs('NaN')).toBe(30000);
			expect(parseNewsTimeoutMs('Infinity')).toBe(30000);
			expect(parseNewsTimeoutMs('30000.5')).toBe(30000);

			expect(warnSpy).toHaveBeenCalledWith('[Analyzer] Invalid NEWS_TIMEOUT_MS configuration, using default');
		});

		it('should warn and return fallback (30000) for zero or negative values', () => {
			expect(parseNewsTimeoutMs('0')).toBe(30000);
			expect(parseNewsTimeoutMs('-1000')).toBe(30000);

			expect(warnSpy).toHaveBeenCalledWith('[Analyzer] Invalid NEWS_TIMEOUT_MS configuration, using default');
		});

		it('should never include the raw invalid value in the redacted warning message', () => {
			const secretVal = 'SUPER_SECRET_INVALID_VAL_9999ms';
			parseNewsTimeoutMs(secretVal);

			expect(warnSpy).toHaveBeenCalled();
			const lastCallArg = warnSpy.mock.calls[0][0];
			expect(lastCallArg).not.toContain(secretVal);
		});
	});

	describe('parseNewsAlertThreshold', () => {
		it('should return parsed float for valid values in range [0, 1]', () => {
			expect(parseNewsAlertThreshold('0.7')).toBe(0.7);
			expect(parseNewsAlertThreshold('0')).toBe(0);
			expect(parseNewsAlertThreshold('1')).toBe(1);
			expect(parseNewsAlertThreshold('0.5')).toBe(0.5);
			expect(parseNewsAlertThreshold('0.0')).toBe(0);
			expect(parseNewsAlertThreshold('1.0')).toBe(1);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should return fallback (0.7) when value is undefined or empty string', () => {
			expect(parseNewsAlertThreshold(undefined)).toBe(0.7);
			expect(parseNewsAlertThreshold('')).toBe(0.7);
			expect(parseNewsAlertThreshold('   ')).toBe(0.7);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should warn and return fallback (0.7) for non-numeric, partial, or NaN values', () => {
			expect(parseNewsAlertThreshold('0.7foo')).toBe(0.7);
			expect(parseNewsAlertThreshold('invalid')).toBe(0.7);
			expect(parseNewsAlertThreshold('NaN')).toBe(0.7);
			expect(parseNewsAlertThreshold('Infinity')).toBe(0.7);

			expect(warnSpy).toHaveBeenCalledWith('[Analyzer] Invalid NEWS_ALERT_THRESHOLD configuration, using default');
		});

		it('should warn and return fallback (0.7) for out-of-range values (< 0 or > 1)', () => {
			expect(parseNewsAlertThreshold('-0.1')).toBe(0.7);
			expect(parseNewsAlertThreshold('1.1')).toBe(0.7);
			expect(parseNewsAlertThreshold('2.0')).toBe(0.7);

			expect(warnSpy).toHaveBeenCalledWith('[Analyzer] Invalid NEWS_ALERT_THRESHOLD configuration, using default');
		});

		it('should never include the raw invalid value in the redacted warning message', () => {
			const secretVal = '0.8SECRET_SUFFIX';
			parseNewsAlertThreshold(secretVal);

			expect(warnSpy).toHaveBeenCalled();
			const lastCallArg = warnSpy.mock.calls[0][0];
			expect(lastCallArg).not.toContain(secretVal);
		});
	});

	describe('parseNewsCacheTtlHours', () => {
		it('should return parsed number for valid non-negative float/integer strings', () => {
			expect(parseNewsCacheTtlHours('6')).toBe(6);
			expect(parseNewsCacheTtlHours('0.5')).toBe(0.5);
			expect(parseNewsCacheTtlHours('12')).toBe(12);
			expect(parseNewsCacheTtlHours('   24   ')).toBe(24);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should allow 0 to preserve documented no-cache behavior without warning', () => {
			expect(parseNewsCacheTtlHours('0')).toBe(0);
			expect(parseNewsCacheTtlHours('0.0')).toBe(0);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should return fallback (6) when value is undefined, null, or empty string', () => {
			expect(parseNewsCacheTtlHours(undefined)).toBe(6);
			expect(parseNewsCacheTtlHours(null)).toBe(6);
			expect(parseNewsCacheTtlHours('')).toBe(6);
			expect(parseNewsCacheTtlHours('   ')).toBe(6);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should warn and return fallback (6) for malformed, NaN, or non-numeric values', () => {
			expect(parseNewsCacheTtlHours('not-a-number')).toBe(6);
			expect(parseNewsCacheTtlHours('NaN')).toBe(6);
			expect(parseNewsCacheTtlHours('Infinity')).toBe(6);
			expect(parseNewsCacheTtlHours('6hours')).toBe(6);

			expect(warnSpy).toHaveBeenCalledWith('[NewsCache] Invalid NEWS_CACHE_TTL_HOURS configuration, using default');
		});

		it('should warn and return fallback (6) for negative values', () => {
			expect(parseNewsCacheTtlHours('-1')).toBe(6);
			expect(parseNewsCacheTtlHours('-0.5')).toBe(6);

			expect(warnSpy).toHaveBeenCalledWith('[NewsCache] Invalid NEWS_CACHE_TTL_HOURS configuration, using default');
		});

		it('should never include the raw invalid value in the redacted warning message', () => {
			const secretVal = 'INVALID_SECRET_TTL_9999';
			parseNewsCacheTtlHours(secretVal);

			expect(warnSpy).toHaveBeenCalled();
			const lastCallArg = warnSpy.mock.calls[0][0];
			expect(lastCallArg).not.toContain(secretVal);
		});
	});

	describe('NewsCache constructor env integration', () => {
		it('should initialize default TTL (6 hours) when env var is unset or empty', () => {
			delete process.env.NEWS_CACHE_TTL_HOURS;

			const cache = new NewsCache();
			expect(cache.ttlMs).toBe(6 * 60 * 60 * 1000);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should parse valid NEWS_CACHE_TTL_HOURS env var correctly', () => {
			process.env.NEWS_CACHE_TTL_HOURS = '12';

			const cache = new NewsCache();
			expect(cache.ttlMs).toBe(12 * 60 * 60 * 1000);
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('should fallback to 6 hours and warn when NEWS_CACHE_TTL_HOURS is malformed or negative', () => {
			process.env.NEWS_CACHE_TTL_HOURS = 'not-a-number';

			const cache = new NewsCache();
			expect(cache.ttlMs).toBe(6 * 60 * 60 * 1000);
			expect(warnSpy).toHaveBeenCalledWith('[NewsCache] Invalid NEWS_CACHE_TTL_HOURS configuration, using default');
		});

		it('should handle zero TTL (NEWS_CACHE_TTL_HOURS=0) for no-cache behavior', () => {
			process.env.NEWS_CACHE_TTL_HOURS = '0';

			const cache = new NewsCache();
			expect(cache.ttlMs).toBe(0);
			expect(warnSpy).not.toHaveBeenCalled();
		});
	});

	describe('NewsAnalyzer constructor env integration', () => {
		it('should initialize defaults when env vars are unset or empty', () => {
			delete process.env.NEWS_TIMEOUT_MS;
			delete process.env.NEWS_ALERT_THRESHOLD;

			const analyzer = new NewsAnalyzer();
			expect(analyzer.timeout).toBe(60000);
			expect(analyzer.alertThreshold).toBe(0.7);
		});

		it('should parse valid env vars correctly', () => {
			process.env.NEWS_TIMEOUT_MS = '12000';
			process.env.NEWS_ALERT_THRESHOLD = '0.85';

			const analyzer = new NewsAnalyzer();
			expect(analyzer.timeout).toBe(12000);
			expect(analyzer.alertThreshold).toBe(0.85);
		});
	});
});
