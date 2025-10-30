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
	testTimeout: 10000,
};