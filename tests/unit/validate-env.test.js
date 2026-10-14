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

	it('does not require an environment Gemini model when Remote Config can provide it', () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		delete process.env.GEMINI_MODEL_NAME;

		const warnings = validateEnv();

		expect(warnings.map((warning) => warning.variable)).not.toContain('GEMINI_MODEL_NAME');
	});

	it('still requires an environment Gemini model when Remote Config is disabled', () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		delete process.env.GEMINI_MODEL_NAME;

		const warnings = validateEnv();

		expect(warnings.map((warning) => warning.variable)).toContain('GEMINI_MODEL_NAME');
	});

	it('does not require a Gemini generation model when another provider handles generation', () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		process.env.MODEL_PROVIDER = 'azure';
		process.env.FORCE_BRAVE_SEARCH = 'false';
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		delete process.env.GEMINI_MODEL_NAME;

		const warnings = validateEnv();

		expect(warnings.map((warning) => warning.variable)).not.toContain('GEMINI_MODEL_NAME');
	});

	it('rejects an unsupported model provider instead of treating it as an alternate', () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		process.env.MODEL_PROVIDER = 'azuer';
		delete process.env.GEMINI_MODEL_NAME;

		const warnings = validateEnv();

		expect(warnings).toContainEqual(expect.objectContaining({
			variable: 'MODEL_PROVIDER',
			message: 'must be gemini, azure, openrouter, or cloudflare',
		}));
		expect(warnings.map((warning) => warning.variable)).not.toContain('GEMINI_MODEL_NAME');
	});

	it('reports missing credentials for the selected Azure provider', () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		process.env.MODEL_PROVIDER = 'azure';
		delete process.env.AZURE_LLM_KEY;
		delete process.env.AZURE_LLM_MODEL;

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toContain('AZURE_LLM_KEY');
		expect(variables).toContain('AZURE_LLM_MODEL');
	});

	it('reports Cloudflare credentials once when provider and runtime gates overlap', () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		process.env.MODEL_PROVIDER = 'cloudflare';
		process.env.ENABLE_CLOUDFLARE_AIG = 'true';
		delete process.env.CF_AIG_TOKEN;
		delete process.env.CF_AIG_BASE_URL;

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables.filter((variable) => variable === 'CF_AIG_TOKEN')).toHaveLength(1);
		expect(variables.filter((variable) => variable === 'CF_AIG_BASE_URL')).toHaveLength(1);
	});

	it('reports a missing Brave key when forced search is enabled', () => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.GEMINI_API_KEY = 'test-gemini-key';
		process.env.MODEL_PROVIDER = 'azure';
		process.env.AZURE_LLM_KEY = 'test-azure-key';
		process.env.AZURE_LLM_MODEL = 'test-azure-model';
		process.env.FORCE_BRAVE_SEARCH = 'true';
		delete process.env.BRAVE_SEARCH_API_KEY;

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toContain('BRAVE_SEARCH_API_KEY');
	});

	it.each([
		['grounding', { ENABLE_GEMINI_GROUNDING: 'true' }],
		['news monitoring', { ENABLE_NEWS_MONITOR: 'true' }],
	])('reports a missing Gemini key once when %s uses Gemini', (_feature, env) => {
		Object.assign(process.env, env, {
			MODEL_PROVIDER: 'gemini',
			FORCE_BRAVE_SEARCH: 'false',
		});
		delete process.env.GEMINI_API_KEY;

		const warnings = validateEnv().filter((warning) => warning.variable === 'GEMINI_API_KEY');

		expect(warnings).toHaveLength(1);
	});

	it('reports malformed configured AI endpoints', () => {
		process.env.AZURE_LLM_ENDPOINT = 'not-a-url';
		process.env.BRAVE_SEARCH_ENDPOINT = 'also-not-a-url';

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toContain('AZURE_LLM_ENDPOINT');
		expect(variables).toContain('BRAVE_SEARCH_ENDPOINT');
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
		process.env.REQUEST_TIMEOUT_MS = '500';

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toEqual(expect.arrayContaining([
			'TRADINGVIEW_MCP_TIMEOUT_MS',
			'TRADINGVIEW_MCP_MAX_RETRIES',
			'GROUNDING_MAX_SOURCES',
			'REQUEST_TIMEOUT_MS',
		]));
	});

	it('reports news cache max-entries bounds for issue #689', () => {
		process.env.NEWS_CACHE_MAX_ENTRIES = '0';
		process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES = '-1';
		process.env.URL_SHORTENER_CACHE_MAX_ENTRIES = 'not-a-number';
		process.env.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES = '999999';

		const variables = validateEnv().map((warning) => warning.variable);

		expect(variables).toEqual(expect.arrayContaining([
			'NEWS_CACHE_MAX_ENTRIES',
			'NEWS_DELIVERY_LOCK_MAX_ENTRIES',
			'URL_SHORTENER_CACHE_MAX_ENTRIES',
			'URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES',
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

	it('rejects unknown signal outcome entry-price providers', () => {
		process.env.SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES = 'mcp,wat';

		expect(validateEnv().map((warning) => warning.variable)).toContain('SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES');
	});

	it('formats warnings with remediation and no raw value', () => {
		const warning = formatWarning({ variable: 'GEMINI_API_KEY', message: 'is missing' });

		expect(warning).toContain('GEMINI_API_KEY');
		expect(warning).toContain('.env.example');
		expect(warning).not.toContain('secret');
	});
});
