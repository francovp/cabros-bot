/**
 * adminPagingStatus - resolves non-secret operator-paging health for /api/status.
 *
 * The live NotificationManager instance registers itself here at construction, so
 * /api/status can report whether the operator path is actually delivering without
 * importing the manager (and pulling in the whole notification stack) itself.
 *
 * Exposed values are channel names and counters only: never tokens, webhook URLs,
 * or chat IDs.
 */

let activeManager = null;

function registerAdminPagingManager(manager) {
	activeManager = manager || null;
}

function getAdminPagingStatus() {
	if (!activeManager || typeof activeManager.getAdminPagingStatus !== 'function') {
		return null;
	}
	try {
		return activeManager.getAdminPagingStatus();
	} catch (error) {
		// Fail-open: status reporting must never break the capabilities response.
		console.warn('[adminPagingStatus] Failed to read admin paging status:', error.message);
		return null;
	}
}

function resetAdminPagingManagerForTesting() {
	activeManager = null;
}

module.exports = {
	registerAdminPagingManager,
	getAdminPagingStatus,
	resetAdminPagingManagerForTesting,
};
