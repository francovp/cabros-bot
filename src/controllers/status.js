function toBool(value) {
	return value === 'true';
}

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function getCommit() {
	return process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null;
}

function getEnvironment() {
	if (process.env.RENDER === 'true' && process.env.IS_PULL_REQUEST === 'true') {
		return 'preview';
	}

	if (process.env.NODE_ENV) {
		return process.env.NODE_ENV;
	}

	return 'development';
}

function getStatus() {
	const telegramEnabled = toBool(process.env.ENABLE_TELEGRAM_BOT);
	const whatsappEnabled = toBool(process.env.ENABLE_WHATSAPP_ALERTS);
	const geminiEnabled = toBool(process.env.ENABLE_GEMINI_GROUNDING);
	const newsMonitorEnabled = toBool(process.env.ENABLE_NEWS_MONITOR);
	const tradingViewMcpEnabled = toBool(process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT);
	const firestoreEnabled = toBool(process.env.ENABLE_FIRESTORE_ALERT_STORAGE);
	const sentryEnabled = toBool(process.env.ENABLE_SENTRY);

	return {
		service: {
			name: process.env.SERVICE_NAME || 'cabros-bot',
			commit: getCommit(),
			environment: getEnvironment(),
			timestamp: new Date().toISOString(),
		},
		featureFlags: {
			telegramBot: telegramEnabled,
			whatsappAlerts: whatsappEnabled,
			geminiGrounding: geminiEnabled,
			newsMonitor: newsMonitorEnabled,
			tradingViewMcpEnrichment: tradingViewMcpEnabled,
			firestoreAlertStorage: firestoreEnabled,
			sentryMonitoring: sentryEnabled,
		},
		deliveryChannels: {
			telegram: {
				enabled: telegramEnabled,
				configured: hasValue(process.env.BOT_TOKEN) && hasValue(process.env.TELEGRAM_CHAT_ID),
			},
			whatsapp: {
				enabled: whatsappEnabled,
				configured:
					hasValue(process.env.WHATSAPP_API_URL)
					&& hasValue(process.env.WHATSAPP_API_KEY)
					&& hasValue(process.env.WHATSAPP_CHAT_ID),
			},
		},
		dependencies: {
			telegram: {
				enabled: telegramEnabled,
				configured: hasValue(process.env.BOT_TOKEN) && hasValue(process.env.TELEGRAM_CHAT_ID),
			},
			whatsapp: {
				enabled: whatsappEnabled,
				configured:
					hasValue(process.env.WHATSAPP_API_URL)
					&& hasValue(process.env.WHATSAPP_API_KEY)
					&& hasValue(process.env.WHATSAPP_CHAT_ID),
			},
			gemini: {
				enabled: geminiEnabled,
				configured: hasValue(process.env.GEMINI_API_KEY),
			},
			tradingViewMcp: {
				enabled: tradingViewMcpEnabled,
				configured: hasValue(process.env.TRADINGVIEW_MCP_URL),
			},
			firestore: {
				enabled: firestoreEnabled,
				configured:
					hasValue(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
					|| hasValue(process.env.GOOGLE_APPLICATION_CREDENTIALS),
			},
			sentry: {
				enabled: sentryEnabled,
				configured: hasValue(process.env.SENTRY_DSN),
			},
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
