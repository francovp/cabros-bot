const { configureLogging, _resetLoggingForTests } = require('../../src/lib/logging');

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
});
