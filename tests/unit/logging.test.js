const {
	configureLogging,
	_resetLoggingForTests,
	registerSecretValue,
	clearSecretValue,
	clearAllSecretValues,
	redactString,
} = require('../../src/lib/logging');

describe('structured console logging', () => {
	const originalEnv = process.env;
	let output;

	beforeEach(() => {
		_resetLoggingForTests();
		process.env = {
			...originalEnv,
			LOG_LEVEL: 'debug',
			NODE_ENV: 'test',
			SERVICE_NAME: 'cabros-bot-test',
		};

		output = {
			debug: jest.fn(),
			info: jest.fn(),
			log: jest.fn(),
			warn: jest.fn(),
			error: jest.fn(),
		};

		console.debug = output.debug;
		console.info = output.info;
		console.log = output.log;
		console.warn = output.warn;
		console.error = output.error;
	});

	afterEach(() => {
		_resetLoggingForTests();
		process.env = originalEnv;
	});

	function parseLast(callMock) {
		const call = callMock.mock.calls[callMock.mock.calls.length - 1];
		expect(call).toHaveLength(1);
		return JSON.parse(call[0]);
	}

	it('should emit console logs as single-line JSON with standard fields', () => {
		configureLogging();
		output.info.mockClear();

		console.info('Processing alert', { requestId: 'req-123', channel: 'telegram' });

		const log = parseLast(output.info);
		expect(log).toEqual(expect.objectContaining({
			level: 'info',
			message: 'Processing alert',
			service: 'cabros-bot-test',
			environment: 'test',
			pid: expect.any(Number),
			attributes: {
				requestId: 'req-123',
				channel: 'telegram',
			},
		}));
		expect(new Date(log.timestamp).toISOString()).toBe(log.timestamp);
	});

	it('should map console.log to info and preserve primitive parameters', () => {
		configureLogging();
		output.info.mockClear();

		console.log('Telegram bot state', 'enabled', true);

		const log = parseLast(output.log);
		expect(log.level).toBe('info');
		expect(log.message).toBe('Telegram bot state enabled true');
		expect(log.parameters).toEqual(['enabled', true]);
	});

	it('should serialize Error instances with name, message, and stack', () => {
		configureLogging();
		output.info.mockClear();
		const error = new TypeError('Invalid payload');

		console.error('Alert request failed', error);

		const log = parseLast(output.error);
		expect(log.level).toBe('error');
		expect(log.message).toBe('Alert request failed Invalid payload');
		expect(log.error).toEqual(expect.objectContaining({
			name: 'TypeError',
			message: 'Invalid payload',
			stack: expect.stringContaining('TypeError: Invalid payload'),
		}));
	});

	it('should redact sensitive fields from structured attributes', () => {
		configureLogging();
		output.info.mockClear();

		console.warn('Provider config loaded', {
			apiKey: 'secret-api-key',
			nested: {
				botToken: 'secret-bot-token',
				safe: 'visible',
			},
		});

		const log = parseLast(output.warn);
		expect(log.attributes).toEqual({
			apiKey: '[REDACTED]',
			nested: {
				botToken: '[REDACTED]',
				safe: 'visible',
			},
		});
	});

	it('should filter logs below LOG_LEVEL', () => {
		process.env.LOG_LEVEL = 'error';

		configureLogging();
		console.warn('filtered warning');
		console.error('visible error');

		expect(output.warn).not.toHaveBeenCalled();
		expect(output.error).toHaveBeenCalledTimes(1);
		expect(parseLast(output.error).message).toBe('visible error');
	});

	it('should redact bare-scalar secrets when preceded by sensitive key labels', () => {
		configureLogging();
		output.info.mockClear();

		const apiKey = 'secret-api-key-value-999';
		console.log('api-key:', apiKey);

		const log1 = parseLast(output.log);
		expect(log1.message).toBe('api-key: [REDACTED]');
		expect(log1.parameters).toEqual(['[REDACTED]']);
		expect(JSON.stringify(log1)).not.toContain(apiKey);

		const token = 'secret-token-scalar-888';
		console.log('Token =', token);

		const log2 = parseLast(output.log);
		expect(log2.message).toBe('Token = [REDACTED]');
		expect(log2.parameters).toEqual(['[REDACTED]']);
		expect(JSON.stringify(log2)).not.toContain(token);
	});

	it('should redact string-content secrets embedded in messages and JSON', () => {
		configureLogging();
		output.info.mockClear();

		const token = 'my-super-secret-token-json';
		console.log('p=' + JSON.stringify({ token }));

		const log1 = parseLast(output.log);
		expect(log1.message).toBe('p={"token":"[REDACTED]"}');
		expect(JSON.stringify(log1)).not.toContain(token);

		console.log('Incoming payload:', JSON.stringify({ token, body: 'safe-body' }));
		const log2 = parseLast(output.log);
		expect(log2.message).toBe('Incoming payload: {"token":"[REDACTED]","body":"safe-body"}');
		expect(JSON.stringify(log2)).not.toContain(token);
	});

	it('should redact secrets embedded in URL query parameters', () => {
		configureLogging();
		output.info.mockClear();

		const rawUrl = 'https://api.twelvedata.com/price?symbol=AAPL&apikey=secret-twelve-key-123&format=json';
		console.log('GET', rawUrl);

		const log1 = parseLast(output.log);
		expect(log1.message).toBe('GET https://api.twelvedata.com/price?symbol=AAPL&apikey=[REDACTED]&format=json');
		expect(log1.parameters).toEqual(['https://api.twelvedata.com/price?symbol=AAPL&apikey=[REDACTED]&format=json']);
		expect(JSON.stringify(log1)).not.toContain('secret-twelve-key-123');

		const rawUrl2 = 'https://api.example.com/v1/alert?token=secret-token-abc&category=signal';
		console.log('Fetched', rawUrl2);

		const log2 = parseLast(output.log);
		expect(log2.message).toBe('Fetched https://api.example.com/v1/alert?token=[REDACTED]&category=signal');
		expect(JSON.stringify(log2)).not.toContain('secret-token-abc');
	});

	it('should redact well-known secret patterns (Bearer tokens, Discord webhooks, Telegram tokens, OpenAI keys)', () => {
		configureLogging();
		output.info.mockClear();

		console.log('auth:', 'authorization: Bearer my-bearer-secret-token-12345');
		const log1 = parseLast(output.log);
		expect(log1.message).toBe('auth: authorization: Bearer [REDACTED]');
		expect(JSON.stringify(log1)).not.toContain('my-bearer-secret-token-12345');

		console.log('Discord alert:', 'https://discord.com/api/webhooks/1234567890/my-discord-secret-token');
		const log2 = parseLast(output.log);
		expect(log2.message).toBe('Discord alert: https://discord.com/api/webhooks/1234567890/[REDACTED]');
		expect(JSON.stringify(log2)).not.toContain('my-discord-secret-token');

		console.log('Telegram bot token:', '123456789:AAH12345678901234567890123456789012');
		const log3 = parseLast(output.log);
		expect(log3.message).toBe('Telegram bot token: [REDACTED]');
		expect(JSON.stringify(log3)).not.toContain('123456789:AAH12345678901234567890123456789012');

		console.log('OpenAI key:', 'sk-abcdef1234567890abcdef12345678');
		const log4 = parseLast(output.log);
		expect(log4.message).toBe('OpenAI key: [REDACTED]');
		expect(JSON.stringify(log4)).not.toContain('sk-abcdef1234567890abcdef12345678');
	});

	it('should support request-scoped registered secrets via registerSecretValue and clearSecretValue', () => {
		configureLogging();
		output.info.mockClear();

		const customSecret = 'runtime-secret-key-to-mask';

		// Idempotent registration
		registerSecretValue(customSecret);
		registerSecretValue(customSecret);

		console.log('validating', customSecret);
		const log1 = parseLast(output.log);
		expect(log1.message).toBe('validating [REDACTED]');
		expect(log1.parameters).toEqual(['[REDACTED]']);
		expect(JSON.stringify(log1)).not.toContain(customSecret);

		// Multipart message
		console.log('a', customSecret, 'b');
		const log2 = parseLast(output.log);
		expect(log2.message).toBe('a [REDACTED] b');
		expect(log2.parameters).toEqual(['[REDACTED]', 'b']);
		expect(JSON.stringify(log2)).not.toContain(customSecret);

		// Clear secret
		clearSecretValue(customSecret);
		console.log('completed validation for', customSecret);
		const log3 = parseLast(output.log);
		expect(log3.message).toBe(`completed validation for ${customSecret}`);
		expect(log3.parameters).toEqual([customSecret]);
	});

	it('should redact 5KB of message text in under 1ms on warm V8', () => {
		configureLogging();

		const baseText = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(80); // ~4.5KB
		const text5kb = `${baseText} api_key=secret-in-large-payload-123 end of message`;
		expect(text5kb.length).toBeGreaterThan(4500);

		// Warm up V8 JIT
		for (let i = 0; i < 50; i++) {
			redactString(text5kb);
		}

		const iterations = 50;
		const start = performance.now();
		for (let i = 0; i < iterations; i++) {
			const result = redactString(text5kb);
			expect(result).toContain('api_key=[REDACTED]');
			expect(result).not.toContain('secret-in-large-payload-123');
		}
		const durationMs = (performance.now() - start) / iterations;

		expect(durationMs).toBeLessThan(1.0);
	});

	it('should preserve byte-identical output for non-sensitive logs', () => {
		configureLogging();
		output.info.mockClear();

		console.info('Processing alert', { requestId: 'req-123', channel: 'telegram' });
		const log = parseLast(output.info);

		expect(log.message).toBe('Processing alert');
		expect(log.attributes).toEqual({
			requestId: 'req-123',
			channel: 'telegram',
		});
	});

	it('should handle registration edge cases and clearAllSecretValues cleanly', () => {
		configureLogging();
		output.info.mockClear();

		// Should ignore null, undefined, non-strings, and strings < 4 chars
		registerSecretValue(null);
		registerSecretValue(undefined);
		registerSecretValue(12345);
		registerSecretValue('abc');

		console.log('short text:', 'abc');
		const log1 = parseLast(output.log);
		expect(log1.message).toBe('short text: abc');

		// Longest-first replacement order
		const secretShort = 'mysecret';
		const secretLong = 'mysecret_with_suffix';
		registerSecretValue(secretShort);
		registerSecretValue(secretLong);

		console.log('payload with both:', secretLong);
		const log2 = parseLast(output.log);
		expect(log2.message).toBe('payload with both: [REDACTED]');

		// clearAllSecretValues clears everything
		clearAllSecretValues();
		console.log('after clearAll:', secretLong);
		const log3 = parseLast(output.log);
		expect(log3.message).toBe(`after clearAll: ${secretLong}`);
	});

	it('should redact secrets inside error message, stack, and nested object values', () => {
		configureLogging();
		output.info.mockClear();

		const error = new Error('Connection failed to https://api.twelvedata.com/price?apikey=secret-twelve-data-key-999');
		console.error('Request failed', error);

		const errLog = parseLast(output.error);
		expect(errLog.error.message).toContain('apikey=[REDACTED]');
		expect(errLog.error.message).not.toContain('secret-twelve-data-key-999');
		expect(errLog.error.stack).not.toContain('secret-twelve-data-key-999');

		// Nested object with non-sensitive key name containing sensitive URL value
		console.info('Provider config', {
			endpoint: 'https://example.com/webhook?token=nested-token-value-123',
		});
		const infoLog = parseLast(output.info);
		expect(infoLog.attributes.endpoint).toBe('https://example.com/webhook?token=[REDACTED]');
	});
});


