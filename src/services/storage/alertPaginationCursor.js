'use strict';

const CURSOR_VERSION = 1;

function normalizeReceivedAt(receivedAt) {
	if (typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt))) {
		return null;
	}

	return new Date(receivedAt).toISOString();
}

function encodeAlertPaginationCursor({ receivedAt, id }) {
	const normalizedReceivedAt = normalizeReceivedAt(receivedAt);
	if (!normalizedReceivedAt || typeof id !== 'string' || !id) {
		return null;
	}

	return Buffer
		.from(JSON.stringify({ v: CURSOR_VERSION, receivedAt: normalizedReceivedAt, id }), 'utf8')
		.toString('base64url');
}

function parseAlertPaginationCursor(rawCursor) {
	if (typeof rawCursor !== 'string' || !rawCursor.trim()) {
		return null;
	}

	const cursor = rawCursor.trim();

	try {
		const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
		const decodedReceivedAt = normalizeReceivedAt(payload && payload.receivedAt);
		if (payload && payload.v === CURSOR_VERSION && decodedReceivedAt && typeof payload.id === 'string' && payload.id) {
			return {
				type: 'composite',
				receivedAt: decodedReceivedAt,
				documentId: payload.id,
			};
		}
	} catch {
		// Not a base64url JSON composite cursor, fallback to timestamp cursor
	}

	const normalizedReceivedAt = normalizeReceivedAt(cursor);
	if (normalizedReceivedAt) {
		return {
			type: 'timestamp',
			receivedAt: normalizedReceivedAt,
			documentId: null,
		};
	}

	return null;
}

module.exports = {
	encodeAlertPaginationCursor,
	parseAlertPaginationCursor,
};
