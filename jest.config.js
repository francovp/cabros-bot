module.exports = {
	testEnvironment: 'node',
	testMatch: ['**/*.test.js'],
	collectCoverageFrom: [
		'src/**/*.js',
		'!src/lib/**',
		'!**/node_modules/**',
	],
	coverageDirectory: 'coverage',
	setupFilesAfterEnv: ['./tests/setup.js'],
	testTimeout: 25000,
	modulePaths: [
		'/Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/node_modules'
	],
	// pnpm worktree: firebase-admin lives in the parent repo's node_modules.
	// Map it to a local manual mock so tests can run without installing dependencies.
	moduleNameMapper: {
		'^firebase-admin$': '<rootDir>/__mocks__/firebase-admin.js',
	},
};