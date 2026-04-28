/* global jest */

// Mock environment variables
process.env = {
	...process.env,
	ENABLE_GEMINI_GROUNDING: 'true',
	SEARCH_API_KEY: 'test-search-key',
	SEARCH_CX: 'test-search-cx',
	GEMINI_API_KEY: 'test-gemini-key',
	TELEGRAM_CHAT_ID: '123456789',
	TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: '987654321',
	SEARCH_MAX_RESULTS: '3',
	GROUNDING_TIMEOUT_MS: '8000',
	BOT_TOKEN: 'test-bot-token',
	// Sentry disabled by default in tests
	ENABLE_SENTRY: 'false',
	SENTRY_DSN: undefined,
	// Silence verbose logging in tests (only errors shown by default)
	// Set LOG_LEVEL=debug to enable verbose test output when debugging
	LOG_LEVEL: process.env.LOG_LEVEL || 'error',
};

// Configure logging early to apply level filtering in tests
const { configureLogging } = require('../src/lib/logging');
configureLogging();

// Mock Telegram bot globally
global.bot = {
	telegram: {
		sendMessage: jest.fn().mockResolvedValue({ message_id: 'test-message-id' }),
	},
};

// Mock @sentry/node globally to prevent real network calls
jest.mock('@sentry/node', () => ({
	init: jest.fn(),
	captureException: jest.fn(() => 'mock-event-id'),
	captureMessage: jest.fn(() => 'mock-event-id'),
	flush: jest.fn().mockResolvedValue(true),
	withScope: jest.fn((callback) => callback({
		setTag: jest.fn(),
		setContext: jest.fn(),
		setExtra: jest.fn(),
	})),
	setTag: jest.fn(),
	setContext: jest.fn(),
	setExtra: jest.fn(),
}));

// Increase timeout for all tests
jest.setTimeout(10000);