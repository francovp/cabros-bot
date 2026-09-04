'use strict';

const crypto = require('crypto');

describe('startupJitter', () => {
	const ORIGINAL_ENV = { ...process.env };
	const ORIGINAL_RANDOM_INT = crypto.randomInt;

	beforeEach(() => {
		jest.resetModules();
		process.env = { ...ORIGINAL_ENV };
		delete process.env.WORKER_STARTUP_JITTER_MS;
		delete process.env.SIGNAL_OUTCOME_WORKER_STARTUP_JITTER_MS;
		delete process.env.NOTIFICATION_REDRIVE_WORKER_STARTUP_JITTER_MS;
		delete process.env.SCANNER_PRESET_SCHEDULER_STARTUP_JITTER_MS;
		delete process.env.REMOTE_CONFIG_REFRESH_JITTER_MS;
	});

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
		crypto.randomInt = ORIGINAL_RANDOM_INT;
	});

	function loadModule() {
		return require('../../src/lib/startupJitter');
	}

	describe('resolveStartupJitterMs', () => {
		it('returns the default when env and runtime are absent', () => {
			const { resolveStartupJitterMs } = loadModule();
			expect(resolveStartupJitterMs({ envVar: 'WORKER_STARTUP_JITTER_MS', defaultValue: 5000 })).toBe(5000);
		});

		it('honors a numeric env override', () => {
			process.env.WORKER_STARTUP_JITTER_MS = '7500';
			const { resolveStartupJitterMs } = loadModule();
			expect(resolveStartupJitterMs({ envVar: 'WORKER_STARTUP_JITTER_MS' })).toBe(7500);
		});

		it('honors a numeric env override with a runtime key', () => {
			process.env.SIGNAL_OUTCOME_WORKER_STARTUP_JITTER_MS = '1234';
			const { resolveStartupJitterMs } = loadModule();
			expect(resolveStartupJitterMs({
				envVar: 'SIGNAL_OUTCOME_WORKER_STARTUP_JITTER_MS',
				runtimeKey: 'SIGNAL_OUTCOME_WORKER_STARTUP_JITTER_MS',
			})).toBe(1234);
		});

		it('clamps the env override above the maximum', () => {
			process.env.WORKER_STARTUP_JITTER_MS = '60000';
			const { resolveStartupJitterMs, MAX_JITTER_MS } = loadModule();
			expect(resolveStartupJitterMs({ envVar: 'WORKER_STARTUP_JITTER_MS' })).toBe(MAX_JITTER_MS);
		});

		it('clamps the env override below zero', () => {
			process.env.WORKER_STARTUP_JITTER_MS = '-5';
			const { resolveStartupJitterMs, MIN_JITTER_MS } = loadModule();
			expect(resolveStartupJitterMs({ envVar: 'WORKER_STARTUP_JITTER_MS' })).toBe(MIN_JITTER_MS);
		});

		it('falls back to the default when env is a non-numeric string', () => {
			process.env.WORKER_STARTUP_JITTER_MS = 'not-a-number';
			const { resolveStartupJitterMs } = loadModule();
			expect(resolveStartupJitterMs({ envVar: 'WORKER_STARTUP_JITTER_MS', defaultValue: 5000 })).toBe(5000);
		});

		it('returns the schema default when env is whitespace-only and the runtime key is also a schema key', () => {
			process.env.WORKER_STARTUP_JITTER_MS = '   ';
			const { resolveStartupJitterMs } = loadModule();
			const result = resolveStartupJitterMs({ envVar: 'WORKER_STARTUP_JITTER_MS', defaultValue: 1234 });
			expect([0, 1234, 5000]).toContain(result);
		});

		it('uses defaultValue when env is undefined and runtime key is also absent', () => {
			const { resolveStartupJitterMs } = loadModule();
			expect(resolveStartupJitterMs({
				envVar: 'UNSET_ENV_VAR_XYZ',
				runtimeKey: 'UNSET_RUNTIME_KEY_XYZ',
				defaultValue: 4321,
			})).toBe(4321);
		});
	});

	describe('applyStartupJitter', () => {
		it('returns 0 without waiting when maxJitterMs is zero', async () => {
			const { applyStartupJitter } = loadModule();
			await expect(applyStartupJitter(0)).resolves.toBe(0);
		});

		it('returns 0 without waiting when maxJitterMs is negative', async () => {
			const { applyStartupJitter } = loadModule();
			await expect(applyStartupJitter(-1)).resolves.toBe(0);
		});

		it('returns 0 without waiting when maxJitterMs is non-finite', async () => {
			const { applyStartupJitter } = loadModule();
			await expect(applyStartupJitter(Number.NaN)).resolves.toBe(0);
			await expect(applyStartupJitter(Number.POSITIVE_INFINITY)).resolves.toBe(0);
		});

		it('clamps maxJitterMs above the maximum', async () => {
			crypto.randomInt = jest.fn().mockReturnValue(0);
			const { applyStartupJitter } = loadModule();
			const start = Date.now();
			const delay = await applyStartupJitter(999999);
			expect(delay).toBe(0);
			expect(Date.now() - start).toBeLessThan(50);
		});

		it('uses crypto.randomInt under the requested bound', async () => {
			const randomInt = jest.fn().mockReturnValue(1234);
			crypto.randomInt = randomInt;
			const { applyStartupJitter } = loadModule();
			const delay = await applyStartupJitter(5000);
			expect(delay).toBe(1234);
			expect(randomInt).toHaveBeenCalledWith(0, 5001);
		});

		it('does not wait when crypto.randomInt returns zero', async () => {
			crypto.randomInt = jest.fn().mockReturnValue(0);
			const { applyStartupJitter } = loadModule();
			const start = Date.now();
			const delay = await applyStartupJitter(5000);
			expect(delay).toBe(0);
			expect(Date.now() - start).toBeLessThan(20);
		});

		it('actually waits for the returned delay when crypto.randomInt is large', async () => {
			crypto.randomInt = jest.fn().mockReturnValue(150);
			const { applyStartupJitter } = loadModule();
			const start = Date.now();
			const delay = await applyStartupJitter(200);
			const elapsed = Date.now() - start;
			expect(delay).toBe(150);
			expect(elapsed).toBeGreaterThanOrEqual(100);
		});
	});

	describe('clampJitter', () => {
		it('returns 0 for non-finite and below-minimum values', () => {
			const { clampJitter, MIN_JITTER_MS } = loadModule();
			expect(clampJitter(Number.NaN)).toBe(MIN_JITTER_MS);
			expect(clampJitter(Number.POSITIVE_INFINITY)).toBe(MIN_JITTER_MS);
			expect(clampJitter(-1)).toBe(MIN_JITTER_MS);
		});

		it('returns the maximum for above-maximum values', () => {
			const { clampJitter, MAX_JITTER_MS } = loadModule();
			expect(clampJitter(99999)).toBe(MAX_JITTER_MS);
		});

		it('floors finite within-range values', () => {
			const { clampJitter } = loadModule();
			expect(clampJitter(1234.9)).toBe(1234);
			expect(clampJitter(0)).toBe(0);
			expect(clampJitter(5000)).toBe(5000);
		});
	});
});