const { createPrivateKey } = require('crypto');
const { accessSync, constants } = require('fs');
const packageJson = require('../../package.json');

const DEFAULT_TRADINGVIEW_MCP_URL = 'https://tradingview-mcp.onrender.com/mcp';
const DEFAULT_AZURE_LLM_ENDPOINT = 'https://models.github.ai/inference';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.0-flash-001';
const DEFAULT_CF_AIG_MODEL = 'google-ai-studio/gemini-2.5-flash';

function isEnabled(value) {
	return value === 'true';
}

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function isGoogleManagedRuntime() {
	return (
		hasValue(process.env.K_SERVICE)
		|| hasValue(process.env.K_REVISION)
		|| hasValue(process.env.FUNCTION_TARGET)
		|| hasValue(process.env.FUNCTION_NAME)
		|| hasValue(process.env.GAE_SERVICE)
	);
}

function hasValidInlineFirestoreCredentials(value) {
	if (!hasValue(value)) {
		return false;
	}

	try {
		const parsed = JSON.parse(value);
		const projectId = parsed.projectId || parsed.project_id;
		const clientEmail = parsed.clientEmail || parsed.client_email;
		const privateKey = parsed.privateKey || parsed.private_key;

		if (!hasValue(projectId) || !hasValue(clientEmail) || !hasValue(privateKey)) {
			return false;
		}

		createPrivateKey({ key: privateKey, format: 'pem' });
		return true;
	} catch (error) {
		return false;
	}
}

function hasReadableFile(path) {
	if (!hasValue(path)) {
		return false;
	}

	try {
		accessSync(path, constants.R_OK);
		return true;
	} catch (error) {
		return false;
	}
}

function getModelProvider() {
	return typeof process.env.MODEL_PROVIDER === 'string' && process.env.MODEL_PROVIDER.trim().length > 0
		? process.env.MODEL_PROVIDER.trim().toLowerCase()
		: 'gemini';
}

function getCommit() {
	return process.env.RENDER_GIT_COMMIT
		|| process.env.GIT_COMMIT
		|| process.env.COMMIT_SHA
		|| process.env.GITHUB_SHA
		|| process.env.SOURCE_VERSION
		|| null;
}

function isRenderPreview() {
	return process.env.RENDER === 'true' && process.env.IS_PULL_REQUEST === 'true';
}

function getEnvironment() {
	if (process.env.SENTRY_ENVIRONMENT) {
		return process.env.SENTRY_ENVIRONMENT;
	}

	if (isRenderPreview()) {
		return 'preview';
	}

	if (process.env.NODE_ENV === 'production' || process.env.RENDER === 'true') {
		return 'production';
	}

	return process.env.NODE_ENV || 'development';
}

function getReadinessStatus({ enabled, configured }) {
	if (!enabled) {
		return 'disabled';
	}

	return configured ? 'ready' : 'misconfigured';
}

function dependencyStatus({ enabled, configured }) {
	return {
		enabled,
		configured,
		ready: enabled && configured,
		status: getReadinessStatus({ enabled, configured }),
	};
}

function providerDependencyStatus({ enabled, configured, provider = null }) {
	return {
		provider,
		...dependencyStatus({ enabled, configured }),
	};
}

function getNewsMonitorLlmDependency({ enabled, provider }) {
	switch (provider) {
	case 'gemini':
		return providerDependencyStatus({
			enabled,
			provider,
			configured: hasValue(process.env.GEMINI_API_KEY) && hasValue(process.env.GEMINI_MODEL_NAME),
		});
	case 'azure':
		return providerDependencyStatus({
			enabled,
			provider,
			configured:
				hasValue(process.env.AZURE_LLM_ENDPOINT || DEFAULT_AZURE_LLM_ENDPOINT)
				&& hasValue(process.env.AZURE_LLM_KEY)
				&& hasValue(process.env.AZURE_LLM_MODEL),
		});
	case 'openrouter':
		return providerDependencyStatus({
			enabled,
			provider,
			configured:
				hasValue(process.env.OPENROUTER_API_KEY)
				&& hasValue(process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL),
		});
	case 'cloudflare':
		return providerDependencyStatus({
			enabled,
			provider,
			configured:
				hasValue(process.env.CF_AIG_TOKEN)
				&& hasValue(process.env.CF_AIG_BASE_URL)
				&& hasValue(process.env.CF_AIG_MODEL || DEFAULT_CF_AIG_MODEL),
		});
	default:
		return providerDependencyStatus({
			enabled,
			provider,
			configured: false,
		});
	}
}

function getGeminiDependency({
	enabled,
	geminiGroundingEnabled,
	modelProvider,
}) {
	const requiresGeminiModel = geminiGroundingEnabled && modelProvider === 'gemini';

	return dependencyStatus({
		enabled,
		configured:
			hasValue(process.env.GEMINI_API_KEY)
			&& (!requiresGeminiModel || hasValue(process.env.GEMINI_MODEL_NAME)),
	});
}

function getStatus() {
	const previewEnvironment = isRenderPreview();
	const modelProvider = getModelProvider();
	const telegramFlagEnabled = isEnabled(process.env.ENABLE_TELEGRAM_BOT);
	const telegramEnabled = telegramFlagEnabled && !previewEnvironment;
	const whatsappEnabled = isEnabled(process.env.ENABLE_WHATSAPP_ALERTS);
	const discordEnabled = isEnabled(process.env.ENABLE_DISCORD_ALERTS);
	const geminiGroundingEnabled = isEnabled(process.env.ENABLE_GEMINI_GROUNDING);
	const newsMonitorEnabled = isEnabled(process.env.ENABLE_NEWS_MONITOR);
	const forceBraveSearch = isEnabled(process.env.FORCE_BRAVE_SEARCH);
	const newsMonitorUsesGeminiSearch = newsMonitorEnabled && !forceBraveSearch;
	const newsMonitorUsesGeminiLlm = newsMonitorEnabled && modelProvider === 'gemini';
	const geminiEnabled = geminiGroundingEnabled || newsMonitorUsesGeminiSearch || newsMonitorUsesGeminiLlm;
	const marketScannerEnabled = isEnabled(process.env.ENABLE_MARKET_SCANNER);
	const tradingViewMcpEnrichmentEnabled = isEnabled(process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT);
	const tradingViewMcpEnabled = tradingViewMcpEnrichmentEnabled || marketScannerEnabled;
	const firestoreEnabled = isEnabled(process.env.ENABLE_FIRESTORE_ALERT_STORAGE);
	const sentryEnabled = isEnabled(process.env.ENABLE_SENTRY);
	const langfusePromptsEnabled = isEnabled(process.env.ENABLE_LANGFUSE_PROMPTS);
	const binancePriceCheckEnabled = isEnabled(process.env.ENABLE_BINANCE_PRICE_CHECK);
	const llmAlertEnrichmentEnabled = isEnabled(process.env.ENABLE_LLM_ALERT_ENRICHMENT);
	const llmAlertEnrichmentDependencyEnabled = llmAlertEnrichmentEnabled && newsMonitorEnabled;

	const telegram = dependencyStatus({
		enabled: telegramEnabled,
		configured: hasValue(process.env.BOT_TOKEN) && hasValue(process.env.TELEGRAM_CHAT_ID),
	});
	const whatsapp = dependencyStatus({
		enabled: whatsappEnabled,
		configured:
			hasValue(process.env.WHATSAPP_API_URL)
			&& hasValue(process.env.WHATSAPP_API_KEY)
			&& hasValue(process.env.WHATSAPP_CHAT_ID),
	});
	const discord = dependencyStatus({
		enabled: discordEnabled,
		configured: hasValue(process.env.DISCORD_WEBHOOK_URL),
	});
	const gemini = getGeminiDependency({
		enabled: geminiEnabled,
		geminiGroundingEnabled,
		modelProvider,
	});
	const tradingViewMcp = dependencyStatus({
		enabled: tradingViewMcpEnabled,
		configured: hasValue(process.env.TRADINGVIEW_MCP_URL || DEFAULT_TRADINGVIEW_MCP_URL),
	});
	const firestore = dependencyStatus({
		enabled: firestoreEnabled,
		configured:
			hasValidInlineFirestoreCredentials(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
			|| hasReadableFile(process.env.GOOGLE_APPLICATION_CREDENTIALS)
			|| isGoogleManagedRuntime(),
	});
	const sentry = dependencyStatus({
		enabled: sentryEnabled,
		configured: hasValue(process.env.SENTRY_DSN),
	});
	const langfuse = dependencyStatus({
		enabled: langfusePromptsEnabled,
		configured: hasValue(process.env.LANGFUSE_PUBLIC_KEY) && hasValue(process.env.LANGFUSE_SECRET_KEY),
	});
	const braveSearch = dependencyStatus({
		enabled: newsMonitorEnabled && forceBraveSearch,
		configured: hasValue(process.env.BRAVE_SEARCH_API_KEY),
	});
	const newsMonitorLlm = getNewsMonitorLlmDependency({
		enabled: newsMonitorEnabled,
		provider: newsMonitorEnabled ? modelProvider : null,
	});
	const llmAlertEnrichment = dependencyStatus({
		enabled: llmAlertEnrichmentDependencyEnabled,
		configured:
			hasValue(process.env.AZURE_LLM_ENDPOINT || DEFAULT_AZURE_LLM_ENDPOINT)
			&& hasValue(process.env.AZURE_LLM_KEY)
			&& hasValue(process.env.AZURE_LLM_MODEL),
	});
	const { getCacheInstance } = require('./webhooks/handlers/newsMonitor/cache');
	const cache = getCacheInstance();
	const newsMonitorDedupEnabled = isEnabled(process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP);
	const newsMonitorDedupConfigured = newsMonitorDedupEnabled && firestore.configured;
	const newsMonitorDedup = {
		enabled: newsMonitorDedupEnabled,
		configured: newsMonitorDedupConfigured,
		ready: cache.dedupMode.mode === 'persistent',
		status: getReadinessStatus({
			enabled: newsMonitorDedupEnabled,
			configured: cache.dedupMode.mode === 'persistent',
		}),
		mode: cache.dedupMode.mode,
		backend: cache.dedupMode.backend,
	};

	return {
		service: {
			name: process.env.SERVICE_NAME || packageJson.name || 'cabros-bot',
			version: packageJson.version || null,
			commit: getCommit(),
			environment: getEnvironment(),
		},
		featureFlags: {
			telegramBot: telegramFlagEnabled,
			whatsappAlerts: whatsappEnabled,
			discordAlerts: discordEnabled,
			geminiGrounding: geminiGroundingEnabled,
			newsMonitor: newsMonitorEnabled,
			tradingViewMcpEnrichment: tradingViewMcpEnrichmentEnabled,
			tradingViewConfluenceEnrichment: isEnabled(process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT),
			tradingViewConfluenceMultiTimeframe: isEnabled(process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME),
			firestoreAlertStorage: firestoreEnabled,
			sentryMonitoring: sentryEnabled,
			sentryProfiling: sentryEnabled && !!process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE,
			langfusePrompts: langfusePromptsEnabled,
			marketScanner: marketScannerEnabled,
			binancePriceCheck: binancePriceCheckEnabled,
			llmAlertEnrichment: llmAlertEnrichmentEnabled,
			signalOutcomeTracking: isEnabled(process.env.ENABLE_SIGNAL_OUTCOME_TRACKING),
		},
		deliveryChannels: {
			telegram: {
				enabled: telegram.ready,
				status: telegram.status,
			},
			whatsapp: {
				enabled: whatsapp.ready,
				status: whatsapp.status,
			},
			discord: {
				enabled: discord.ready,
				status: discord.status,
			},
		},
		dependencies: {
			telegram,
			whatsapp,
			discord,
			gemini,
			tradingViewMcp,
			firestore,
			sentry,
			langfuse,
			braveSearch,
			newsMonitorLlm,
		llmAlertEnrichment,
		cloudflareAig: dependencyStatus({
			enabled: isEnabled(process.env.ENABLE_CLOUDFLARE_AIG),
			configured:
				hasValue(process.env.CF_AIG_TOKEN)
				&& hasValue(process.env.CF_AIG_BASE_URL)
				&& hasValue(process.env.CF_AIG_MODEL || DEFAULT_CF_AIG_MODEL),
		}),
		newsMonitorDedup,
		},
	};
}

function getApiStatus(req, res) {
	return res.status(200).json(getStatus());
}

module.exports = {
	getApiStatus,
	getStatus,
};
