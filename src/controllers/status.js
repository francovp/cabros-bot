const packageJson = require('../../package.json');

const DEFAULT_TRADINGVIEW_MCP_URL = 'https://tradingview-mcp.onrender.com/mcp';

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
		|| hasValue(process.env.GOOGLE_CLOUD_PROJECT)
		|| hasValue(process.env.GCP_PROJECT)
		|| hasValue(process.env.GCLOUD_PROJECT)
		|| hasValue(process.env.GAE_SERVICE)
	);
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

function getStatus() {
	const previewEnvironment = isRenderPreview();
	const telegramFlagEnabled = isEnabled(process.env.ENABLE_TELEGRAM_BOT);
	const telegramEnabled = telegramFlagEnabled && !previewEnvironment;
	const whatsappEnabled = isEnabled(process.env.ENABLE_WHATSAPP_ALERTS);
	const geminiEnabled = isEnabled(process.env.ENABLE_GEMINI_GROUNDING);
	const newsMonitorEnabled = isEnabled(process.env.ENABLE_NEWS_MONITOR);
	const tradingViewMcpEnabled = isEnabled(process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT);
	const firestoreEnabled = isEnabled(process.env.ENABLE_FIRESTORE_ALERT_STORAGE);
	const sentryEnabled = isEnabled(process.env.ENABLE_SENTRY);
	const langfusePromptsEnabled = isEnabled(process.env.ENABLE_LANGFUSE_PROMPTS);
	const marketScannerEnabled = isEnabled(process.env.ENABLE_MARKET_SCANNER);
	const binancePriceCheckEnabled = isEnabled(process.env.ENABLE_BINANCE_PRICE_CHECK);
	const llmAlertEnrichmentEnabled = isEnabled(process.env.ENABLE_LLM_ALERT_ENRICHMENT);

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
	const gemini = dependencyStatus({
		enabled: geminiEnabled,
		configured: hasValue(process.env.GEMINI_API_KEY),
	});
	const tradingViewMcp = dependencyStatus({
		enabled: tradingViewMcpEnabled,
		configured: hasValue(process.env.TRADINGVIEW_MCP_URL || DEFAULT_TRADINGVIEW_MCP_URL),
	});
	const firestore = dependencyStatus({
		enabled: firestoreEnabled,
		configured:
			hasValue(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
			|| hasValue(process.env.GOOGLE_APPLICATION_CREDENTIALS)
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
			geminiGrounding: geminiEnabled,
			newsMonitor: newsMonitorEnabled,
			tradingViewMcpEnrichment: tradingViewMcpEnabled,
			firestoreAlertStorage: firestoreEnabled,
			sentryMonitoring: sentryEnabled,
			langfusePrompts: langfusePromptsEnabled,
			marketScanner: marketScannerEnabled,
			binancePriceCheck: binancePriceCheckEnabled,
			llmAlertEnrichment: llmAlertEnrichmentEnabled,
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
		},
		dependencies: {
			telegram,
			whatsapp,
			gemini,
			tradingViewMcp,
			firestore,
			sentry,
			langfuse,
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
