const { isPreviewEnvironment, getDeploymentCommit, getDeploymentRepoSlug } = require('./deploymentEnvironment');
const defaultSentryService = require('../services/monitoring/SentryService');

const DEFAULT_DEPLOYMENT_NOTIFICATION_TIMEOUT_MS = 10000;

function getTelegramBootstrapConfig() {
	const telegramBotIsEnabled = process.env.ENABLE_TELEGRAM_BOT === 'true';
	const isPreviewEnv = isPreviewEnvironment();
	const shouldStartTelegramBot = telegramBotIsEnabled && !isPreviewEnv;
	const token = process.env.BOT_TOKEN;

	if (shouldStartTelegramBot && token === undefined) {
		throw new Error('BOT_TOKEN must be provided!');
	}

	return {
		isPreviewEnv,
		shouldStartTelegramBot,
		telegramBotIsEnabled,
		token,
	};
}

/**
 * Sends an optional startup deployment notification to the configured admin chat.
 * This operation is strictly fail-open: any error or timeout is logged as a warning
 * and captured in Sentry without ever rejecting or throwing.
 *
 * @param {Object} params
 * @param {Object} params.bot - Telegraf bot instance
 * @param {number} [params.timeoutMs=10000] - Request timeout in ms
 * @param {Object} [params.logger=console] - Logger instance
 * @param {Object} [params.sentry=sentryService] - Sentry monitoring service
 * @param {string} [params.chatId] - Override admin chat ID
 * @param {string} [params.deploymentCommit] - Override deployment commit hash
 * @param {string} [params.deploymentRepoSlug] - Override repository slug
 * @returns {Promise<{ sent: boolean, commitHash?: string, gitCommitUrl?: string, error?: string, reason?: string }>}
 */
async function sendStartupDeploymentNotification({
	bot,
	timeoutMs = DEFAULT_DEPLOYMENT_NOTIFICATION_TIMEOUT_MS,
	logger = console,
	sentry = defaultSentryService,
	chatId,
	deploymentCommit,
	deploymentRepoSlug,
} = {}) {
	const rawAdminChatId = chatId !== undefined ? chatId : process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	const adminChatId = String(rawAdminChatId || '').trim();

	if (!adminChatId) {
		return { sent: false, reason: 'no_admin_chat_configured' };
	}

	logger.log?.('Telegram Admin Notifications Chat ID:', adminChatId);

	const isDeploymentEnv = Boolean(
		process.env.RENDER
		|| process.env.VERCEL
		|| process.env.RAILWAY_ENVIRONMENT_NAME,
	);
	const commit = deploymentCommit || getDeploymentCommit();

	if (!isDeploymentEnv || !commit) {
		return { sent: false, reason: 'not_a_deployment_environment' };
	}

	if (!bot || !bot.telegram || typeof bot.telegram.sendMessage !== 'function') {
		return { sent: false, reason: 'bot_not_available' };
	}

	const startedAt = Date.now();
	const commitHash = commit.substring(0, 6);
	const repoSlug = deploymentRepoSlug || getDeploymentRepoSlug();
	const gitCommitUrl = `https://github.com/${repoSlug}/commit/${commitHash}`;

	logger.log?.(`Telegram bot deployed from commit ${gitCommitUrl} is running`);
	const text = `*Telegram bot deployed from commit [${commitHash}](${gitCommitUrl}) is running*`;

	const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
		? timeoutMs
		: DEFAULT_DEPLOYMENT_NOTIFICATION_TIMEOUT_MS;

	const controller = new AbortController();
	let timeoutId;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort(new Error(`Startup deployment notification timed out after ${effectiveTimeout}ms`));
			reject(new Error(`Startup deployment notification timed out after ${effectiveTimeout}ms`));
		}, effectiveTimeout);
	});

	try {
		const sendPromise = typeof bot.telegram.callApi === 'function'
			? bot.telegram.callApi('sendMessage', {
				chat_id: adminChatId,
				text,
				parse_mode: 'MarkdownV2',
			}, { signal: controller.signal })
			: bot.telegram.sendMessage(adminChatId, text, { parse_mode: 'MarkdownV2' });

		await Promise.race([sendPromise, timeoutPromise]);
		return { sent: true, commitHash, gitCommitUrl };
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		logger.warn?.('[index] Failed to send startup deployment notification:', error.message);

		if (sentry && typeof sentry.captureExternalFailure === 'function') {
			try {
				sentry.captureExternalFailure({
					provider: 'telegram-api',
					attemptCount: 1,
					durationMs,
					lastErrorMessage: error.message,
					lastErrorCode: error?.response?.error_code || error?.code || (controller.signal.aborted ? 'TIMEOUT' : 'STARTUP_NOTIFICATION_FAILED'),
				});
			} catch (sentryError) {
				logger.warn?.('[index] Failed to record deployment notification failure in Sentry:', sentryError.message);
			}
		}

		return { sent: false, error: error.message };
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

module.exports = {
	getTelegramBootstrapConfig,
	sendStartupDeploymentNotification,
};
