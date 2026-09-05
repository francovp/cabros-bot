'use strict';

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
 */

class FirestoreWriteMetricsService {
  constructor() {
    this.windowStartedAt = Date.now();
    // Map<domain, { success: number, failure: number }>
    this.domainCounters = new Map();
  }

  _ensureDomain(domain) {
    let counters = this.domainCounters.get(domain);
    if (!counters) {
      counters = { success: 0, failure: 0 };
      this.domainCounters.set(domain, counters);
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

  resetForTesting() {
    this.domainCounters.clear();
    this.windowStartedAt = Date.now();
  }
}

const firestoreWriteMetricsService = new FirestoreWriteMetricsService();

module.exports = {
  FirestoreWriteMetricsService,
  firestoreWriteMetricsService,
};