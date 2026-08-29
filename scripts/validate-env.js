#!/usr/bin/env node
'use strict';

const { isFirestoreConfigured } = require('../src/services/storage/firestoreConfig');

const ENV_EXAMPLE = '.env.example';
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const NUMERIC_RULES = {
	TRADINGVIEW_MCP_TIMEOUT_MS: [1000, 120000],
	TRADINGVIEW_MCP_MAX_RETRIES: [1, 5],
	GROUNDING_TIMEOUT_MS: [1000, 120000],
	GROUNDING_MAX_SOURCES: [1, 20],
	RATE_LIMIT_WINDOW_MS: [1000, 86400000],
	RATE_LIMIT_MAX: [1, 100000],
};

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function isEnabled(env, name) {
	return env[name] === 'true';
}

function isHttpUrl(value) {
	if (!hasValue(value)) return false;
	try {
		return HTTP_PROTOCOLS.has(new URL(value).protocol);
	} catch (_) {
		return false;
	}
}

function isDiscordWebhookUrl(value) {
	if (!isHttpUrl(value)) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'https:'
			&& /^(?:discord\.com|discordapp\.com)$/i.test(url.hostname)
			&& /^\/api\/webhooks\/[^/]+\/[^/?#]+$/.test(url.pathname);
	} catch (_) {
		return false;
	}
}

function isWhatsAppChatId(value) {
	return typeof value === 'string' && /^\d+@g\.us$/.test(value.trim());
}

function isSymbolList(value) {
	if (!hasValue(value)) return false;
	return value.split(',').every((symbol) => /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+$/.test(symbol.trim()));
}

function isPositiveNumberInRange(value, [minimum, maximum]) {
	if (!/^-?\d+(?:\.\d+)?$/.test(String(value).trim())) return false;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum;
}

function addMissing(warnings, variable, value) {
	if (!hasValue(value)) warnings.push({ variable, message: 'is missing' });
}

function addInvalid(warnings, variable, message) {
	warnings.push({ variable, message });
}

function validateEnv(env = process.env) {
	const warnings = [];

	if (isEnabled(env, 'ENABLE_TELEGRAM_BOT')) {
		addMissing(warnings, 'BOT_TOKEN', env.BOT_TOKEN);
		addMissing(warnings, 'TELEGRAM_CHAT_ID', env.TELEGRAM_CHAT_ID);
	}

	if (isEnabled(env, 'ENABLE_WHATSAPP_ALERTS')) {
		addMissing(warnings, 'WHATSAPP_API_URL', env.WHATSAPP_API_URL);
		addMissing(warnings, 'WHATSAPP_API_KEY', env.WHATSAPP_API_KEY);
		addMissing(warnings, 'WHATSAPP_CHAT_ID', env.WHATSAPP_CHAT_ID);
	}

	if (hasValue(env.WHATSAPP_API_URL) && !isHttpUrl(env.WHATSAPP_API_URL)) {
		addInvalid(warnings, 'WHATSAPP_API_URL', 'has an invalid HTTP URL');
	}
	if (hasValue(env.WHATSAPP_CHAT_ID) && !isWhatsAppChatId(env.WHATSAPP_CHAT_ID)) {
		addInvalid(warnings, 'WHATSAPP_CHAT_ID', 'must end with @g.us');
	}

	if (isEnabled(env, 'ENABLE_DISCORD_ALERTS')) addMissing(warnings, 'DISCORD_WEBHOOK_URL', env.DISCORD_WEBHOOK_URL);
	if (hasValue(env.DISCORD_WEBHOOK_URL) && !isDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL)) {
		addInvalid(warnings, 'DISCORD_WEBHOOK_URL', 'must be a full HTTPS Discord webhook URL');
	}

	if (isEnabled(env, 'ENABLE_GEMINI_GROUNDING')) {
		addMissing(warnings, 'GEMINI_API_KEY', env.GEMINI_API_KEY);
		addMissing(warnings, 'GEMINI_MODEL_NAME', env.GEMINI_MODEL_NAME);
	}

	if (isEnabled(env, 'ENABLE_LANGFUSE_PROMPTS')) {
		addMissing(warnings, 'LANGFUSE_PUBLIC_KEY', env.LANGFUSE_PUBLIC_KEY);
		addMissing(warnings, 'LANGFUSE_SECRET_KEY', env.LANGFUSE_SECRET_KEY);
		addMissing(warnings, 'LANGFUSE_BASE_URL', env.LANGFUSE_BASE_URL);
	}
	if (hasValue(env.LANGFUSE_BASE_URL) && !isHttpUrl(env.LANGFUSE_BASE_URL)) {
		addInvalid(warnings, 'LANGFUSE_BASE_URL', 'has an invalid HTTP URL');
	}

	if (isEnabled(env, 'ENABLE_CLOUDFLARE_AIG')) {
		addMissing(warnings, 'CF_AIG_TOKEN', env.CF_AIG_TOKEN);
		addMissing(warnings, 'CF_AIG_BASE_URL', env.CF_AIG_BASE_URL);
	}
	if (hasValue(env.CF_AIG_BASE_URL) && !isHttpUrl(env.CF_AIG_BASE_URL)) {
		addInvalid(warnings, 'CF_AIG_BASE_URL', 'has an invalid HTTP URL');
	}

	if (hasValue(env.EXPANDED_ANALYSIS_ALERT_SYMBOLS) && !isSymbolList(env.EXPANDED_ANALYSIS_ALERT_SYMBOLS)) {
		addInvalid(warnings, 'EXPANDED_ANALYSIS_ALERT_SYMBOLS', 'must use EXCHANGE:SYMBOL entries');
	}
	if (hasValue(env.TRADINGVIEW_MCP_URL) && !isHttpUrl(env.TRADINGVIEW_MCP_URL)) {
		addInvalid(warnings, 'TRADINGVIEW_MCP_URL', 'has an invalid HTTP URL');
	}

	const firestoreGateEnabled = [
		'ENABLE_FIRESTORE_ALERT_STORAGE',
		'ENABLE_FIRESTORE_SCANNER_PRESETS',
		'ENABLE_FIRESTORE_JOB_STORAGE',
		'ENABLE_FIRESTORE_IDEMPOTENCY',
		'ENABLE_FIREBASE_REMOTE_CONFIG',
	].some((name) => isEnabled(env, name));
	if (firestoreGateEnabled && !isFirestoreConfigured()) {
		addInvalid(warnings, 'FIREBASE_CREDENTIALS', 'are not configured or readable for an enabled Firebase feature');
	}

	if (isEnabled(env, 'ENABLE_EQUITY_MARKET_DATA')) {
		if (env.EQUITY_MARKET_DATA_PROVIDER !== 'twelve-data') {
			addInvalid(warnings, 'EQUITY_MARKET_DATA_PROVIDER', 'must be twelve-data when equity market data is enabled');
		}
		addMissing(warnings, 'TWELVE_DATA_API_KEY', env.TWELVE_DATA_API_KEY);
	}

	if (isEnabled(env, 'ENABLE_BINANCE_TRADING')) {
		addMissing(warnings, 'BINANCE_API_KEY', env.BINANCE_API_KEY);
		addMissing(warnings, 'BINANCE_API_SECRET', env.BINANCE_API_SECRET);
		addMissing(warnings, 'BINANCE_TRADING_ALLOWED_SYMBOLS', env.BINANCE_TRADING_ALLOWED_SYMBOLS);
		addMissing(warnings, 'BINANCE_TRADING_MAX_NOTIONAL', env.BINANCE_TRADING_MAX_NOTIONAL);
		if (hasValue(env.BINANCE_TRADING_ENV) && !['testnet', 'live'].includes(env.BINANCE_TRADING_ENV.trim().toLowerCase())) {
			addInvalid(warnings, 'BINANCE_TRADING_ENV', 'must be testnet or live');
		}
		if (hasValue(env.BINANCE_TRADING_MAX_NOTIONAL) && !isPositiveNumberInRange(env.BINANCE_TRADING_MAX_NOTIONAL, [Number.MIN_VALUE, Number.MAX_VALUE])) {
			addInvalid(warnings, 'BINANCE_TRADING_MAX_NOTIONAL', 'must be a positive number');
		}
	}

	for (const [variable, bounds] of Object.entries(NUMERIC_RULES)) {
		if (hasValue(env[variable]) && !isPositiveNumberInRange(env[variable], bounds)) {
			addInvalid(warnings, variable, `must be between ${bounds[0]} and ${bounds[1]}`);
		}
	}

	if (hasValue(env.FIREBASE_SERVICE_ACCOUNT_JSON) && !isFirestoreConfigured()) {
		addInvalid(warnings, 'FIREBASE_SERVICE_ACCOUNT_JSON', 'is not valid service-account JSON');
	}

	return warnings;
}

function formatWarning({ variable, message }) {
	return `Configuration warning: ${variable} ${message}. See ${ENV_EXAMPLE} for remediation.`;
}

function printWarnings(warnings, logger = console.warn) {
	for (const warning of warnings) logger(formatWarning(warning));
	return warnings.length;
}

if (require.main === module && !process.argv.includes('--quiet')) {
	const warnings = validateEnv();
	if (warnings.length === 0) console.log('Configuration doctor: no warnings.');
	else printWarnings(warnings);
}

module.exports = { formatWarning, printWarnings, validateEnv };
