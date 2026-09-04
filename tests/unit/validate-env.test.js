const { formatWarning, validateEnv } = require('../../scripts/validate-env');

describe('validate-env', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env = { NODE_ENV: 'test' };
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	it('does not warn about intentionally disabled features', () => {
		expect(validateEnv()).toEqual([]);
	});

	it('reports missing credentials for enabled features without exposing values', () => {
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.green-api.com/waInstance/';
		process.env.WHATSAPP_CHAT_ID = '120363000000000000@g.us';
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'secret-gemini-key';
		delete process.env.WHATSAPP_API_KEY;

		const warnings = validateEnv();

		expect(warnings.map((warning) => warning.variable)).toContain('WHATSAPP_API_KEY');
		expect(JSON.stringify(warnings)).not.toContain('secret-gemini-key');
	});

	it('reports malformed provided URLs, chat IDs, and symbol lists', () => {
		process.env.WHATSAPP_CHAT_ID = 'not-a-group';
		process.env.WHATSAPP_API_URL = 'not-a-url';
		process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/channels/not-a-webhook';
		process.env.EXPANDED_ANALYSIS_ALERT_SYMBOLS = 'BINANCE:BTCUSDT,broken';

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toEqual(expect.arrayContaining([
			'WHATSAPP_API_URL',
			'WHATSAPP_CHAT_ID',
			'DISCORD_WEBHOOK_URL',
			'EXPANDED_ANALYSIS_ALERT_SYMBOLS',
		]));
	});

	it('reports enabled Telegram, Firestore, and Remote Config prerequisites', () => {
		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		delete process.env.BOT_TOKEN;
		delete process.env.TELEGRAM_CHAT_ID;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toEqual(expect.arrayContaining([
			'BOT_TOKEN',
			'TELEGRAM_CHAT_ID',
			'FIREBASE_CREDENTIALS',
		]));
	});

	it('reports numeric values outside documented bounds and rejects fractional integers', () => {
		process.env.TRADINGVIEW_MCP_TIMEOUT_MS = '10';
		process.env.TRADINGVIEW_MCP_MAX_RETRIES = '1.5';
		process.env.GROUNDING_MAX_SOURCES = '0';
		process.env.API_REQUEST_DEADLINE_MS = '700000';

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toEqual(expect.arrayContaining([
			'TRADINGVIEW_MCP_TIMEOUT_MS',
			'TRADINGVIEW_MCP_MAX_RETRIES',
			'GROUNDING_MAX_SOURCES',
			'API_REQUEST_DEADLINE_MS',
		]));
	});

	it('accepts personal WhatsApp chat IDs ending with @c.us', () => {
		process.env.WHATSAPP_CHAT_ID = '56912345678@c.us';

		const warnings = validateEnv();

		expect(warnings.map((w) => w.variable)).not.toContain('WHATSAPP_CHAT_ID');
	});

	it('resolves preview WhatsApp chat ID in preview environments without warning', () => {
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.green-api.com/waInstance/';
		process.env.WHATSAPP_API_KEY = 'test-key';
		process.env.IS_PULL_REQUEST = 'true';
		process.env.WHATSAPP_PREVIEW_CHAT_ID = '120363000000000000@g.us';
		delete process.env.WHATSAPP_CHAT_ID;

		const warnings = validateEnv();

		expect(warnings.map((w) => w.variable)).not.toContain('WHATSAPP_CHAT_ID');
	});

	it('reports missing Firestore credentials when signal outcome tracking is enabled', () => {
		process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

		const warnings = validateEnv();

		expect(warnings.map((w) => w.variable)).toContain('FIREBASE_CREDENTIALS');
	});

	it('validates TELEGRAM_TOPIC_ROUTES format and values', () => {
		process.env.TELEGRAM_TOPIC_ROUTES = 'invalid-format-without-colon';
		let warnings = validateEnv();
		expect(warnings.map((w) => w.variable)).toContain('TELEGRAM_TOPIC_ROUTES');

		process.env.TELEGRAM_TOPIC_ROUTES = 'webhook-signal:101,market-scanner:202';
		warnings = validateEnv();
		expect(warnings.map((w) => w.variable)).not.toContain('TELEGRAM_TOPIC_ROUTES');
	});

	it('formats warnings with remediation and no raw value', () => {
		const warning = formatWarning({ variable: 'GEMINI_API_KEY', message: 'is missing' });

		expect(warning).toContain('GEMINI_API_KEY');
		expect(warning).toContain('.env.example');
		expect(warning).not.toContain('secret');
	});
});
