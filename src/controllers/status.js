const packageJson = require('../../package.json');
const sentryService = require('../services/monitoring/SentryService');
const {
	scannerPresetService,
	scannerPresetSchedulerService,
} = require('../services/scannerPresets');
const { newsMonitorSchedulerService } = require('../services/newsMonitorScheduler');
const { alertSchedulerService } = require('../services/scheduler');
const idempotencyStorageService = require('../services/storage/IdempotencyStorageService');
const alertFeedbackStorageService = require('../services/storage/AlertFeedbackStorageService');
const { isFirestoreConfigured } = require('../services/storage/firestoreConfig');
const SignalOutcomeService = require('../services/storage/SignalOutcomeService');
const { jobQueue } = require('../services/jobs/JobQueue');
const equityMarketDataService = require('../services/storage/EquityMarketDataService');
const remoteConfigService = require('../services/remoteConfig/RemoteConfigService');
const { tradingViewMcpService } = require('../services/tradingview/TradingViewMcpService');
const { binanceOrderService } = require('../services/trading/BinanceOrderService');
const { binanceOrderAuditService } = require('../services/trading/BinanceOrderAuditService');
const symbolAnalysisStorageService = require('../services/storage/SymbolAnalysisStorageService');
const { chatPreferenceService } = require('../services/preferences/ChatPreferenceService');
const bootstrapReadiness = require('../lib/bootstrapReadiness');
const { notificationRedriveService } = require('../services/notification/NotificationRedriveService');
const { getAdminPagingStatus } = require('../services/notification/adminPagingStatus');
const { deliveryMetricsService } = require('../services/notification/DeliveryMetricsService');
const { firestoreWriteMetricsService, READ_HEALTH } = require('../services/storage/FirestoreWriteMetricsService');
const { getPromptService } = require('../services/prompts');
const { signalClassMetrics } = require('../services/alerts/signalClassifier');
const { whatsAppCommandBridgeService } = require('../services/notification/WhatsAppCommandBridgeService');
const { getWhatsAppTemplateStatus } = require('../services/notification/WhatsAppService');
const geminiQuotaManager = require('../services/grounding/geminiQuotaManager');
const groundingMetrics = require('../services/grounding/metrics');
const { signalRepeatCooldown } = require('../services/alerts/signalRepeatCooldown');
const { burstAggregator } = require('../services/alerts/burstAggregator');
const { userPriceAlertService } = require('../services/alerts/UserPriceAlertService');
const { alertModeration } = require('../services/alerts/alertModeration');
const { getCoalescingStatus } = require('../services/grounding/grounding');
const { getPromptReadiness } = require('../services/prompts/promptReadiness');
const newsAnalysisStorageService = require('../services/storage/NewsAnalysisStorageService');
const {
	isNewsMonitorPaused,
	getNewsMonitorPauseState,
} = require('./webhooks/handlers/newsMonitor/pauseState');
const { getVolumeTracker } = require('./webhooks/handlers/newsMonitor/volumeTracker');
const { getSelfTestService } = require('./diagnostics/selftest');
const telegramCommandAuth = require('../lib/telegramCommandAuth');
const {
	getDeploymentCommit,
	isPreviewEnvironment,
	isProductionLikeEnvironment,
} = require('../lib/deploymentEnvironment');
const {
	getLastRunAt: getTestAlertLastRunAt,
	getLastRunStatus: getTestAlertLastRunStatus,
	getRateLimitState: getTestAlertRateLimitState,
	isTestAlertEnabled,
} = require('./admin/testAlert');
const { tokenCostBudgetService } = require('../lib/tokenUsage');
const { isMaintenanceModeEnabled } = require('../lib/maintenanceMode');
const { getValidApiKeys } = require('../lib/auth');
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

/**
 * Issue #1178. `ready` comes from observed prompt resolutions, not from credential
 * shape, so flipping `ENABLE_LANGFUSE_PROMPTS=true` cannot make a deployment that
 * falls back to the local prompt file report itself as ready.
 *
 * `schemaDrift` is the rollout signal for a Langfuse prompt that has not been
 * republished after a local-fallback contract change (#1031): it is not a failure,
 * but it does mean the managed prompt is behind the code.
 */
function getLangfusePromptDependencyStatus(langfusePromptsEnabled) {
	const status = getPromptReadiness().getStatus();

	if (!langfusePromptsEnabled) {
		return status;
	}

	const drift = getPromptService().getSchemaDriftStatus();
	if (Object.keys(drift).length === 0) {
		return status;
	}

	return {
		...status,
		schemaDrift: Object.values(drift),
	};
}

/**
 * Fold observed read health into the Firestore dependency verdict.
 *
 * Issue #1285: `dependencies.firestore.ready` was derived purely from
 * `enabled && configured`, and `configured` only checks that a credential blob
 * parses with a valid private key. So a deployment whose writes succeeded 29/29
 * and whose every read query was rejected still reported `ready: true` — the
 * status endpoint could not distinguish a working Firestore from a broken one.
 *
 * Read health is applied only once a read has actually been observed, so the
 * pre-existing `{ enabled, configured, ready, status }` shape is byte-identical
 * for deployments that have not read yet. An untouched read path stays
 * `ready: true` rather than flipping to a state that would imply breakage.
 */
function withFirestoreReadHealth(status) {
	const readMetrics = firestoreWriteMetricsService.getReadSnapshot();
	if (!readMetrics) {
		return status;
	}
	const base = {
		...status,
		readHealth: readMetrics.readHealth,
	};
	if (readMetrics.readHealth !== READ_HEALTH.DEGRADED) {
		return base;
	}
	return {
		...base,
		ready: false,
		status: 'degraded',
		readsFailed: readMetrics.readsFailed,
		consecutiveReadFailures: readMetrics.consecutiveReadFailures,
		lastReadErrorCategory: readMetrics.lastErrorCategory,
		lastReadFailureAt: readMetrics.lastReadFailureAt,
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


function getStatus({ skipTelemetrySync = false } = {}) {
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
	const signalClassMarkerEnabled = runtimeConfig.ENABLE_SIGNAL_CLASS_MARKER;
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
	const grounding = geminiGroundingEnabled
		? {
			enabled: true,
			configured: gemini.configured,
			ready: gemini.ready,
			status: gemini.status,
			metrics: groundingMetrics.getMetrics(),
		}
		: null;
	const tradingViewRuntimeStatus = tradingViewMcpService.getStatus({ enabled: tradingViewMcpEnabled });
	const tradingViewMcp = {
		...tradingViewRuntimeStatus,
		errorCategoryCounts: tradingViewMcpService.getScannerErrorCategoryCounts(),
	};
	if (tradingViewMcpEnrichmentEnabled) {
		tradingViewMcp.toolMetrics = tradingViewMcpService.getToolMetrics();
	} else {
		delete tradingViewMcp.toolMetrics;
	}
	const tradingViewVolumeConfirmation = tradingViewMcpService.getVolumeConfirmationStatus({
		enabled: tradingViewVolumeConfirmationEnabled,
	});
	const firestore = withFirestoreReadHealth(dependencyStatus({
		enabled: firestoreEnabled,
		configured: isFirestoreConfigured(),
	}));
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
	const langfuse = getLangfusePromptDependencyStatus(langfusePromptsEnabled);
	// Configuration/reachability (dependencies.langfuse) says nothing about whether
	// prompts are actually served remotely. Keep the two facts apart so a 100%
	// local-fallback regression is visible instead of silent.
	let langfusePrompts;
	try {
		langfusePrompts = getPromptService().getPromptResolutionStatus();
	} catch (error) {
		console.warn(`[status] Failed to read prompt-resolution telemetry: ${error.message}`);
		// Emit the documented fail-open verdict rather than omitting the key: a
		// consumer reading status.dependencies.langfusePrompts.servingStatus would
		// otherwise get a TypeError on exactly the path where telemetry is broken.
		langfusePrompts = {
			enabled: langfusePromptsEnabled,
			configured: hasValue(process.env.LANGFUSE_PUBLIC_KEY) && hasValue(process.env.LANGFUSE_SECRET_KEY),
			ready: false,
			servingStatus: 'unknown',
			servingPrompts: false,
			lastErrorCategory: null,
			consecutiveFailures: 0,
			prompts: [],
		};
	}
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
	const { getURLShortener } = require('./webhooks/handlers/newsMonitor/urlShortener');
	const cache = getCacheInstance();
	const urlShortener = getURLShortener();
	const newsMonitorDedupEnabled = runtimeConfig.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
	const newsMonitorDedupConfigured = newsMonitorDedupEnabled && firestore.configured;
	const newsMonitorCacheSize = {
		entries: cache.cache.size,
		maxEntries: cache.maxEntries,
		evictionCount: cache._evictionCount,
		deliveryLocks: cache.deliveryLocks.size,
		deliveryLockMaxEntries: cache.deliveryLockMaxEntries,
		deliveryLockEvictionCount: cache._deliveryLockEvictionCount,
		urlShortenerCache: urlShortener.cache.getStats(),
		urlShortenerServiceFailures: urlShortener.serviceFailuresStats,
	};
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
		cacheSize: newsMonitorCacheSize,
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
		configured: getValidApiKeys().length > 0,
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
			newsMonitorClassifier: isEnabled(process.env.ENABLE_NEWS_MONITOR_CLASSIFIER),
			tradingViewMcpEnrichment: tradingViewMcpEnrichmentEnabled,
			tradingViewVolumeConfirmation: tradingViewVolumeConfirmationFlagEnabled,
			tradingViewConfluenceEnrichment: isEnabled(process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT),
			tradingViewConfluenceMultiTimeframe: isEnabled(process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME),
			firestoreAlertStorage: firestoreEnabled,
			firestoreScannerPresets: firestoreScannerPresetsEnabled,
			firestoreJobStorage: firestoreJobStorageEnabled,
			firestoreNewsAnalysis: newsAnalysisStorageService.isEnabled(),
			firestoreChatPreferences: chatPreferenceService.isEnabled(),
			scannerPresetScheduler: scannerPresetSchedulerService.isEnabled(),
			newsMonitorScheduler: newsMonitorSchedulerService.isEnabled(),
			alertScheduler: alertSchedulerService.isEnabled(),
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
			alertBurstAggregation: burstAggregator.isEnabled(),
			alertModeration: alertModeration.isEnabled(),
			whatsappCommands: whatsAppCommandBridgeService.isEnabled(),
			userPriceAlerts: userPriceAlertService.isEnabled(),
			alertFeedback: alertFeedbackStorageService.isEnabled(),
			symbolAnalysisStorage: symbolAnalysisStorageService.isEnabled(),
			whatsappTemplateMode: !!process.env.WHATSAPP_TEMPLATE_NAME,
			testAlert: isTestAlertEnabled(),
			tokenCostBudget: tokenCostBudgetService.isEnabled(),
			signalClassMarker: signalClassMarkerEnabled,
			maintenanceMode: isMaintenanceModeEnabled(),
			telegramCommandAuth: telegramCommandAuth.getStatus().enabled,
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
		// Operator intent, not runtime reachability. Mirrors
		// NotificationChannel.isConfigured(), which is the enable flag AND the
		// required credentials — i.e. exactly the `ready` semantics of
		// dependencyStatus. Deriving this from `ready` (not `configured` alone)
		// is what keeps this consistent with the zero-channel admin page, which
		// calls the same method; using `configured` alone would report a channel
		// with a webhook URL but a disabled flag as "configured" and contradict
		// the page that reported it as unconfigured.
		notificationChannelIntent: {
			configured: [
				{ name: 'telegram', ready: telegram.ready },
				{ name: 'whatsapp', ready: whatsapp.ready },
				{ name: 'discord', ready: discord.ready },
			].filter((channel) => channel.ready).map((channel) => channel.name),
			unconfigured: [
				{ name: 'telegram', ready: telegram.ready },
				{ name: 'whatsapp', ready: whatsapp.ready },
				{ name: 'discord', ready: discord.ready },
			].filter((channel) => !channel.ready).map((channel) => channel.name),
		},
		...(deliveryMetricsService.getSnapshot()
			? { deliveryMetrics: deliveryMetricsService.getSnapshot() }
			: {}),
		// Non-secret operator-paging health. Lets an operator tell a working admin path from
		// a silent one: readiness alone reports "ready" for a channel that is 0/N at runtime.
		// Channel names and counters only — never tokens, webhook URLs, or chat IDs.
		...(getAdminPagingStatus()
			? { adminPaging: getAdminPagingStatus() }
			: {}),
		dependencies: {
			telegram,
			whatsapp,
			discord,
			webhookAuth,
			whatsappCommandBridge: whatsAppCommandBridgeService.getStatus(),
			whatsappTemplate: getWhatsAppTemplateStatus(),
			gemini,
			geminiQuota,
			groundingCoalescing: getCoalescingStatus(),
			...(grounding ? { grounding } : {}),
			tradingViewMcp,
			tradingViewVolumeConfirmation,
			firestore,
			firestoreJobStorage,
			...(firestoreWriteMetricsService.getSnapshot()
				? { firestoreWriteMetrics: firestoreWriteMetricsService.getSnapshot() }
				: {}),
			// `featureFlags.signalClassMarker: true` only says the badge marker
			// is allowed to render; it says nothing about whether alerts are
			// actually being classified. Expose the population rate so a silent
			// regression back to 100% `unknown` is detectable from /api/status
			// instead of looking healthy.
			...(signalClassMetrics.getSnapshot()
				? { signalClassClassification: signalClassMetrics.getSnapshot() }
				: {}),
			...(firestoreWriteMetricsService.getReadSnapshot()
				? { firestoreReadMetrics: firestoreWriteMetricsService.getReadSnapshot() }
				: {}),
			sentry,
			langfuse,
			...(langfusePrompts ? { langfusePrompts } : {}),
			braveSearch,
			newsMonitor: {
				enabled: newsMonitorEnabled,
				...getNewsMonitorPauseState(),
				...getVolumeTracker().getWindowUsage(),
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
			chatPreferences: chatPreferenceService.getStatus(),
			scannerPresetStorage: scannerPresetService.getStorageStatus(),
			newsAnalysisStorage: newsAnalysisStorageService.getStorageStatus(),
			scannerPresetScheduler: scannerPresetSchedulerService.getStatus(),
			userPriceAlertWorker: userPriceAlertService.getStatus(),
			newsMonitorScheduler: newsMonitorSchedulerService.getStatus(),
			alertScheduler: alertSchedulerService.getStatus(),
			equityMarketData: equityMarketDataStatus,
			signalOutcomeWorker: {
				...signalOutcomeWorkerDependency,
				entryPriceSources: signalOutcomeWorkerStatus.entryPriceSources,
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
				leaseMs: signalOutcomeWorkerStatus.leaseMs,
				lastRunLeaseHeld: signalOutcomeWorkerStatus.lastRunLeaseHeld,
				leaseHeldSkipCount: signalOutcomeWorkerStatus.leaseHeldSkipCount,
			},
			notificationRedrive: notificationRedriveService.getStatus({ skipTelemetrySync }),
			alertSignalRepeatSuppression: {
				enabled: signalRepeatCooldown.isEnabled(),
				...signalRepeatCooldown.getStats(),
			},
			alertBurstAggregation: {
				enabled: burstAggregator.isEnabled(),
				...burstAggregator.getStats(),
			},
			alertModeration: {
				enabled: alertModeration.isEnabled(),
				...alertModeration.getStats(),
			},
			alertFeedback: alertFeedbackStorageService.getStatus(),
			jobExecutionQueue: jobExecutionQueueStatus,
			binanceTrading: binanceTradingStatus,
			binanceOrderAudit: binanceOrderAuditService.getStatus(),
			symbolAnalysisStorage: symbolAnalysisStorageService.getStatus(),
			testAlert: {
				enabled: isTestAlertEnabled(),
				lastRunAt: getTestAlertLastRunAt(),
				lastRunStatus: getTestAlertLastRunStatus(),
				rateLimitState: getTestAlertRateLimitState(),
			},
			tokenCostBudget: tokenCostBudgetService.getBudgetStatus(),
			selfTest: getSelfTestService().getStatus(),
			telegramCommandAuth: telegramCommandAuth.getStatus(),
		},
	};
}

async function getApiStatus(req, res) {
	try {
		if (
			notificationRedriveService.isEnabled()
			&& notificationRedriveService.getWorkerRole() !== 'disabled'
			&& notificationRedriveService.hasDurableStore()
		) {
			await notificationRedriveService.syncWorkerTelemetry();
		}
		if (typeof tokenCostBudgetService?.syncSharedSpendThrottled === 'function') {
			try {
				await tokenCostBudgetService.syncSharedSpendThrottled();
			} catch (_) {
				// Fail-open for status endpoint
			}
		}
		// Prove scanner-preset durability with the bounded read that `/api/status` is
		// asserting, instead of reporting credential shape as readiness (#1342). Fail-open
		// and never blocks the response.
		try {
			await scannerPresetService.probeStorageReadiness();
		} catch (_) {
			// Fail-open for status endpoint
		}
		return res.status(200).json(getStatus({ skipTelemetrySync: true }));
	} catch (error) {
		console.error('[StatusController] getStatus failed:', error);
		return res.status(500).json({ error: error.message, code: 'INTERNAL_ERROR' });
	}
}

module.exports = {
	getApiStatus,
	getStatus,
};
