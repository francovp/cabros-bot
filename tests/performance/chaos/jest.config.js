'use strict';

const path = require('node:path');
const rootDir = path.resolve(__dirname, '../../..');

module.exports = {
	...require(path.join(rootDir, 'jest.config')),
	rootDir,
	testMatch: ['<rootDir>/tests/performance/chaos/**/*.test.js'],
	testPathIgnorePatterns: ['/node_modules/', '/tests/firebase/'],
};
