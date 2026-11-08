'use strict';

const sentryService = require('../monitoring/SentryService');
const { redactString } = require('../../lib/logging');
const {
  FIRESTORE_ERROR_CATEGORIES,
	classifyFirestoreError,
  isFirestoreErrorCategory,
} = require('./firestoreErrorCategories');

const PERSISTENT_WRITE_DOMAINS = Object.freeze([
	'alertStorage',
	'signalOutcomes',
	'notificationRedrive',
	'newsDedup',
]);
const PERSISTENT_WRITE_DOMAIN_SET = new Set(PERSISTENT_WRITE_DOMAINS);
const PERSISTENT_WRITE_HISTORY_LIMIT = 100;
const PERSISTENT_WRITE_STATUS_FAILURE_RATE = 0.05;
const PERSISTENT_WRITE_STATUS_RECENT_FAILURE_MS = 5 * 60 * 1000;
const PERSISTENT_WRITE_SENTRY_ATTEMPTS = 50;
const PERSISTENT_WRITE_SENTRY_FAILURE_RATE = 0.2;
const PERSISTENT_WRITE_ERROR_MESSAGE_LIMIT = 120;

const PERSISTENT_ERROR_CATEGORY_BY_FIRESTORE_CATEGORY = Object.freeze({
	permission_denied: 'firestore_permission_denied',
	unauthenticated: 'firestore_permission_denied',
	unavailable: 'firestore_unavailable',
	deadline_exceeded: 'firestore_unavailable',
	resource_exhausted: 'firestore_unavailable',
	invalid_argument: 'firestore_malformed',
	failed_precondition: 'firestore_malformed',
});

/**
 * FirestoreWriteMetricsService
 *
 * In-memory write-success/failure counters for Firestore persistence paths
 * (AlertStorageService, JobRepository, etc.). Counters reset on process restart
 * and never block writes — fail-open only. Intended for operational observability
 * so a silent persistence failure does not look like "Firestore ready" on
 * /api/status.
 *
 * Mirrors the DeliveryMetricsService pattern (per-domain keys, getSnapshot()
 * returning null when empty).
 *
 * Issue #1285 added a parallel *read* counter set. It is deliberately a separate
 * snapshot rather than extra fields on `getSnapshot()`: `firestoreWriteMetrics`
 * is a documented contract with its own coverage, and folding reads into it
 * would change its shape for every existing consumer. Read health is what turned
 * out to be observability-blind in #1285 — writes succeeded while every read
 * query was rejected — so it needed to be independently reportable and to be
 * able to drive `dependencies.firestore.ready` to false.
 */

/**
 * Read health states. `unknown` is deliberately distinct from `healthy`:
 * before any read is observed there is no evidence about the read path, and
 * reporting that as healthy is what made #1285 look like a healthy deployment.
 * It is not a failure either, since freshly-enabled storage is not broken.
 */
const READ_HEALTH = Object.freeze({
	UNKNOWN: 'unknown',
	HEALTHY: 'healthy',
	DEGRADED: 'degraded',
});

class FirestoreWriteMetricsService {
  constructor() {
    this.windowStartedAt = Date.now();
    // Map<domain, { success: number, failure: number }>
    this.domainCounters = new Map();
    // Map<domain, { success: number, failure: number }> for read paths.
    this.readCounters = new Map();
    this.readConsecutiveFailures = 0;
    this.lastReadAt = null;
    this.lastReadFailureAt = null;
    this.lastReadErrorCategory = null;
	this.persistentWriteDomains = this._createPersistentWriteDomains();
  }

	_createPersistentWriteDomains() {
		return new Map(PERSISTENT_WRITE_DOMAINS.map((domain) => [domain, {
			success: 0,
			failure: 0,
			attempts: [],
			lastSuccessAt: null,
			lastFailureAt: null,
			lastFailureCategory: null,
			lastFailureMessage: null,
			activeIncidents: new Set(),
		}]));
	}

	_persistentErrorCategory(error) {
		let category = FIRESTORE_ERROR_CATEGORIES.UNKNOWN;
		try {
			category = classifyFirestoreError(error);
		} catch {
			return 'unknown';
		}
		return PERSISTENT_ERROR_CATEGORY_BY_FIRESTORE_CATEGORY[category] || 'unknown';
	}

	_sanitizePersistentErrorMessage(error) {
		let message = null;
		if (typeof error === 'string') {
			message = error;
		} else if (error && typeof error.message === 'string') {
			message = error.message;
		}
		if (!message) {
			return null;
		}
		try {
			return redactString(message).slice(0, PERSISTENT_WRITE_ERROR_MESSAGE_LIMIT);
		} catch {
			return '[REDACTED]';
		}
	}

	_persistentFailureRate(state, limit = PERSISTENT_WRITE_HISTORY_LIMIT) {
		const attempts = state.attempts.slice(-limit);
		if (attempts.length === 0) {
			return 0;
		}
		return attempts.filter((attempt) => !attempt.success).length / attempts.length;
	}

	_recordPersistentWriteAttempt(domain, success, error = null) {
		if (!PERSISTENT_WRITE_DOMAIN_SET.has(domain)) {
			return;
		}
		const state = this.persistentWriteDomains.get(domain);
		const timestamp = new Date().toISOString();
		if (success) {
			state.success += 1;
			state.lastSuccessAt = timestamp;
		} else {
			state.failure += 1;
			state.lastFailureAt = timestamp;
			state.lastFailureCategory = this._persistentErrorCategory(error);
			state.lastFailureMessage = this._sanitizePersistentErrorMessage(error);
		}
		state.attempts.push({ success, category: success ? null : state.lastFailureCategory, timestamp });
		if (state.attempts.length > PERSISTENT_WRITE_HISTORY_LIMIT) {
			state.attempts.splice(0, state.attempts.length - PERSISTENT_WRITE_HISTORY_LIMIT);
		}
		this._updatePersistentWriteIncident(domain, state);
	}

	_updatePersistentWriteIncident(domain, state) {
		const recentAttempts = state.attempts.slice(-PERSISTENT_WRITE_SENTRY_ATTEMPTS);
		if (recentAttempts.length < PERSISTENT_WRITE_SENTRY_ATTEMPTS) {
			return;
		}
		const failures = recentAttempts.filter((attempt) => !attempt.success);
		const failureRate = failures.length / recentAttempts.length;
		if (failureRate <= PERSISTENT_WRITE_SENTRY_FAILURE_RATE) {
			state.activeIncidents.clear();
			return;
		}

		const category = failures[failures.length - 1]?.category || 'unknown';
		if (state.activeIncidents.has(category)) {
			return;
		}
		state.activeIncidents.add(category);
		try {
			sentryService.captureEvent({
				event: {
					type: 'external_failure',
					channel: domain,
					feature: 'persistent-write-health',
					message: 'Persistent Firestore write failure threshold exceeded',
					external: {
						provider: 'firestore',
						lastErrorCode: category,
					},
					extra: {
						failureRate,
						attempts: recentAttempts.length,
						failures: failures.length,
					},
				},
			});
		} catch {
			// Monitoring failures never affect persistence or alert delivery.
		}
	}

	recordPersistentWriteSuccess(domain) {
		try {
			this._recordPersistentWriteAttempt(domain, true);
		} catch {
			// Metrics are deliberately fail-open.
		}
	}

	recordPersistentWriteFailure(domain, error) {
		try {
			this._recordPersistentWriteAttempt(domain, false, error);
		} catch {
			// Metrics are deliberately fail-open.
		}
	}

	getPersistentWriteHealthSnapshot() {
		const now = Date.now();
		const byDomain = {};
		for (const domain of PERSISTENT_WRITE_DOMAINS) {
			const state = this.persistentWriteDomains.get(domain);
			const attempts = state.attempts;
			const failureRate = this._persistentFailureRate(state);
			const recentFailure = state.lastFailureAt
				&& now - Date.parse(state.lastFailureAt) <= PERSISTENT_WRITE_STATUS_RECENT_FAILURE_MS;
			let status = 'unconfigured';
			if (attempts.length > 0) {
				status = failureRate > PERSISTENT_WRITE_STATUS_FAILURE_RATE || recentFailure ? 'degraded' : 'ok';
			}
			byDomain[domain] = {
				success: state.success,
				failure: state.failure,
				failureRate,
				lastSuccessAt: state.lastSuccessAt,
				lastFailureAt: state.lastFailureAt,
				lastFailureCategory: state.lastFailureCategory,
				status,
			};
		}
		return {
			window: {
				startedAt: new Date(this.windowStartedAt).toISOString(),
				durationMs: now - this.windowStartedAt,
			},
			byDomain,
		};
	}

  _ensureDomain(domain) {
    let counters = this.domainCounters.get(domain);
    if (!counters) {
      counters = { success: 0, failure: 0 };
      this.domainCounters.set(domain, counters);
    }
    return counters;
  }

  _ensureReadDomain(domain) {
    let counters = this.readCounters.get(domain);
    if (!counters) {
      counters = { success: 0, failure: 0 };
      this.readCounters.set(domain, counters);
    }
    return counters;
  }

  /**
   * Record a successful Firestore write for the given domain.
   * Fail-open: malformed input never throws so metric recording cannot
   * accidentally block the underlying fire-and-forget write path.
   */
  recordWriteSuccess(domain) {
    try {
      if (typeof domain !== 'string' || domain.length === 0) {
        return;
      }
      this._ensureDomain(domain).success += 1;
      sentryService.captureFirestoreWriteMetric({ domain, status: 'success' });
    } catch (error) {
      console.warn('[FirestoreWriteMetricsService] recordWriteSuccess failed:', error.message);
    }
  }

  /**
   * Record a failed Firestore write for the given domain. The error category
   * is intentionally NOT recorded here — callers should keep error details
   * inside their own logs to avoid leaking sensitive content into /api/status.
   */
  recordWriteFailure(domain) {
    try {
      if (typeof domain !== 'string' || domain.length === 0) {
        return;
      }
      this._ensureDomain(domain).failure += 1;
      sentryService.captureFirestoreWriteMetric({ domain, status: 'failure' });
    } catch (error) {
      console.warn('[FirestoreWriteMetricsService] recordWriteFailure failed:', error.message);
    }
  }

  /**
   * Returns null when no writes have been recorded yet so callers can omit
   * the key entirely from /api/status (matches DeliveryMetricsService).
   * Returns:
   *   {
   *     window: { startedAt: ISO-8601, durationMs },
   *     writesAttempted,
   *     writesSucceeded,
   *     writesFailed,
   *     successRate (0..1),
   *     byDomain: { [domain]: { success, failure, total, successRate } }
   *   }
   */
  getSnapshot() {
    let totalSuccess = 0;
    let totalFailure = 0;
    const byDomain = {};
    for (const [domain, counters] of this.domainCounters.entries()) {
      const total = counters.success + counters.failure;
      byDomain[domain] = {
        success: counters.success,
        failure: counters.failure,
        total,
        successRate: total > 0 ? counters.success / total : null,
      };
      totalSuccess += counters.success;
      totalFailure += counters.failure;
    }
    const total = totalSuccess + totalFailure;
    if (total === 0) {
      return null;
    }
    return {
      window: {
        startedAt: new Date(this.windowStartedAt).toISOString(),
        durationMs: Date.now() - this.windowStartedAt,
      },
      writesAttempted: total,
      writesSucceeded: totalSuccess,
      writesFailed: totalFailure,
      successRate: total > 0 ? totalSuccess / total : null,
      byDomain,
    };
  }

  /**
   * Record a successful Firestore read for the given domain.
   *
   * A success clears the consecutive-failure streak, so read health recovers on
   * its own once the underlying problem is fixed without a process restart.
   */
  recordReadSuccess(domain) {
    try {
      if (typeof domain !== 'string' || domain.length === 0) {
        return;
      }
      this._ensureReadDomain(domain).success += 1;
      this.readConsecutiveFailures = 0;
      this.lastReadAt = new Date().toISOString();
    } catch (error) {
      console.warn('[FirestoreWriteMetricsService] recordReadSuccess failed:', error.message);
    }
  }

  /**
   * Record a failed Firestore read, with a sanitized category so /api/status can
   * distinguish credential/init failure from a rejected query without log access.
   */
  recordReadFailure(domain, category) {
    try {
      if (typeof domain !== 'string' || domain.length === 0) {
        return;
      }
      this._ensureReadDomain(domain).failure += 1;
      this.readConsecutiveFailures += 1;
      this.lastReadAt = new Date().toISOString();
      this.lastReadFailureAt = this.lastReadAt;
      this.lastReadErrorCategory = isFirestoreErrorCategory(category)
        ? category
        : FIRESTORE_ERROR_CATEGORIES.UNKNOWN;
      sentryService.captureFirestoreWriteMetric({ domain, status: 'read_failure' });
    } catch (error) {
      console.warn('[FirestoreWriteMetricsService] recordReadFailure failed:', error.message);
    }
  }

  /**
   * Returns null until at least one read has been recorded, so the status key
   * stays absent rather than reporting an empty read history as evidence.
   *
   * `readHealth` is the field that lets `dependencies.firestore.ready` reflect
   * the read path rather than only write/init success (#1285).
   */
  getReadSnapshot() {
    let totalSuccess = 0;
    let totalFailure = 0;
    const byDomain = {};
    for (const [domain, counters] of this.readCounters.entries()) {
      const total = counters.success + counters.failure;
      byDomain[domain] = {
        success: counters.success,
        failure: counters.failure,
        total,
        successRate: total > 0 ? counters.success / total : null,
      };
      totalSuccess += counters.success;
      totalFailure += counters.failure;
    }
    const total = totalSuccess + totalFailure;
    if (total === 0) {
      return null;
    }
    let readHealth = READ_HEALTH.UNKNOWN;
    if (this.readConsecutiveFailures > 0) {
      readHealth = READ_HEALTH.DEGRADED;
    } else if (totalSuccess > 0) {
      readHealth = READ_HEALTH.HEALTHY;
    }
    return {
      window: {
        startedAt: new Date(this.windowStartedAt).toISOString(),
        durationMs: Date.now() - this.windowStartedAt,
      },
      readsAttempted: total,
      readsSucceeded: totalSuccess,
      readsFailed: totalFailure,
      successRate: total > 0 ? totalSuccess / total : null,
      readHealth,
      consecutiveReadFailures: this.readConsecutiveFailures,
      lastReadAt: this.lastReadAt,
      lastReadFailureAt: this.lastReadFailureAt,
      lastErrorCategory: this.lastReadErrorCategory,
      byDomain,
    };
  }

  resetForTesting() {
    this.domainCounters.clear();
    this.readCounters.clear();
    this.readConsecutiveFailures = 0;
    this.lastReadAt = null;
    this.lastReadFailureAt = null;
    this.lastReadErrorCategory = null;
    this.windowStartedAt = Date.now();
	this.persistentWriteDomains = this._createPersistentWriteDomains();
  }
}

const firestoreWriteMetricsService = new FirestoreWriteMetricsService();

module.exports = {
  FirestoreWriteMetricsService,
  READ_HEALTH,
	PERSISTENT_WRITE_DOMAINS,
  firestoreWriteMetricsService,
};
