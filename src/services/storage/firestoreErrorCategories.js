'use strict';

/**
 * firestoreErrorCategories - closed enum + classifier for Firestore failures.
 *
 * Issue #1285: every stored-alert read endpoint answered
 * `503 STORAGE_UNAVAILABLE` with a message that asserted a credential/project
 * cause, while writes were succeeding 29/29 and `dependencies.firestore.ready`
 * was `true`. The real cause was a rejected *query*, and it was only ever
 * `console.warn`-ed, so the operator-facing message actively pointed at the
 * wrong subsystem.
 *
 * Two distinct failures were being flattened into one opaque code:
 *   1. the client never initialized (credentials/project) -> `uninitialized`
 *   2. the client is fine but the operation was rejected -> the gRPC status
 *
 * Splitting them is what lets `/api/status` distinguish "check your
 * credentials" from "your query needs an index", which is the whole point of
 * the observability half of #1285.
 *
 * Closed enum, mirroring `marketScannerErrorCategories`: unrecognised errors
 * degrade to `unknown_error` rather than inventing a category, and the raw
 * provider message is never propagated - only the enum value and a boolean
 * missing-index hint are exposed.
 */

const FIRESTORE_ERROR_CATEGORIES = Object.freeze({
	/** Feature is on but the client could not be constructed (bad/missing credentials). */
	UNINITIALIZED: 'uninitialized',
	/** FAILED_PRECONDITION - most commonly a query with no matching composite index. */
	FAILED_PRECONDITION: 'failed_precondition',
	/** PERMISSION_DENIED - IAM or Firestore security rules rejected the call. */
	PERMISSION_DENIED: 'permission_denied',
	/** UNAUTHENTICATED - credentials absent/expired/revoked at call time. */
	UNAUTHENTICATED: 'unauthenticated',
	/** UNAVAILABLE - backend unreachable or transient outage. */
	UNAVAILABLE: 'unavailable',
	/** DEADLINE_EXCEEDED - the call exceeded its deadline. */
	DEADLINE_EXCEEDED: 'deadline_exceeded',
	/** NOT_FOUND - database or collection absent. */
	NOT_FOUND: 'not_found',
	/** RESOURCE_EXHAUSTED - quota, rate limit, or too many concurrent operations. */
	RESOURCE_EXHAUSTED: 'resource_exhausted',
	/** INVALID_ARGUMENT - malformed query, field path, or filter value. */
	INVALID_ARGUMENT: 'invalid_argument',
	/** ABORTED - concurrency conflict, typically a failed transaction. */
	ABORTED: 'aborted',
	/** INTERNAL - provider-side fault. */
	INTERNAL: 'internal',
	/** Unclassified. Never infer a cause from this. */
	UNKNOWN: 'unknown_error',
});

const FIRESTORE_ERROR_CATEGORY_SET = new Set(Object.values(FIRESTORE_ERROR_CATEGORIES));

/**
 * gRPC canonical status codes, as surfaced by `@google-cloud/firestore`
 * (`GrpcError.code`) and by `google-gax`. Firestore surfaces these as a number,
 * as a numeric string, and as a canonical uppercase name depending on the SDK
 * layer that surfaced the error, so all three shapes are mapped.
 */
const GRPC_STATUS_BY_NUMBER = Object.freeze({
	1: 'CANCELLED',
	2: 'UNKNOWN',
	3: 'INVALID_ARGUMENT',
	4: 'DEADLINE_EXCEEDED',
	5: 'NOT_FOUND',
	6: 'ALREADY_EXISTS',
	7: 'PERMISSION_DENIED',
	8: 'RESOURCE_EXHAUSTED',
	9: 'FAILED_PRECONDITION',
	10: 'ABORTED',
	11: 'OUT_OF_RANGE',
	12: 'UNIMPLEMENTED',
	13: 'INTERNAL',
	14: 'UNAVAILABLE',
	15: 'DATA_LOSS',
	16: 'UNAUTHENTICATED',
});

const CATEGORY_BY_GRPC_NAME = Object.freeze({
	CANCELLED: FIRESTORE_ERROR_CATEGORIES.UNAVAILABLE,
	UNKNOWN: FIRESTORE_ERROR_CATEGORIES.UNKNOWN,
	INVALID_ARGUMENT: FIRESTORE_ERROR_CATEGORIES.INVALID_ARGUMENT,
	DEADLINE_EXCEEDED: FIRESTORE_ERROR_CATEGORIES.DEADLINE_EXCEEDED,
	NOT_FOUND: FIRESTORE_ERROR_CATEGORIES.NOT_FOUND,
	ALREADY_EXISTS: FIRESTORE_ERROR_CATEGORIES.INVALID_ARGUMENT,
	PERMISSION_DENIED: FIRESTORE_ERROR_CATEGORIES.PERMISSION_DENIED,
	RESOURCE_EXHAUSTED: FIRESTORE_ERROR_CATEGORIES.RESOURCE_EXHAUSTED,
	FAILED_PRECONDITION: FIRESTORE_ERROR_CATEGORIES.FAILED_PRECONDITION,
	ABORTED: FIRESTORE_ERROR_CATEGORIES.ABORTED,
	OUT_OF_RANGE: FIRESTORE_ERROR_CATEGORIES.INVALID_ARGUMENT,
	UNIMPLEMENTED: FIRESTORE_ERROR_CATEGORIES.INTERNAL,
	INTERNAL: FIRESTORE_ERROR_CATEGORIES.INTERNAL,
	UNAVAILABLE: FIRESTORE_ERROR_CATEGORIES.UNAVAILABLE,
	DATA_LOSS: FIRESTORE_ERROR_CATEGORIES.UNKNOWN,
	UNAUTHENTICATED: FIRESTORE_ERROR_CATEGORIES.UNAUTHENTICATED,
});

/**
 * Categories whose most probable cause is the deployment/configuration rather
 * than the individual query. `STORAGE_UNAVAILABLE` messages branch on this so
 * the credential/project hint is only shown when it can actually be true.
 */
const CONFIGURATION_CATEGORIES = new Set([
	FIRESTORE_ERROR_CATEGORIES.UNINITIALIZED,
	FIRESTORE_ERROR_CATEGORIES.UNAUTHENTICATED,
]);

function isFirestoreErrorCategory(value) {
	return typeof value === 'string' && FIRESTORE_ERROR_CATEGORY_SET.has(value);
}

function extractErrorMessage(error) {
	if (!error) {
		return '';
	}
	if (typeof error === 'string') {
		return error;
	}
	if (typeof error.message === 'string') {
		return error.message;
	}
	return '';
}

/**
 * Resolve the gRPC status name from whichever shape the SDK surfaced, or null
 * when the error carries no gRPC status at all.
 */
function resolveGrpcStatusName(error) {
	if (!error) {
		return null;
	}

	const raw = typeof error.code === 'string' || typeof error.code === 'number'
		? error.code
		: null;
	if (raw !== null) {
		if (typeof raw === 'number' && Number.isInteger(raw)) {
			return GRPC_STATUS_BY_NUMBER[raw] || null;
		}
		const trimmed = String(raw).trim();
		if (trimmed === '') {
			// fall through to message heuristics
		} else if (/^\d+$/.test(trimmed)) {
			return GRPC_STATUS_BY_NUMBER[Number(trimmed)] || null;
		} else if (/^\d+$/.test(trimmed.split('/').pop() || '')) {
			// PrefixedFirebaseError-style `firestore/<code>`.
			return GRPC_STATUS_BY_NUMBER[Number(trimmed.split('/').pop())] || null;
		} else {
			const normalized = trimmed.replace(/[- ]/g, '_').toUpperCase();
			if (CATEGORY_BY_GRPC_NAME[normalized]) {
				return normalized;
			}
		}
	}

	// `status` is the google-gax shape and carries the canonical name.
	const status = error.status;
	if (typeof status === 'string' && CATEGORY_BY_GRPC_NAME[status.trim().replace(/[- ]/g, '_').toUpperCase()]) {
		return status.trim().replace(/[- ]/g, '_').toUpperCase();
	}
	if (typeof status === 'number' && Number.isInteger(status)) {
		return GRPC_STATUS_BY_NUMBER[status] || null;
	}

	return null;
}

/**
 * True when the rejection is Firestore refusing a query because no index backs
 * it. Detected structurally from the gRPC status and corroborated by the
 * provider's own wording, which is the only place it names the missing index.
 *
 * Exposed as a boolean rather than as the provider text: the raw message
 * embeds the fully-qualified project/database path and the index definition,
 * neither of which belongs in a response body or a status payload.
 */
function isMissingIndexError(error) {
	const grpcStatusName = resolveGrpcStatusName(error);
	if (grpcStatusName !== 'FAILED_PRECONDITION') {
		return false;
	}
	const message = extractErrorMessage(error);
	return /requires an index|missing index|create an index/i.test(message);
}

/**
 * Classify a Firestore failure into the closed enum.
 *
 * `context.category` wins when already valid so callers can pin the
 * `uninitialized` case (which has no provider error object at all).
 */
function classifyFirestoreError(error, context = {}) {
	if (context && isFirestoreErrorCategory(context.category)) {
		return context.category;
	}
	if (error && isFirestoreErrorCategory(error.category)) {
		return error.category;
	}

	const grpcStatusName = resolveGrpcStatusName(error);
	if (grpcStatusName && CATEGORY_BY_GRPC_NAME[grpcStatusName]) {
		return CATEGORY_BY_GRPC_NAME[grpcStatusName];
	}

	// Transport-level failures never reach gRPC, so they carry a Node errno
	// instead of a status. These are provider reachability problems, not query
	// problems, which is the distinction #1285 asked for.
	const message = extractErrorMessage(error);
	const errno = error && typeof error.errno === 'string' ? error.errno : '';
	if (/^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(errno)
		|| /\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network error)\b/i.test(message)) {
		return FIRESTORE_ERROR_CATEGORIES.UNAVAILABLE;
	}
	if (/\b(ETIMEDOUT|deadline ?exceeded)\b/i.test(message)) {
		return FIRESTORE_ERROR_CATEGORIES.DEADLINE_EXCEEDED;
	}

	return FIRESTORE_ERROR_CATEGORIES.UNKNOWN;
}

/**
 * Whether the category plausibly implicates deployment configuration
 * (credentials/project) rather than the individual operation.
 */
function isConfigurationErrorCategory(value) {
	return typeof value === 'string' && CONFIGURATION_CATEGORIES.has(value);
}

/**
 * Actionable, secret-free operator hint for a category. Deliberately generic:
 * it must stay useful without a Cloud Logging session and must never carry a
 * credential, project path, or provider response body.
 */
function describeFirestoreErrorCategory(value) {
	switch (value) {
	case FIRESTORE_ERROR_CATEGORIES.UNINITIALIZED:
		return 'Check Firestore credentials and project configuration.';
	case FIRESTORE_ERROR_CATEGORIES.UNAUTHENTICATED:
		return 'Firestore rejected the credentials as missing, expired, or revoked.';
	case FIRESTORE_ERROR_CATEGORIES.PERMISSION_DENIED:
		return 'Firestore denied access for the configured service account; check IAM roles and Firestore security rules.';
	case FIRESTORE_ERROR_CATEGORIES.FAILED_PRECONDITION:
		return 'Firestore rejected the query as not executable; a missing composite index is the usual cause.';
	case FIRESTORE_ERROR_CATEGORIES.NOT_FOUND:
		return 'Firestore reported the database or collection as missing; check the project id.';
	case FIRESTORE_ERROR_CATEGORIES.UNAVAILABLE:
		return 'Firestore was unreachable; this is usually transient.';
	case FIRESTORE_ERROR_CATEGORIES.DEADLINE_EXCEEDED:
		return 'The Firestore call exceeded its deadline.';
	case FIRESTORE_ERROR_CATEGORIES.RESOURCE_EXHAUSTED:
		return 'Firestore reported a quota or rate limit.';
	case FIRESTORE_ERROR_CATEGORIES.INVALID_ARGUMENT:
		return 'Firestore rejected the query arguments.';
	case FIRESTORE_ERROR_CATEGORIES.ABORTED:
		return 'The Firestore transaction was aborted by a concurrency conflict.';
	case FIRESTORE_ERROR_CATEGORIES.INTERNAL:
		return 'Firestore reported an internal error.';
	default:
		return 'Firestore failed without a classifiable status; check service logs.';
	}
}

module.exports = {
	FIRESTORE_ERROR_CATEGORIES,
	FIRESTORE_ERROR_CATEGORY_SET,
	GRPC_STATUS_BY_NUMBER,
	classifyFirestoreError,
	describeFirestoreErrorCategory,
	isConfigurationErrorCategory,
	isFirestoreErrorCategory,
	isMissingIndexError,
	resolveGrpcStatusName,
};