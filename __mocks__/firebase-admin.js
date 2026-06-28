'use strict';

/**
 * Manual mock for firebase-admin.
 * Used by AlertStorageService tests in the pnpm worktree setup where
 * node_modules are not co-located with the worktree.
 */

const mockAdd = jest.fn();
const mockGet = jest.fn();
const mockDocGet = jest.fn();
const mockDocSet = jest.fn();
const mockDocUpdate = jest.fn();
const mockDocDelete = jest.fn();
const mockServerTimestamp = jest.fn(() => ({ _type: 'serverTimestamp' }));
const mockTimestampFromDate = jest.fn((date) => ({ _type: 'timestamp', toDate: () => date }));
const mockDocumentId = jest.fn(() => '__name__');
const mockOrderBy = jest.fn(() => null);
const mockWhere = jest.fn(() => null);
const mockLimit = jest.fn(() => null);
const mockStartAfter = jest.fn(() => null);

const mockState = global.__firebaseAdminMockState || (global.__firebaseAdminMockState = {
	collections: new Map(),
	docCounter: 0,
});

function resetCollectionState() {
	mockState.collections = new Map();
	mockState.docCounter = 0;
}

function getCollectionState(collectionName) {
	if (!mockState.collections.has(collectionName)) {
		mockState.collections.set(collectionName, new Map());
	}
	return mockState.collections.get(collectionName);
}

function nextDocId() {
	mockState.docCounter += 1;
	return `mock-doc-${mockState.docCounter}`;
}

function buildDocSnapshot(id, data, collectionName) {
	return {
		exists: Boolean(data),
		id,
		ref: createDocRef(collectionName || 'unknown', id),
		data: () => data,
	};
}

function sortDocs(docs, field, direction) {
	return docs.sort((a, b) => {
		const left = a.data()[field];
		const right = b.data()[field];

		if (left === right) {
			return a.id.localeCompare(b.id);
		}

		const comparison = String(left ?? '').localeCompare(String(right ?? ''));
		return direction === 'desc' ? -comparison : comparison;
	});
}

function buildQuerySnapshot(collectionName, queryState = {}) {
	const docs = [...getCollectionState(collectionName).entries()].map(([id, data]) => buildDocSnapshot(id, data, collectionName));

	if (queryState.orderByField) {
		sortDocs(docs, queryState.orderByField, queryState.orderByDirection || 'asc');
	}

	const limitedDocs = typeof queryState.limitCount === 'number'
		? docs.slice(0, queryState.limitCount)
		: docs;

	return {
		empty: limitedDocs.length === 0,
		docs: limitedDocs,
	};
}

function createDocRef(collectionName, id) {
	return {
		get: () => {
			const configured = mockDocGet();
			if (configured !== undefined) {
				return configured;
			}

			const data = getCollectionState(collectionName).get(id) || null;
			return Promise.resolve(buildDocSnapshot(id, data, collectionName));
		},
		set: (data) => {
			const configured = mockDocSet(data);
			if (configured !== undefined) {
				return configured;
			}

			getCollectionState(collectionName).set(id, data);
			return Promise.resolve({ id });
		},
		update: (data) => {
			const configured = mockDocUpdate(data);
			if (configured !== undefined) {
				return configured;
			}

			const existing = getCollectionState(collectionName).get(id) || {};
			getCollectionState(collectionName).set(id, { ...existing, ...data });
			return Promise.resolve({ id });
		},
		delete: () => {
			const configured = mockDocDelete();
			if (configured !== undefined) {
				return configured;
			}

			getCollectionState(collectionName).delete(id);
			return Promise.resolve();
		},
	};
}

function createQueryApi(collectionName) {
	const queryState = {};
	const api = {
		add: (data) => {
			const configured = mockAdd(data);
			if (configured !== undefined) {
				return configured;
			}

			const id = nextDocId();
			getCollectionState(collectionName).set(id, data);
			return Promise.resolve({ id });
		},
		doc: (id) => createDocRef(collectionName, id),
		orderBy: (field, direction) => {
			mockOrderBy(field, direction);
			queryState.orderByField = field;
			queryState.orderByDirection = direction;
			return api;
		},
		where: (...args) => {
			mockWhere(...args);
			queryState.where = args;
			return api;
		},
		limit: (count) => {
			mockLimit(count);
			queryState.limitCount = count;
			return api;
		},
		startAfter: (...args) => {
			mockStartAfter(...args);
			queryState.startAfter = args;
			return api;
		},
		get: () => {
			const configured = mockGet();
			if (configured !== undefined) {
				return configured;
			}

			return Promise.resolve(buildQuerySnapshot(collectionName, queryState));
		},
	};

	return api;
}

const mockCollection = jest.fn((collectionName) => createQueryApi(collectionName));
const mockInitializeApp = jest.fn();
const mockCert = jest.fn((sa) => ({ type: 'service_account_credential', sa }));

let apps = [];

const firestore = jest.fn(() => ({ collection: mockCollection }));
firestore.FieldValue = { serverTimestamp: mockServerTimestamp };
firestore.Timestamp = { fromDate: mockTimestampFromDate };
firestore.FieldPath = { documentId: mockDocumentId };

const mock = {
	get apps() { return apps; },
	set apps(val) { apps = val; },
	initializeApp: mockInitializeApp,
	firestore,
	credential: { cert: mockCert },
	// Test helpers to manipulate shared state
	__mockAdd: mockAdd,
	__mockCollection: mockCollection,
	__mockGet: mockGet,
	__mockDocGet: mockDocGet,
	__mockDocSet: mockDocSet,
	__mockDocUpdate: mockDocUpdate,
	__mockDocDelete: mockDocDelete,
	__mockOrderBy: mockOrderBy,
	__mockWhere: mockWhere,
	__mockLimit: mockLimit,
	__mockStartAfter: mockStartAfter,
	__mockServerTimestamp: mockServerTimestamp,
	__mockTimestampFromDate: mockTimestampFromDate,
	__mockDocumentId: mockDocumentId,
	__mockInitializeApp: mockInitializeApp,
	__mockCert: mockCert,
	__resetApps() { apps = []; },
	__setApps(val) { apps = val; },
	__resetCollectionState: resetCollectionState,
};

module.exports = mock;
