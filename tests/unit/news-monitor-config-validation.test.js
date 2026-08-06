const {
	parseNewsTimeoutMs,
	parseNewsAlertThreshold,
	NewsAnalyzer,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');

describe('News Monitor Configuration Validation', () => {
	let originalEnv;
	let warnSpy;

	beforeEach(() => {
		originalEnv = { ...process.env };
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		process.env = originalEnv;
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

	describe('NewsAnalyzer constructor env integration', () => {
		it('should initialize defaults when env vars are unset or empty', () => {
			delete process.env.NEWS_TIMEOUT_MS;
			delete process.env.NEWS_ALERT_THRESHOLD;

			const analyzer = new NewsAnalyzer();
			expect(analyzer.timeout).toBe(30000);
			expect(analyzer.alertThreshold).toBe(0.7);
		});

		it('should parse valid env vars correctly', () => {
			process.env.NEWS_TIMEOUT_MS = '12000';
			process.env.NEWS_ALERT_THRESHOLD = '0.85';

			const analyzer = new NewsAnalyzer();
			expect(analyzer.timeout).toBe(12000);
			expect(analyzer.alertThreshold).toBe(0.85);
		});

		it('should fallback to defaults and warn when env vars are invalid', () => {
			process.env.NEWS_TIMEOUT_MS = 'invalid_timeout_ms';
			process.env.NEWS_ALERT_THRESHOLD = '5.5';

			const analyzer = new NewsAnalyzer();
			expect(analyzer.timeout).toBe(30000);
			expect(analyzer.alertThreshold).toBe(0.7);
			expect(warnSpy).toHaveBeenCalled();
		});
	});
});
