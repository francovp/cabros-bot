'use strict';

/**
 * Unit tests for the alert content moderation service.
 *
 * Verifies:
 * - Denylist substring matching (case-insensitive, empty list is a no-op)
 * - Optional regex blocklist (matched, invalid pattern falls open)
 * - Universal rules: control characters, lone surrogates, identical runs
 * - Fail-open when the moderation path itself throws
 * - Counters and stats surface correctly
 * - Default disabled behavior preserves "no behavior change" acceptance
 */

jest.mock('fs', () => {
	const actual = jest.requireActual('fs');
	return actual;
});

const {
	createAlertModeration,
	resolveDenylist,
	resolveRegex,
	resolveEnabled,
	hasControlCharacters,
	hasLoneSurrogate,
	hasIdenticalRun,
	hashPayload,
} = require('../../src/services/alerts/alertModeration');

describe('alertModeration helpers', () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	describe('hasControlCharacters', () => {
		it('returns false for printable text', () => {
			expect(hasControlCharacters('BTC signal 123')).toBe(false);
		});

		it('returns true for embedded NUL', () => {
			expect(hasControlCharacters('hello\u0000world')).toBe(true);
		});

		it('allows newline, carriage return, and tab', () => {
			expect(hasControlCharacters('a\nb\rc\td')).toBe(false);
		});

		it('flags DEL (0x7f)', () => {
			expect(hasControlCharacters('hello\u007fworld')).toBe(true);
		});
	});

	describe('hasLoneSurrogate', () => {
		it('returns false for ASCII text', () => {
			expect(hasLoneSurrogate('hello world')).toBe(false);
		});

		it('returns false for paired surrogate emoji', () => {
			expect(hasLoneSurrogate('rocket 🚀 ok')).toBe(false);
		});

		it('returns true for lone high surrogate', () => {
			expect(hasLoneSurrogate('hello\uD800world')).toBe(true);
		});

		it('returns true for unpaired low surrogate', () => {
			expect(hasLoneSurrogate('hello\uDC00world')).toBe(true);
		});
	});

	describe('hasIdenticalRun', () => {
		it('returns false for short text', () => {
			expect(hasIdenticalRun('a'.repeat(199))).toBe(false);
		});

		it('returns true for 200+ identical chars', () => {
			expect(hasIdenticalRun('a'.repeat(200))).toBe(true);
		});

		it('returns true for 250 identical chars', () => {
			expect(hasIdenticalRun('a'.repeat(250))).toBe(true);
		});

		it('returns false for non-identical long text', () => {
			const text = 'a'.repeat(199) + 'b';
			expect(hasIdenticalRun(text)).toBe(false);
		});
	});

	describe('hashPayload', () => {
		it('produces deterministic 32-char hex digest', () => {
			const hash = hashPayload('hello world');
			expect(hash).toMatch(/^[0-9a-f]{32}$/);
			expect(hashPayload('hello world')).toBe(hash);
		});

		it('produces different digests for different inputs', () => {
			expect(hashPayload('hello world')).not.toBe(hashPayload('hello world!'));
		});
	});

	describe('resolveEnabled', () => {
		it('returns false when env is not set', () => {
			delete process.env.ENABLE_ALERT_MODERATION;
			expect(resolveEnabled()).toBe(false);
		});

		it('returns true when env is "true"', () => {
			process.env.ENABLE_ALERT_MODERATION = 'true';
			expect(resolveEnabled()).toBe(true);
		});

		it('returns false when env is "false"', () => {
			process.env.ENABLE_ALERT_MODERATION = 'false';
			expect(resolveEnabled()).toBe(false);
		});
	});

	describe('resolveDenylist', () => {
		it('returns empty list when env is unset', () => {
			delete process.env.ALERT_MODERATION_DENYLIST;
			delete process.env.ALERT_MODERATION_DENYLIST_FILE;
			expect(resolveDenylist()).toEqual([]);
		});

		it('parses comma-separated terms and lowercases them', () => {
			process.env.ALERT_MODERATION_DENYLIST = 'BAD, Worse, neutral';
			expect(resolveDenylist()).toEqual(['bad', 'worse', 'neutral']);
		});

		it('skips empty entries and bounds term length', () => {
			process.env.ALERT_MODERATION_DENYLIST = ',,,short,';
			expect(resolveDenylist()).toEqual(['short']);
		});
	});

	describe('resolveRegex', () => {
		it('returns null when env is unset', () => {
			delete process.env.ALERT_MODERATION_REGEX;
			expect(resolveRegex()).toBeNull();
		});

		it('returns a RegExp when env is a valid pattern', () => {
			process.env.ALERT_MODERATION_REGEX = '\\bbad\\b';
			const regex = resolveRegex();
			expect(regex).toBeInstanceOf(RegExp);
		});

		it('returns null for invalid regex', () => {
			process.env.ALERT_MODERATION_REGEX = '[unclosed';
			expect(resolveRegex()).toBeNull();
		});
	});
});

describe('createAlertModeration evaluate()', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
		process.env.ENABLE_ALERT_MODERATION = 'true';
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	it('accepts a clean alert when nothing is configured', () => {
		process.env.ALERT_MODERATION_DENYLIST = '';
		process.env.ALERT_MODERATION_REGEX = '';
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate('BTC breakout signal', { requestId: 'r1' });
		expect(verdict.rejected).toBe(false);
	});

	it('rejects a denylist match and returns the matched term', () => {
		process.env.ALERT_MODERATION_DENYLIST = 'banana,evil';
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate('contains banana here', { requestId: 'r2' });
		expect(verdict.rejected).toBe(true);
		expect(verdict.reason).toBe('denylist');
		expect(verdict.matched).toBe('banana');
	});

	it('rejects a regex match', () => {
		process.env.ALERT_MODERATION_REGEX = '\\bbadword\\b';
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate('this is a badword hit', { requestId: 'r3' });
		expect(verdict.rejected).toBe(true);
		expect(verdict.reason).toBe('regex');
		expect(verdict.matched).toBe('badword');
	});

	it('rejects payloads with control characters', () => {
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate('hello\u0001world', { requestId: 'r4' });
		expect(verdict.rejected).toBe(true);
		expect(verdict.reason).toBe('control_characters');
	});

	it('rejects payloads with lone surrogates', () => {
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate('hello\uD800world', { requestId: 'r5' });
		expect(verdict.rejected).toBe(true);
		expect(verdict.reason).toBe('lone_surrogate');
	});

	it('rejects payloads with 200+ identical chars', () => {
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate('a'.repeat(250), { requestId: 'r6' });
		expect(verdict.rejected).toBe(true);
		expect(verdict.reason).toBe('identical_run');
	});

	it('returns rejected=false for empty text without throwing', () => {
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate('', { requestId: 'r7' });
		expect(verdict.rejected).toBe(false);
	});

	it('returns rejected=false for non-string input without throwing', () => {
		const mod = createAlertModeration();
		mod.refreshConfig();
		const verdict = mod.evaluate(undefined, { requestId: 'r8' });
		expect(verdict.rejected).toBe(false);
	});

	it('fails open when the evaluation path itself throws', () => {
		const mod = createAlertModeration();
		// Inject a throwing denylist iteration to force the inner try/catch
		Object.defineProperty(mod._state, 'denylist', {
			get() {
				throw new Error('boom');
			},
		});
		const verdict = mod.evaluate('hello world', { requestId: 'r9' });
		expect(verdict.rejected).toBe(false);
		expect(verdict.failOpen).toBe(true);
	});
});

describe('createAlertModeration counters', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
		process.env.ENABLE_ALERT_MODERATION = 'true';
		process.env.ALERT_MODERATION_REGEX = '';
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	it('increments accepted counter on a clean payload', () => {
		process.env.ALERT_MODERATION_DENYLIST = '';
		const mod = createAlertModeration();
		mod.refreshConfig();
		mod.evaluate('clean', { requestId: 's1' });
		mod.evaluate('also clean', { requestId: 's2' });
		const stats = mod.getStats();
		expect(stats.accepted).toBe(2);
		expect(stats.rejected).toBe(0);
	});

	it('increments rejected counter and lastRejectedAt on a hit', () => {
		process.env.ALERT_MODERATION_DENYLIST = 'banana';
		const mod = createAlertModeration();
		mod.refreshConfig();
		mod.evaluate('contains banana', { requestId: 's3' });
		const stats = mod.getStats();
		expect(stats.rejected).toBe(1);
		expect(stats.lastRejectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it('increments regexMatches counter for regex rejections', () => {
		process.env.ALERT_MODERATION_REGEX = 'foo';
		const mod = createAlertModeration();
		mod.refreshConfig();
		mod.evaluate('hit foo here', { requestId: 's4' });
		const stats = mod.getStats();
		expect(stats.regexMatches).toBe(1);
	});

	it('reset() clears all counters', () => {
		process.env.ALERT_MODERATION_DENYLIST = 'banana';
		const mod = createAlertModeration();
		mod.refreshConfig();
		mod.evaluate('banana', { requestId: 's5' });
		mod.reset();
		const stats = mod.getStats();
		expect(stats.accepted).toBe(0);
		expect(stats.rejected).toBe(0);
		expect(stats.regexMatches).toBe(0);
		expect(stats.lastRejectedAt).toBeNull();
	});
});

describe('default behavior is opt-in (no behavior change)', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	it('returns isEnabled=false when ENABLE_ALERT_MODERATION is not set', () => {
		delete process.env.ENABLE_ALERT_MODERATION;
		const { alertModeration: singleton } = require('../../src/services/alerts/alertModeration');
		expect(singleton.isEnabled()).toBe(false);
	});
});
