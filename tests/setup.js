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
};

// Mock Telegram bot globally
global.bot = {
	telegram: {
		sendMessage: jest.fn().mockResolvedValue({ message_id: 'test-message-id' }),
	},
};

// Increase timeout for all tests
jest.setTimeout(10000);