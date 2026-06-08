'use strict';

/**
 * Manual mock for firebase-admin.
 * Used by AlertStorageService tests in the pnpm worktree setup where
 * node_modules are not co-located with the worktree.
 */

const mockAdd = jest.fn();
const mockGet = jest.fn();
const mockDocGet = jest.fn();
const mockDoc = jest.fn(() => ({ get: mockDocGet }));
const mockServerTimestamp = jest.fn(() => ({ _type: 'serverTimestamp' }));
const mockTimestampFromDate = jest.fn((date) => ({ _type: 'timestamp', toDate: () => date }));
const mockDocumentId = jest.fn(() => '__name__');
const queryApi = {};
const mockOrderBy = jest.fn(() => queryApi);
const mockWhere = jest.fn(() => queryApi);
const mockLimit = jest.fn(() => queryApi);
const mockStartAfter = jest.fn(() => queryApi);
Object.assign(queryApi, {
	add: mockAdd,
	doc: mockDoc,
	orderBy: mockOrderBy,
	where: mockWhere,
	limit: mockLimit,
	startAfter: mockStartAfter,
	get: mockGet,
});
const mockCollection = jest.fn(() => queryApi);
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
	__mockDoc: mockDoc,
	__mockDocGet: mockDocGet,
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
};

module.exports = mock;
