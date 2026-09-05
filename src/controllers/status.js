const packageJson = require('../../package.json');
const sentryService = require('../services/monitoring/SentryService');
const {
	scannerPresetService,
	scannerPresetSchedulerService,
} = require('../services/scannerPresets');
const { newsMonitorSchedulerService } = require('../services/newsMonitorScheduler');
const idempotencyStorageService = require('../services/storage/IdempotencyStorageService');
const { isFirestoreConfigured } = require('../services/storage/firestoreConfig');
const SignalOutcomeService = require('../services/storage/SignalOutcomeService');
const { jobQueue } = require('../services/jobs/JobQueue');
const equityMarketDataService = require('../services/storage/EquityMarketDataService');
const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');
const { tradingViewMcpService } = require('../services/tradingview/TradingViewMcpService');
const { binanceOrderService } = require('../services/trading/BinanceOrderService');
const { binanceOrderAuditService } = require('../services/trading/BinanceOrderAuditService');
const bootstrapReadiness = require('../lib/bootstrapReadiness');
const { notificationRedriveService } = require('../services/notification/NotificationRedriveService');
const { deliveryMetricsService } = require('../services/notification/DeliveryMetricsService');
const { whatsAppCommandBridgeService } = require('../services/notification/WhatsAppCommandBridgeService');
const geminiQuotaManager = require('../services/grounding/geminiQuotaManager');
const groundingMetrics = require('../services/grounding/metrics');
const { signalRepeatCooldown } = require('../services/alerts/signalRepeatCooldown');
const { getCoalescingStatus } = require('../services/grounding/grounding');
const {
	isNewsMonitorPaused,
	getNewsMonitorPauseState,
} = require('./webhooks/handlers/newsMonitor/pauseState');
const {
	getDeploymentCommit,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
} = require('../lib/deploymentEnvironment');
const DEFAULT_AZURE_LLM_ENDPOINT = 'https://models.github.ai/inference';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.0-flash-001';
const DEFAULT_CF_AIG_MODEL = 'google-ai-studio/gemini-2.5-flash';

function isEnabled(value) {
	return value === 'true';
}

function hasValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function getModelProvider() {
	return typeof process.env.MODEL_PROVIDER === 'string' && process.env.MODEL_PROVIDER.trim().length > 0
		? process.env.MODEL_PROVIDER.trim().toLowerCase()
		: 'gemini';
}

function getCommit() {
	return getDeploymentCommit();
}

function isPreview() {
	return isPreviewEnvironment();
}

function getEnvironment() {
	if (process.env.SENTRY_ENVIRONMENT) {
		return process.env.SENTRY_ENVIRONMENT;
	}

	if (isPreview()) {
		return 'preview';
	}

	if (isProductionLikeEnvironment()) {
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

function getGeminiQuotaDependency({ gemini }) {
	const snapshot = geminiQuotaManager.getSnapshot();
	const status = !gemini.enabled
		? 'disabled'
		: (!gemini.configured
			? 'misconfigured'
			: (snapshot.cooldownActive ? 'degraded' : 'ready'));

	return {
		enabled: gemini.enabled,
		configured: gemini.configured,
		ready: gemini.ready && !snapshot.cooldownActive,
		status,
		cooldownActive: snapshot.cooldownActive,
		remainingCooldownMs: snapshot.remainingCooldownMs,
		lastTriggeredAt: snapshot.lastTriggeredAt,
		triggersTotal: snapshot.triggersTotal,
		braveFallbacksDuringCooldown: snapshot.braveFallbacksDuringCooldown,
		lastBraveFallbackAt: snapshot.lastBraveFallbackAt,
		metrics: groundingMetrics.getSnapshot(),
	};
}


function getStatus() {
	const previewEnvironment = isPreview();
	const modelProvider = getModelProvider();
	const runtimeConfig = remoteConfigService.getRuntimeConfig();
	const telegramFlagEnabled = isEnabled(process.env.ENABLE_TELEGRAM_BOT);
	const telegramEnabled = telegramFlagEnabled && !previewEnvironment;
	const whatsappEnabled = isEnabled(process.env.ENABLE_WHATSAPP_ALERTS);
	const discordEnabled = isEnabled(process.env.ENABLE_DISCORD_ALERTS);
	const geminiGroundingEnabled = runtimeConfig.ENABLE_GEMINI_GROUNDING;
	const newsMonitorEnabled = isEnabled(process.env.ENABLE_NEWS_MONITOR);
	const newsMonitorTestModeEnabled = isEnabled(process.env.ENABLE_NEWS_MONITOR_TEST_MODE);
	const forceBraveSearch = isEnabled(process.env.FORCE_BRAVE_SEARCH);
	const newsMonitorUsesGeminiSearch = newsMonitorEnabled && !forceBraveSearch;
	const newsMonitorUsesGeminiLlm = newsMonitorEnabled && modelProvider === 'gemini';
	const geminiEnabled = geminiGroundingEnabled || newsMonitorUsesGeminiSearch || newsMonitorUsesGeminiLlm;
	const marketScannerEnabled = runtimeConfig.ENABLE_MARKET_SCANNER;
	const tradingViewMcpEnrichmentEnabled = runtimeConfig.ENABLE_TRADINGVIEW_MCP_ENRICHMENT;
	const tradingViewVolumeConfirmationFlagEnabled = runtimeConfig.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION;
	const tradingViewVolumeConfirmationEnabled = tradingViewVolumeConfirmationFlagEnabled && tradingViewMcpEnrichmentEnabled;
	const observedTradingViewMcpStatus = tradingViewMcpService.getStatus({ enabled: true });
	const tradingViewMcpEnabled =
		tradingViewMcpEnrichmentEnabled
		|| marketScannerEnabled
		|| observedTradingViewMcpStatus.lastCheckedAt !== null;
	const firestoreEnabled = isEnabled(process.env.ENABLE_FIRESTORE_ALERT_STORAGE);
	const firestoreScannerPresetsEnabled = isEnabled(process.env.ENABLE_FIRESTORE_SCANNER_PRESETS);
	const firestoreJobStorageEnabled = isEnabled(process.env.ENABLE_FIRESTORE_JOB_STORAGE)
		|| firestoreEnabled;
	const sentryEnabled = isEnabled(process.env.ENABLE_SENTRY);
	const langfusePromptsEnabled = isEnabled(process.env.ENABLE_LANGFUSE_PROMPTS);
	const binancePriceCheckEnabled = isEnabled(process.env.ENABLE_BINANCE_PRICE_CHECK);
	const binanceTradingEnabled = isEnabled(process.env.ENABLE_BINANCE_TRADING);
	const binanceTradingStatus = binanceOrderService.getStatus();
	const llmAlertEnrichmentEnabled = isEnabled(process.env.ENABLE_LLM_ALERT_ENRICHMENT);
	const cloudflareAigEnabled = isEnabled(process.env.ENABLE_CLOUDFLARE_AIG);
	const messageFooterMetadataEnabled = runtimeConfig.ENABLE_MESSAGE_FOOTER_METADATA;
	const remoteConfigStatus = remoteConfigService.getStatus();
	const signalOutcomeTrackingEnabled = isEnabled(process.env.ENABLE_SIGNAL_OUTCOME_TRACKING);
	const equityMarketDataStatus = equityMarketDataService.getStatus();
	const llmAlertEnrichmentDependencyEnabled = llmAlertEnrichmentEnabled && newsMonitorEnabled;

	const telegram = dependencyStatus({
		enabled: telegramEnabled,
		configured: hasValue(process.env.BOT_TOKEN) && hasValue(process.env.TELEGRAM_CHAT_ID),
	});
	const whatsappChatId = previewEnvironment
		? process.env.WHATSAPP_PREVIEW_CHAT_ID || process.env.WHATSAPP_CHAT_ID
		: process.env.WHATSAPP_CHAT_ID;
	const whatsapp = dependencyStatus({
		enabled: whatsappEnabled,
		configured:
			hasValue(process.env.WHATSAPP_API_URL)
			&& hasValue(process.env.WHATSAPP_API_KEY)
			&& hasValue(whatsappChatId),
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
	const geminiQuota = getGeminiQuotaDependency({ gemini });
	const tradingViewRuntimeStatus = tradingViewMcpService.getStatus({ enabled: tradingViewMcpEnabled });
	const tradingViewMcp = tradingViewRuntimeStatus;
	const tradingViewVolumeConfirmation = tradingViewMcpService.getVolumeConfirmationStatus({
		enabled: tradingViewVolumeConfirmationEnabled,
	});
	const firestore = dependencyStatus({
		enabled: firestoreEnabled,
		configured: isFirestoreConfigured(),
	});
	const firestoreJobStorage = dependencyStatus({
		enabled: firestoreJobStorageEnabled,
		configured: firestore.configured,
	});
	const sentryProfilingEnabled = sentryEnabled
		&& hasValue(process.env.SENTRY_DSN)
		&& hasValue(process.env.SENTRY_TRACES_SAMPLE_RATE);
	const sentry = {
		...dependencyStatus({
			enabled: sentryEnabled,
			configured: hasValue(process.env.SENTRY_DSN),
		}),
		profiling: dependencyStatus({
			enabled: sentryProfilingEnabled,
			configured: hasValue(process.env.SENTRY_PROFILE_SESSION_SAMPLE_RATE),
		}),
	};
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
	const newsMonitorDedupEnabled = runtimeConfig.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
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

	const signalOutcomeWorkerStatus = SignalOutcomeService.getWorkerStatus();
	const jobExecutionQueueStatus = jobQueue.getStatus();
	const signalOutcomeWorkerDependency = dependencyStatus({
		enabled: signalOutcomeWorkerStatus.enabled,
		configured: firestore.configured,
	});
	if (signalOutcomeWorkerStatus.role === 'disabled') {
		signalOutcomeWorkerDependency.ready = false;
		signalOutcomeWorkerDependency.status = 'disabled';
	}

	const webhookAuth = dependencyStatus({
		enabled: true,
		configured: hasValue(process.env.WEBHOOK_API_KEY),
	});

	return {
		readiness: bootstrapReadiness.getStatus(),
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
			newsMonitorPaused: isNewsMonitorPaused(),
			newsMonitorTestMode: newsMonitorTestModeEnabled,
			tradingViewMcpEnrichment: tradingViewMcpEnrichmentEnabled,
			tradingViewVolumeConfirmation: tradingViewVolumeConfirmationFlagEnabled,
			tradingViewConfluenceEnrichment: isEnabled(process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT),
			tradingViewConfluenceMultiTimeframe: isEnabled(process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME),
			firestoreAlertStorage: firestoreEnabled,
			firestoreScannerPresets: firestoreScannerPresetsEnabled,
			firestoreJobStorage: firestoreJobStorageEnabled,
			scannerPresetScheduler: scannerPresetSchedulerService.isEnabled(),
			newsMonitorScheduler: newsMonitorSchedulerService.isEnabled(),
			sentryMonitoring: sentryEnabled,
			sentryProfiling: sentryService.isProfilingEnabled(),
			langfusePrompts: langfusePromptsEnabled,
			marketScanner: marketScannerEnabled,
			binancePriceCheck: binancePriceCheckEnabled,
			binanceTrading: binanceTradingEnabled,
			binanceOrderAudit: binanceOrderAuditService.isEnabled(),
			llmAlertEnrichment: llmAlertEnrichmentEnabled,
			cloudflareAig: cloudflareAigEnabled,
			messageFooterMetadata: messageFooterMetadataEnabled,
			signalOutcomeTracking: signalOutcomeTrackingEnabled,
			equityMarketData: equityMarketDataStatus.enabled,
			firestoreIdempotency: idempotencyStorageService.isEnabled(),
			firebaseRemoteConfig: remoteConfigStatus.enabled,
			jobExecutionWorker: jobExecutionQueueStatus.enabled || process.env.JOB_EXECUTION_MODE === 'firestore-poller',
			notificationRedrive: notificationRedriveService.isEnabled(),
			alertSignalRepeatSuppression: signalRepeatCooldown.isEnabled(),
			whatsappCommands: whatsAppCommandBridgeService.isEnabled(),
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
		...(deliveryMetricsService.getSnapshot()
			? { deliveryMetrics: deliveryMetricsService.getSnapshot() }
			: {}),
		dependencies: {
			telegram,
			whatsapp,
			discord,
			webhookAuth,
			whatsappCommandBridge: whatsAppCommandBridgeService.getStatus(),
			gemini,
			geminiQuota,
			groundingCoalescing: getCoalescingStatus(),
			tradingViewMcp,
			tradingViewVolumeConfirmation,
			firestore,
			firestoreJobStorage,
			sentry,
			langfuse,
			braveSearch,
			newsMonitor: {
				enabled: newsMonitorEnabled,
				...getNewsMonitorPauseState(),
			},
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
			idempotencyStorage: idempotencyStorageService.getStorageStatus(),
			firebaseRemoteConfig: remoteConfigStatus,
			scannerPresetStorage: scannerPresetService.getStorageStatus(),
			scannerPresetScheduler: scannerPresetSchedulerService.getStatus(),
			newsMonitorScheduler: newsMonitorSchedulerService.getStatus(),
			equityMarketData: equityMarketDataStatus,
			signalOutcomeWorker: {
				...signalOutcomeWorkerDependency,
				role: signalOutcomeWorkerStatus.role,
				running: signalOutcomeWorkerStatus.running,
				shutdownRequested: signalOutcomeWorkerStatus.shutdownRequested,
				intervalMs: signalOutcomeWorkerStatus.intervalMs,
				batchLimit: signalOutcomeWorkerStatus.batchLimit,
				maxDurationMs: signalOutcomeWorkerStatus.maxDurationMs,
				isEvaluating: signalOutcomeWorkerStatus.isEvaluating,
				lastRunAt: signalOutcomeWorkerStatus.lastRunAt,
				lastRunDurationMs: signalOutcomeWorkerStatus.lastRunDurationMs,
				lastRunScannedCount: signalOutcomeWorkerStatus.lastRunScannedCount,
				lastRunEvaluatedCount: signalOutcomeWorkerStatus.lastRunEvaluatedCount,
				lastRunPendingCount: signalOutcomeWorkerStatus.lastRunPendingCount,
				lastRunErrorCount: signalOutcomeWorkerStatus.lastRunErrorCount,
			},
			notificationRedrive: notificationRedriveService.getStatus(),
			alertSignalRepeatSuppression: {
				enabled: signalRepeatCooldown.isEnabled(),
				...signalRepeatCooldown.getStats(),
			},
			jobExecutionQueue: jobExecutionQueueStatus,
			binanceTrading: binanceTradingStatus,
			binanceOrderAudit: binanceOrderAuditService.getStatus(),
		},
	};
}

function getApiStatus(req, res) {
	try {
		return res.status(200).json(getStatus());
	} catch (error) {
		console.error('[StatusController] getStatus failed:', error);
		return res.status(500).json({ error: error.message, code: 'INTERNAL_ERROR' });
	}
}

module.exports = {
	getApiStatus,
	getStatus,
};
