const {
	configureLogging,
	_resetLoggingForTests,
	registerSecretValue,
	clearSecretValue,
	clearAllSecretValues,
	redactString,
} = require('../../src/lib/logging');

function makeHighEntropyToken(suffix = 'z') {
	return ['Qm7_vB2n', 'L8xW4sK9', 'pD3aR6tY', '1uF5cH0', suffix].join('');
}

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

	it('should redact values labeled with the generic key label', () => {
		configureLogging();
		output.warn.mockClear();

		const secret = 'webhook-signing-secret-value';
		console.warn('key', secret);

		const log = parseLast(output.warn);
		expect(log.message).toBe('key [REDACTED]');
		expect(log.parameters).toEqual(['[REDACTED]']);
		expect(JSON.stringify(log)).not.toContain(secret);
	});

	it('should preserve uppercase environment variable names in log messages', () => {
		configureLogging();
		output.warn.mockClear();

		console.warn('Configuration warning: SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES must contain only mcp, binance, twelve-data, or gemini providers.');

		const log = parseLast(output.warn);
		expect(log.message).toContain('SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES');
	});

	it('should redact DSNs and high-entropy scalar tokens while preserving low-entropy identifiers', () => {
		configureLogging();
		output.info.mockClear();

		const dsn = 'https://public-dsn-key@sentry.example.com/12345';
		console.log('Sentry endpoint', dsn);
		const dsnLog = parseLast(output.log);
		expect(dsnLog.message).toBe('Sentry endpoint [REDACTED]');
		expect(dsnLog.parameters).toEqual(['[REDACTED]']);
		expect(JSON.stringify(dsnLog)).not.toContain(dsn);

		const token = makeHighEntropyToken('A');
		console.log('provider output', token);
		const tokenLog = parseLast(output.log);
		expect(tokenLog.message).toBe('provider output [REDACTED]');
		expect(tokenLog.parameters).toEqual(['[REDACTED]']);
		expect(JSON.stringify(tokenLog)).not.toContain(token);

		const lowEntropy = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
		console.log('request id', lowEntropy);
		const safeLog = parseLast(output.log);
		expect(safeLog.message).toBe(`request id ${lowEntropy}`);
		expect(safeLog.parameters).toEqual([lowEntropy]);
	});

	it('should redact high-entropy string values nested under non-sensitive keys', () => {
		configureLogging();
		output.info.mockClear();

		const token = makeHighEntropyToken();
		console.info('provider response', { state: token });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ state: '[REDACTED]' });
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should redact high-entropy values longer than 512 characters', () => {
		configureLogging();
		output.info.mockClear();

		const token = makeHighEntropyToken().repeat(20);
		console.info('provider response', { state: token });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ state: '[REDACTED]' });
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should redact high-entropy hexadecimal values under non-sensitive keys', () => {
		configureLogging();
		output.info.mockClear();

		const token = ['01234567', '89abcdef', '01234567', '89abcdef'].join('');
		console.info('provider response', { state: token });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ state: '[REDACTED]' });
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should redact uppercase high-entropy values under non-sensitive keys', () => {
		configureLogging();
		output.info.mockClear();

		const token = makeHighEntropyToken().toUpperCase();
		console.info('provider response', { state: token });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ state: '[REDACTED]' });
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should redact diverse lowercase-only high-entropy values', () => {
		configureLogging();
		output.info.mockClear();

		const token = 'qzmxncvbaplsjdhfgktyurowieqzmxnv';
		console.info('provider response', { state: token });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ state: '[REDACTED]' });
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should redact UUID-shaped values outside request-id context', () => {
		configureLogging();
		output.info.mockClear();

		const secret = ['3f1c8e2a-0b1d', '-4a7e-9c11-', 'abcdef012345'].join('');
		console.info('provider response', { state: secret });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ state: '[REDACTED]' });
		expect(JSON.stringify(log)).not.toContain(secret);
	});

	it('should redact high-entropy tokens that contain an API path fragment', () => {
		configureLogging();
		output.info.mockClear();

		const token = 'Qm7_vB2nL8xW4sK9pD3aR6tY1uF5cH0z/api/A7k_Q2vN9eWm4LxB8rYc5HsP1dFz3UaG';
		console.info('provider response', { state: token });

		const log = parseLast(output.info);
		expect(log.attributes.state).not.toContain(token);
		expect(log.attributes.state).toContain('[REDACTED]');
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should redact high-entropy tokens in ordinary absolute URL paths', () => {
		configureLogging();
		output.info.mockClear();

		const token = makeHighEntropyToken();
		console.info('provider URL', `https://example.com/reset/${token}`);

		const log = parseLast(output.info);
		expect(log.message).toBe('provider URL https://example.com/reset/[REDACTED]');
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should redact path-shaped high-entropy values outside path fields', () => {
		configureLogging();
		output.info.mockClear();

		const token = '/api/alerts/Qm7_vB2nL8xW4sK9pD3aR6tY1uF5cH0z';
		console.info('provider response', { state: token });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ state: '/api/alerts/[REDACTED]' });
		expect(JSON.stringify(log)).not.toContain(token);
	});

	it('should preserve opaque API path identifiers and UUID request ids', () => {
		configureLogging();
		output.info.mockClear();

		const path = '/api/alerts/aB3xK9mQ2pL7zR4tY8wC';
		const requestId = '3f1c8e2a-0b1d-4a7e-9c11-abcdef012345';
		console.info('Request completed', { path, requestId });

		const log = parseLast(output.info);
		expect(log.attributes).toEqual({ path, requestId });

		const highEntropyApiId = 'Qm7_vB2nL8xW4sK9pD3aR6tY1uF5cH0z';
		const apiUrl = `https://service.example.com/api/alerts/${highEntropyApiId}`;
		console.info('Request URL', apiUrl);
		expect(parseLast(output.info).message).toBe(`Request URL ${apiUrl}`);

		console.info(`requestId=${requestId}`);
		expect(parseLast(output.info).message).toBe(`requestId=${requestId}`);

		const parenthesizedRequestIdMessage = `[RequestDeadline] 408 REQUEST_TIMEOUT (requestId=${requestId})`;
		console.warn(parenthesizedRequestIdMessage);
		expect(parseLast(output.warn).message).toBe(parenthesizedRequestIdMessage);

		const opaqueRequestId = '0123456789abcdef0123456789abcdef';
		console.info('Request metadata', { requestId: opaqueRequestId });
		expect(parseLast(output.info).attributes.requestId).toBe(opaqueRequestId);
		console.info('Request headers', { headers: { 'x-request-id': opaqueRequestId } });
		expect(parseLast(output.info).attributes.headers['x-request-id']).toBe(opaqueRequestId);
		console.info(`requestId=${opaqueRequestId}`);
		expect(parseLast(output.info).message).toBe(`requestId=${opaqueRequestId}`);

		const requestIdToken = makeHighEntropyToken();
		const overlongRequestId = requestIdToken.repeat(4) + requestIdToken.slice(0, 1);
		console.info(`requestId=${overlongRequestId}`);
		const overlongRequestLog = parseLast(output.info);
		expect(overlongRequestLog.message).toBe('requestId=[REDACTED]');
		expect(JSON.stringify(overlongRequestLog)).not.toContain(overlongRequestId);

		const requestUrl = 'https://example.com/api/alerts/3f1c8e2a-0b1d-4a7e-9c11-abcdef012345';
		console.info('Request URL', requestUrl);
		expect(parseLast(output.info).message).toBe(`Request URL ${requestUrl}`);
	});

	it('should still redact recognized credentials in request-id context', () => {
		configureLogging();
		output.info.mockClear();

		console.info('Request metadata', { requestId: 'sk-abcdef1234567890' });

		expect(parseLast(output.info).attributes.requestId).toBe('[REDACTED]');
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

