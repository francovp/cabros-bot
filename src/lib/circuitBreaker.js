'use strict';

const STATES = Object.freeze({
	CLOSED: 'closed',
	OPEN: 'open',
	HALF_OPEN: 'half-open',
});

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 60000;

class CircuitBreakerError extends Error {
	constructor(message = 'Circuit breaker is OPEN') {
		super(message);
		this.name = 'CircuitBreakerError';
		this.code = 'CIRCUIT_BREAKER_OPEN';
		this.category = 'circuit_breaker_open';
		this.status = 503;
		this.statusCode = 503;
	}
}

function getRemoteConfigValues() {
	try {
		const { getRuntimeConfig } = require('../services/remoteConfig/RemoteConfigService');
		return typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : {};
	} catch (_) {
		return {};
	}
}

class CircuitBreaker {
	constructor(options = {}) {
		this.name = options.name || 'default';
		this.customThreshold = options.threshold;
		this.customCooldownMs = options.cooldownMs;
		this.logger = options.logger || console;

		this.state = STATES.CLOSED;
		this.consecutiveFailures = 0;
		this.openedAt = null;
		this.lastStateChangeAt = null;
		this.isProbeInFlight = false;
	}

	getThreshold() {
		if (Number.isSafeInteger(this.customThreshold) && this.customThreshold > 0) {
			return this.customThreshold;
		}

		const rc = getRemoteConfigValues();
		if (Number.isSafeInteger(rc.CIRCUIT_BREAKER_THRESHOLD) && rc.CIRCUIT_BREAKER_THRESHOLD > 0) {
			return rc.CIRCUIT_BREAKER_THRESHOLD;
		}

		const envVal = Number(process.env.CIRCUIT_BREAKER_THRESHOLD);
		if (Number.isSafeInteger(envVal) && envVal > 0) {
			return envVal;
		}

		return DEFAULT_FAILURE_THRESHOLD;
	}

	getCooldownMs() {
		if (Number.isSafeInteger(this.customCooldownMs) && this.customCooldownMs > 0) {
			return this.customCooldownMs;
		}

		const rc = getRemoteConfigValues();
		if (Number.isSafeInteger(rc.CIRCUIT_BREAKER_COOLDOWN_MS) && rc.CIRCUIT_BREAKER_COOLDOWN_MS > 0) {
			return rc.CIRCUIT_BREAKER_COOLDOWN_MS;
		}

		const envVal = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS);
		if (Number.isSafeInteger(envVal) && envVal > 0) {
			return envVal;
		}

		return DEFAULT_COOLDOWN_MS;
	}

	getState() {
		if (this.state === STATES.OPEN) {
			const cooldownMs = this.getCooldownMs();
			const openedTime = this.openedAt ? new Date(this.openedAt).getTime() : 0;
			if (Date.now() - openedTime >= cooldownMs) {
				this.state = STATES.HALF_OPEN;
				this.lastStateChangeAt = new Date().toISOString();
				this.isProbeInFlight = false;
			}
		}
		return this.state;
	}

	isOpen() {
		return this.getState() === STATES.OPEN;
	}

	isHalfOpen() {
		return this.getState() === STATES.HALF_OPEN;
	}

	isClosed() {
		return this.getState() === STATES.CLOSED;
	}

	canExecute() {
		const state = this.getState();
		if (state === STATES.CLOSED) {
			return true;
		}
		if (state === STATES.HALF_OPEN) {
			if (!this.isProbeInFlight) {
				this.isProbeInFlight = true;
				return true;
			}
			return false;
		}
		return false;
	}

	recordSuccess() {
		this.consecutiveFailures = 0;
		this.isProbeInFlight = false;
		if (this.state !== STATES.CLOSED) {
			this.state = STATES.CLOSED;
			this.openedAt = null;
			this.lastStateChangeAt = new Date().toISOString();
		}
	}

	recordFailure(error) {
		this.isProbeInFlight = false;
		this.consecutiveFailures += 1;
		const threshold = this.getThreshold();
		const currentState = this.getState();

		if (this.consecutiveFailures >= threshold || currentState === STATES.HALF_OPEN) {
			this.state = STATES.OPEN;
			this.openedAt = new Date().toISOString();
			this.lastStateChangeAt = this.openedAt;
		}
	}

	async execute(fn) {
		if (!this.canExecute()) {
			throw new CircuitBreakerError(`Circuit breaker for ${this.name} is OPEN`);
		}

		try {
			const result = await fn();
			this.recordSuccess();
			return result;
		} catch (error) {
			if (error instanceof CircuitBreakerError) {
				throw error;
			}
			this.recordFailure(error);
			throw error;
		}
	}

	getStatus() {
		const state = this.getState();
		return {
			state,
			consecutiveFailures: this.consecutiveFailures,
			openedAt: this.openedAt,
			lastStateChangeAt: this.lastStateChangeAt,
			failureThreshold: this.getThreshold(),
			cooldownMs: this.getCooldownMs(),
		};
	}

	reset() {
		this.state = STATES.CLOSED;
		this.consecutiveFailures = 0;
		this.openedAt = null;
		this.lastStateChangeAt = null;
		this.isProbeInFlight = false;
	}
}

module.exports = {
	CircuitBreaker,
	CircuitBreakerError,
	STATES,
};
