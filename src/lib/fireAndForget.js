'use strict';

const {
	PERSISTENT_WRITE_DOMAINS,
	firestoreWriteMetricsService,
} = require('../services/storage/FirestoreWriteMetricsService');

const PERSISTENT_WRITE_DOMAIN_SET = new Set(PERSISTENT_WRITE_DOMAINS);

/**
 * Observe a persistence write without allowing its failure or telemetry to
 * reject the surrounding fire-and-forget workflow.
 *
 * The result envelope keeps the original successful value and exposes the
 * original error only to the caller, which can preserve its existing logging
 * and fail-open return behavior. The public health snapshot never includes it.
 * Conditional transactions may set `shouldRecordSuccess` so a successful
 * transaction that intentionally performs no write stays outside write metrics.
 *
 * @param {string} domain - Fixed persistence-health domain.
 * @param {() => Promise<unknown>} write - Persistence operation to observe.
 * @param {{shouldRecordSuccess?: (value: unknown) => boolean}} options
 */
async function fireAndForget(domain, write, options = {}) {
	if (typeof write !== 'function') {
		return { ok: false, error: new TypeError('A write function is required') };
	}

	try {
		const value = await write();
		if (PERSISTENT_WRITE_DOMAIN_SET.has(domain)) {
			try {
				const shouldRecordSuccess = options?.shouldRecordSuccess;
				if (typeof shouldRecordSuccess !== 'function' || shouldRecordSuccess(value)) {
					firestoreWriteMetricsService.recordPersistentWriteSuccess(domain);
				}
			} catch {
				// Health telemetry must never change a successful persistence result.
			}
		}
		return { ok: true, value };
	} catch (error) {
		if (PERSISTENT_WRITE_DOMAIN_SET.has(domain)) {
			try {
				firestoreWriteMetricsService.recordPersistentWriteFailure(domain, error);
			} catch {
				// Health telemetry must never replace the original write error.
			}
		}
		return { ok: false, error };
	}
}

module.exports = { fireAndForget };
