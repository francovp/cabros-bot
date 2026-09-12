/* global jest, describe, it, beforeEach, afterEach, expect */

const path = require('path');

const MODULE_PATH = path.resolve(__dirname, '../../src/controllers/webhooks/handlers/message/message.js');

function loadModule(env = {}) {
	jest.resetModules();
	const previous = {};
	for (const [key, value] of Object.entries(env)) {
		previous[key] = Object.prototype.hasOwnProperty.call(process.env, key)
			? process.env[key]
			: undefined;
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	const mod = require(MODULE_PATH);
	return {
		mod,
		restore() {
			for (const [key, original] of Object.entries(previous)) {
				if (original === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = original;
				}
			}
		},
	};
}

describe('POST /api/webhook/message - truncation helpers', () => {
	describe('buildTruncatedText', () => {
		let mod;
		let restore;

		beforeEach(() => {
			({ mod, restore } = loadModule());
		});

		afterEach(() => {
			restore();
		});

		it('returns a sliced message plus the truncation marker', () => {
			const message = 'a'.repeat(50);
			const truncated = mod.buildTruncatedText(message, 10);
			expect(truncated).toBe('a'.repeat(10) + '...');
			expect(truncated.length).toBe(13);
		});
	});

	describe('validateMessageRequest', () => {
		let mod;
		let restore;

		beforeEach(() => {
			({ mod, restore } = loadModule());
		});

		afterEach(() => {
			restore();
		});

		it('returns truncated=false and matching lengths for inputs at or under the default limit', () => {
			const message = 'hello world';
			const result = mod.validateMessageRequest({ message });
			expect(result.truncated).toBe(false);
			expect(result.originalLength).toBe(message.length);
			expect(result.messageLength).toBe(message.length);
			expect(result.maxMessageLength).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH);
			expect(result.text).toBe(message);
		});

		it('returns truncated=true and exposes the original length when input exceeds the limit', () => {
			const message = 'a'.repeat(mod.DEFAULT_MAX_MESSAGE_LENGTH + 200);
			const result = mod.validateMessageRequest({ message });
			expect(result.truncated).toBe(true);
			expect(result.originalLength).toBe(message.length);
			expect(result.messageLength).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH + 3);
			expect(result.maxMessageLength).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH);
			expect(result.text.endsWith('...')).toBe(true);
		});

		it('uses GENERIC_MESSAGE_MAX_LENGTH when provided within range', () => {
			const previous = process.env.GENERIC_MESSAGE_MAX_LENGTH;
			process.env.GENERIC_MESSAGE_MAX_LENGTH = '200';
			try {
				const result = mod.validateMessageRequest({ message: 'a'.repeat(250) });
				expect(result.truncated).toBe(true);
				expect(result.maxMessageLength).toBe(200);
				expect(result.messageLength).toBe(203);
				expect(result.originalLength).toBe(250);
			} finally {
				if (previous === undefined) {
					delete process.env.GENERIC_MESSAGE_MAX_LENGTH;
				} else {
					process.env.GENERIC_MESSAGE_MAX_LENGTH = previous;
				}
			}
		});

		it('honors an explicit safe-integer maxMessageLength override option', () => {
			const result = mod.validateMessageRequest({ message: 'a'.repeat(120) }, { maxMessageLength: 100 });
			expect(result.truncated).toBe(true);
			expect(result.maxMessageLength).toBe(100);
			expect(result.messageLength).toBe(103);
			expect(result.originalLength).toBe(120);
		});

		it('ignores out-of-range option.maxMessageLength values', () => {
			const result = mod.validateMessageRequest({ message: 'a'.repeat(120) }, { maxMessageLength: 0 });
			expect(result.maxMessageLength).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH);
			expect(result.truncated).toBe(false);
		});

		it('falls back to the default when GENERIC_MESSAGE_MAX_LENGTH is malformed', () => {
			const previous = process.env.GENERIC_MESSAGE_MAX_LENGTH;
			process.env.GENERIC_MESSAGE_MAX_LENGTH = 'not-a-number';
			try {
				const result = mod.validateMessageRequest({ message: 'a'.repeat(120) });
				expect(result.maxMessageLength).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH);
			} finally {
				if (previous === undefined) {
					delete process.env.GENERIC_MESSAGE_MAX_LENGTH;
				} else {
					process.env.GENERIC_MESSAGE_MAX_LENGTH = previous;
				}
			}
		});

		it('falls back to the default when GENERIC_MESSAGE_MAX_LENGTH is out of range', () => {
			const previous = process.env.GENERIC_MESSAGE_MAX_LENGTH;
			process.env.GENERIC_MESSAGE_MAX_LENGTH = '50000';
			try {
				const result = mod.validateMessageRequest({ message: 'a'.repeat(120) });
				expect(result.maxMessageLength).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH);
			} finally {
				if (previous === undefined) {
					delete process.env.GENERIC_MESSAGE_MAX_LENGTH;
				} else {
					process.env.GENERIC_MESSAGE_MAX_LENGTH = previous;
				}
			}
		});

		it('throws the routing validation error when the message is missing', () => {
			expect(() => mod.validateMessageRequest({})).toThrow(/message/);
		});
	});

	describe('getMaxMessageLength', () => {
		it('returns the default when env var is absent', () => {
			const previous = process.env.GENERIC_MESSAGE_MAX_LENGTH;
			delete process.env.GENERIC_MESSAGE_MAX_LENGTH;
			try {
				jest.resetModules();
				const mod = require(MODULE_PATH);
				expect(mod.getMaxMessageLength()).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH);
			} finally {
				if (previous !== undefined) {
					process.env.GENERIC_MESSAGE_MAX_LENGTH = previous;
				}
			}
		});

		it('returns the parsed integer when env var is a safe positive integer', () => {
			const previous = process.env.GENERIC_MESSAGE_MAX_LENGTH;
			process.env.GENERIC_MESSAGE_MAX_LENGTH = '8192';
			try {
				jest.resetModules();
				const mod = require(MODULE_PATH);
				expect(mod.getMaxMessageLength()).toBe(8192);
			} finally {
				if (previous === undefined) {
					delete process.env.GENERIC_MESSAGE_MAX_LENGTH;
				} else {
					process.env.GENERIC_MESSAGE_MAX_LENGTH = previous;
				}
			}
		});

		it('falls back to the default when env var exceeds the upper bound', () => {
			const previous = process.env.GENERIC_MESSAGE_MAX_LENGTH;
			process.env.GENERIC_MESSAGE_MAX_LENGTH = '999999';
			try {
				jest.resetModules();
				const mod = require(MODULE_PATH);
				expect(mod.getMaxMessageLength()).toBe(mod.DEFAULT_MAX_MESSAGE_LENGTH);
			} finally {
				if (previous === undefined) {
					delete process.env.GENERIC_MESSAGE_MAX_LENGTH;
				} else {
					process.env.GENERIC_MESSAGE_MAX_LENGTH = previous;
				}
			}
		});
	});
});