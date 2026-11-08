'use strict';

const { CircuitBreaker, CircuitBreakerError } = require('../../src/lib/circuitBreaker');

describe('CircuitBreaker', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.CIRCUIT_BREAKER_THRESHOLD;
		delete process.env.CIRCUIT_BREAKER_COOLDOWN_MS;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('state transitions', () => {
		it('initializes in CLOSED state with 0 failures', () => {
			const cb = new CircuitBreaker({ name: 'test-service' });

			expect(cb.getState()).toBe('closed');
			expect(cb.isOpen()).toBe(false);
			expect(cb.isHalfOpen()).toBe(false);
			expect(cb.isClosed()).toBe(true);
			expect(cb.canExecute()).toBe(true);

			const status = cb.getStatus();
			expect(status).toEqual({
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
				lastStateChangeAt: null,
				failureThreshold: 5,
				cooldownMs: 60000,
			});
		});

		it('stays CLOSED when failures are below threshold', () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 3 });

			cb.recordFailure(new Error('fail 1'));
			expect(cb.getState()).toBe('closed');
			expect(cb.getStatus().consecutiveFailures).toBe(1);

			cb.recordFailure(new Error('fail 2'));
			expect(cb.getState()).toBe('closed');
			expect(cb.getStatus().consecutiveFailures).toBe(2);
			expect(cb.isOpen()).toBe(false);
		});

		it('trips from CLOSED to OPEN when failures reach threshold', () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 3 });

			cb.recordFailure(new Error('fail 1'));
			cb.recordFailure(new Error('fail 2'));
			cb.recordFailure(new Error('fail 3'));

			expect(cb.getState()).toBe('open');
			expect(cb.isOpen()).toBe(true);
			expect(cb.canExecute()).toBe(false);

			const status = cb.getStatus();
			expect(status.state).toBe('open');
			expect(status.consecutiveFailures).toBe(3);
			expect(status.openedAt).not.toBeNull();
			expect(status.lastStateChangeAt).toBe(status.openedAt);
		});

		it('resets consecutive failures when a success is recorded in CLOSED state', () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 3 });

			cb.recordFailure(new Error('fail 1'));
			cb.recordFailure(new Error('fail 2'));
			expect(cb.getStatus().consecutiveFailures).toBe(2);

			cb.recordSuccess();
			expect(cb.getStatus().consecutiveFailures).toBe(0);
			expect(cb.getState()).toBe('closed');
		});

		it('transitions from OPEN to HALF-OPEN after cooldown expires', () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 2, cooldownMs: 1000 });

			cb.recordFailure(new Error('fail 1'));
			cb.recordFailure(new Error('fail 2'));
			expect(cb.getState()).toBe('open');

			// Fast forward time past cooldown
			const pastTime = Date.now() - 1500;
			cb.openedAt = new Date(pastTime).toISOString();

			expect(cb.getState()).toBe('half-open');
			expect(cb.isHalfOpen()).toBe(true);
			expect(cb.isOpen()).toBe(false);
			expect(cb.canExecute()).toBe(true);
		});

		it('transitions from HALF-OPEN to CLOSED on successful probe', () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 2, cooldownMs: 1000 });

			cb.recordFailure(new Error('fail 1'));
			cb.recordFailure(new Error('fail 2'));

			// Simulate cooldown elapsed
			cb.openedAt = new Date(Date.now() - 1500).toISOString();
			expect(cb.getState()).toBe('half-open');

			cb.recordSuccess();
			expect(cb.getState()).toBe('closed');
			expect(cb.getStatus().consecutiveFailures).toBe(0);
			expect(cb.getStatus().openedAt).toBeNull();
		});

		it('transitions from HALF-OPEN to OPEN on failed probe (restarts cooldown)', () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 2, cooldownMs: 1000 });

			cb.recordFailure(new Error('fail 1'));
			cb.recordFailure(new Error('fail 2'));

			// Simulate cooldown elapsed
			cb.openedAt = new Date(Date.now() - 1500).toISOString();
			expect(cb.getState()).toBe('half-open');

			cb.recordFailure(new Error('probe failed'));
			expect(cb.getState()).toBe('open');
			expect(cb.isOpen()).toBe(true);
			expect(cb.canExecute()).toBe(false);
		});
	});

	describe('execute helper', () => {
		it('executes operation successfully in CLOSED state', async () => {
			const cb = new CircuitBreaker({ name: 'test-service' });
			const fn = jest.fn().mockResolvedValue('ok');

			const result = await cb.execute(fn);
			expect(result).toBe('ok');
			expect(fn).toHaveBeenCalledTimes(1);
			expect(cb.getStatus().consecutiveFailures).toBe(0);
		});

		it('records failure and rethrows error when operation fails', async () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 2 });
			const error = new Error('network timeout');
			const fn = jest.fn().mockRejectedValue(error);

			await expect(cb.execute(fn)).rejects.toThrow('network timeout');
			expect(cb.getStatus().consecutiveFailures).toBe(1);
			expect(cb.getState()).toBe('closed');

			await expect(cb.execute(fn)).rejects.toThrow('network timeout');
			expect(cb.getStatus().consecutiveFailures).toBe(2);
			expect(cb.getState()).toBe('open');
		});

		it('fast-fails immediately without calling operation when OPEN', async () => {
			const cb = new CircuitBreaker({ name: 'gemini', threshold: 1 });
			const fn = jest.fn().mockResolvedValue('ok');

			cb.recordFailure(new Error('outage'));
			expect(cb.isOpen()).toBe(true);

			await expect(cb.execute(fn)).rejects.toThrow(CircuitBreakerError);
			expect(fn).not.toHaveBeenCalled();
		});

		it('allows probe execution in HALF-OPEN and closes breaker on success', async () => {
			const cb = new CircuitBreaker({ name: 'test-service', threshold: 1, cooldownMs: 500 });
			cb.recordFailure(new Error('outage'));
			expect(cb.isOpen()).toBe(true);

			// Fast-forward cooldown
			cb.openedAt = new Date(Date.now() - 1000).toISOString();
			expect(cb.getState()).toBe('half-open');

			const fn = jest.fn().mockResolvedValue('recovered');
			const result = await cb.execute(fn);

			expect(result).toBe('recovered');
			expect(cb.getState()).toBe('closed');
			expect(cb.getStatus().consecutiveFailures).toBe(0);
		});
	});

	describe('configuration', () => {
		it('reads threshold and cooldown from process.env when options omitted', () => {
			process.env.CIRCUIT_BREAKER_THRESHOLD = '8';
			process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '30000';

			const cb = new CircuitBreaker({ name: 'env-test' });
			expect(cb.getThreshold()).toBe(8);
			expect(cb.getCooldownMs()).toBe(30000);
		});

		it('uses safe defaults when process.env values are invalid', () => {
			process.env.CIRCUIT_BREAKER_THRESHOLD = 'not-a-number';
			process.env.CIRCUIT_BREAKER_COOLDOWN_MS = '-100';

			const cb = new CircuitBreaker({ name: 'invalid-env-test' });
			expect(cb.getThreshold()).toBe(5);
			expect(cb.getCooldownMs()).toBe(60000);
		});
	});
});
