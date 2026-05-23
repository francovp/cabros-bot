'use strict';

/**
 * Manual mock for firebase-admin.
 * Used by AlertStorageService tests in the pnpm worktree setup where
 * node_modules are not co-located with the worktree.
 */

const mockAdd = jest.fn();
const mockCollection = jest.fn(() => ({ add: mockAdd }));
const mockServerTimestamp = jest.fn(() => ({ _type: 'serverTimestamp' }));
const mockInitializeApp = jest.fn();
const mockCert = jest.fn((sa) => ({ type: 'service_account_credential', sa }));

let apps = [];

const firestore = jest.fn(() => ({ collection: mockCollection }));
firestore.FieldValue = { serverTimestamp: mockServerTimestamp };

const mock = {
	get apps() { return apps; },
	set apps(val) { apps = val; },
	initializeApp: mockInitializeApp,
	firestore,
	credential: { cert: mockCert },
	// Test helpers to manipulate shared state
	__mockAdd: mockAdd,
	__mockCollection: mockCollection,
	__mockServerTimestamp: mockServerTimestamp,
	__mockInitializeApp: mockInitializeApp,
	__mockCert: mockCert,
	__resetApps() { apps = []; },
	__setApps(val) { apps = val; },
};

module.exports = mock;
