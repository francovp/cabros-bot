'use strict';

const WhatsAppService = require('./WhatsAppService');
const sentryService = require('../monitoring/SentryService');
const retryHelper = require('../../lib/retryHelper');
const { createWhatsAppCommandContext, TELEGRAM_COMMAND_DELEGATES } = require('./whatsappCommandContext');

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_MAX_COMMANDS_PER_MINUTE = 10;
const DEFAULT_UNKNOWN_HINT_COOLDOWN_MS = 60000;
/**
 * Each GreenAPI step gets its own deadline. They are deliberately independent:
 * command handling (price resolve + outbound send + its own retries) routinely
 * outlasts the receive budget, and a shared controller meant the post-handling
 * `deleteNotification` was aborted by a timer that had already fired — leaving
 * the receipt in the inbound queue so the next poll re-executed the command.
 */
const RECEIVE_TIMEOUT_MS = 10000;
const DELETE_TIMEOUT_MS = 10000;
const DELETE_MAX_ATTEMPTS = 3;
const DELETE_MAX_RETRY_DELAY_MS = 1500;

const SEEN_RECEIPT_TTL_MS = 120000;
const SEEN_RECEIPT_MAX_ENTRIES = 500;

const ERROR_TEXT_MAX_LENGTH = 200;

// `!noticias` is the first bridge command whose work outlives a poll cycle, so this
// bound is what stops one slow command from stalling receipt draining for every chat.
// A fixed safety boundary rather than a knob: the handlers own their provider deadlines.
const COMMAND_TIMEOUT_MS = 120000;

const OUTCOMES_USAGE_HINT = [
	'Indica un símbolo para consultar el rendimiento.',
	'Ejemplos: `!outcomes BTCUSDT` o `!outcomes BINANCE:BTCUSDT`',
].join('\n');

class WhatsAppCommandBridgeService {
	/**
	 * @param {Object} [options]
	 * @param {string} [options.apiUrl]
	 * @param {string} [options.apiKey]
	 * @param {string|string[]} [options.chatIds]
	 * @param {number} [options.pollIntervalMs]
	 * @param {number} [options.maxCommandsPerMinute]
	 * @param {number} [options.unknownHintCooldownMs]
	 * @param {Object} [options.whatsAppService]
	 * @param {Function} [options.priceResolver]
	 * @param {Object} [options.commandHandlers] - Per-command overrides for the
	 *   Telegram-parity commands, keyed by WhatsApp command token (e.g. `analisis`)
	 * @param {number} [options.commandTimeoutMs]
	 * @param {Function} [options.fetchFn]
	 * @param {Object} [options.logger]
	 */
	constructor(options = {}) {
		this._apiUrl = options.apiUrl;
		this._apiKey = options.apiKey;
		this._chatIds = options.chatIds !== undefined ? this._parseChatIds(options.chatIds) : null;
		this._pollIntervalMs = options.pollIntervalMs;
		this.maxCommandsPerMinute = options.maxCommandsPerMinute || DEFAULT_MAX_COMMANDS_PER_MINUTE;
		this.unknownHintCooldownMs = options.unknownHintCooldownMs || DEFAULT_UNKNOWN_HINT_COOLDOWN_MS;
		this.commandTimeoutMs = options.commandTimeoutMs || COMMAND_TIMEOUT_MS;

		this.whatsAppService = options.whatsAppService || new WhatsAppService();
		this._priceResolver = options.priceResolver || null;
		this._commandHandlers = options.commandHandlers || {};
		this.fetchFn = options.fetchFn || globalThis.fetch;
		this.logger = options.logger || console;

		this.running = false;
		this.abortController = null;
		this.activePollPromise = null;
		this.lastPollAt = null;
		this.lastError = null;
		this.lastErrorAt = null;
		this.commandTimeouts = 0;
		this.lastCommandTimeoutAt = null;

		this.receiveTimeoutMs = options.receiveTimeoutMs || RECEIVE_TIMEOUT_MS;
		this.deleteTimeoutMs = options.deleteTimeoutMs || DELETE_TIMEOUT_MS;
		this.deleteMaxAttempts = options.deleteMaxAttempts || DELETE_MAX_ATTEMPTS;
		this.seenReceiptTtlMs = options.seenReceiptTtlMs || SEEN_RECEIPT_TTL_MS;
		this.seenReceiptMaxEntries = options.seenReceiptMaxEntries || SEEN_RECEIPT_MAX_ENTRIES;

		this.rateLimitMap = new Map(); // chatId -> timestamp[]
		this.unknownHintMap = new Map(); // chatId -> timestamp
		this.seenReceiptMap = new Map(); // receiptId -> expiresAt
		this.duplicateSkippedCount = 0;
		this.deleteFailureCount = 0;
		this.deleteRetryCount = 0;
		this.deleteAbortedCount = 0;
		this._sleepResolvers = new Set();
	}

	get apiUrl() {
		return this._apiUrl || process.env.WHATSAPP_API_URL || '';
	}

	get apiKey() {
		return this._apiKey || process.env.WHATSAPP_API_KEY || '';
	}

	get pollIntervalMs() {
		return Number(this._pollIntervalMs || process.env.WHATSAPP_COMMAND_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
	}

	_sleep(ms) {
		return new Promise((resolve) => {
			if (!this.running) {
				resolve();
				return;
			}
			let timer;
			const cancel = () => {
				clearTimeout(timer);
				this._sleepResolvers.delete(cancel);
				resolve();
			};
			timer = setTimeout(() => {
				this._sleepResolvers.delete(cancel);
				resolve();
			}, ms);
			this._sleepResolvers.add(cancel);
		});
	}

	_parseChatIds(rawChatIds) {
		if (!rawChatIds) return new Set();
		if (Array.isArray(rawChatIds)) {
			return new Set(rawChatIds.map((id) => String(id).trim()).filter(Boolean));
		}
		if (typeof rawChatIds === 'string') {
			return new Set(
				rawChatIds
					.split(',')
					.map((id) => id.trim())
					.filter(Boolean),
			);
		}
		return new Set();
	}

	getChatIds() {
		if (this._chatIds) return this._chatIds;
		return this._parseChatIds(process.env.WHATSAPP_COMMAND_CHAT_IDS);
	}

	isEnabled() {
		return process.env.ENABLE_WHATSAPP_COMMANDS === 'true';
	}

	isConfigured() {
		return Boolean(this.apiUrl && this.apiKey && this.getChatIds().size > 0);
	}

	getAllowlistedChatIds() {
		return Array.from(this.getChatIds());
	}

	isChatAllowed(chatId) {
		if (!chatId) return false;
		return this.getChatIds().has(String(chatId).trim());
	}

	getBaseUrl() {
		if (!this.apiUrl) return '';
		return this.apiUrl.replace(/\/sendMessage\/?$/i, '').replace(/\/+$/, '') + '/';
	}

	_getReceiveNotificationUrl() {
		return `${this.getBaseUrl()}receiveNotification/${this.apiKey}?receiveTimeout=5`;
	}

	_getDeleteNotificationUrl(receiptId) {
		return `${this.getBaseUrl()}deleteNotification/${this.apiKey}/${receiptId}`;
	}

	_checkRateLimit(chatId) {
		const now = Date.now();
		const windowStart = now - 60000;
		const timestamps = (this.rateLimitMap.get(chatId) || []).filter((ts) => ts > windowStart);

		if (timestamps.length >= this.maxCommandsPerMinute) {
			this.rateLimitMap.set(chatId, timestamps);
			return false;
		}

		timestamps.push(now);
		this.rateLimitMap.set(chatId, timestamps);
		return true;
	}

	_isSeenReceipt(receiptId) {
		if (!receiptId) return false;
		const key = String(receiptId);
		const expiresAt = this.seenReceiptMap.get(key);
		if (expiresAt === undefined) return false;
		if (expiresAt <= Date.now()) {
			this.seenReceiptMap.delete(key);
			return false;
		}
		return true;
	}

	_markReceiptSeen(receiptId) {
		if (!receiptId) return;
		const now = Date.now();
		for (const [key, expiresAt] of this.seenReceiptMap) {
			if (expiresAt <= now) this.seenReceiptMap.delete(key);
		}
		while (this.seenReceiptMap.size >= this.seenReceiptMaxEntries) {
			const oldest = this.seenReceiptMap.keys().next();
			if (oldest.done) break;
			this.seenReceiptMap.delete(oldest.value);
		}
		this.seenReceiptMap.set(String(receiptId), now + this.seenReceiptTtlMs);
	}

	_checkUnknownHintCooldown(chatId) {
		const now = Date.now();
		const lastSent = this.unknownHintMap.get(chatId) || 0;
		if (now - lastSent < this.unknownHintCooldownMs) {
			return false;
		}
		this.unknownHintMap.set(chatId, now);
		return true;
	}

	buildHelpMessage() {
		return [
			'*🤖 Comandos disponibles en WhatsApp*',
			'',
			'• `!precio <simbolo>` — Consulta el precio en Binance o Twelve Data (ej: `!precio BTCUSDT`, `!precio NVDA`)',
			'• `!analisis <simbolos>` — Análisis técnico de TradingView en segundo plano (ej: `!analisis BINANCE:BTCUSDT`)',
			'• `!scanner [opciones]` — Barrido de mercado (ej: `!scanner exchange=BINANCE timeframe=4h`)',
			'• `!noticias [simbolos]` — Monitoreo de noticias (ej: `!noticias BTCUSDT,NVDA`)',
			'• `!outcomes <simbolo>` — Rendimiento de señales evaluadas (alias: `!rendimiento`)',
			'• `!help` — Muestra este mensaje de ayuda',
		].join('\n');
	}

	async handleNotification(notification) {
		if (!notification || !notification.body) {
			return { action: 'ignored', reason: 'empty_notification' };
		}

		const { typeWebhook, senderData, messageData } = notification.body;

		if (typeWebhook !== 'incomingMessageReceived') {
			return { action: 'ignored', reason: 'unsupported_webhook_type' };
		}

		const chatId = senderData?.chatId;
		if (!this.isChatAllowed(chatId)) {
			return { action: 'ignored', reason: 'chat_not_allowlisted', chatId };
		}

		const rawText =
			messageData?.textMessageData?.textMessage ||
			messageData?.extendedTextMessageData?.text ||
			'';

		if (typeof rawText !== 'string' || !rawText.trim().startsWith('!')) {
			return { action: 'ignored', reason: 'not_a_command' };
		}

		if (!this._checkRateLimit(chatId)) {
			this.logger.warn(`[WhatsAppCommandBridge] Rate limit exceeded for chat ${chatId}`);
			return { action: 'rate_limited', chatId };
		}

		const trimmed = rawText.trim();
		const match = trimmed.match(/^!([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
		if (!match) {
			return { action: 'ignored', reason: 'malformed_command' };
		}

		const command = match[1].toLowerCase();
		const args = match[2] ? match[2].trim() : '';

		return this.executeCommand({ chatId, command, args, rawMessage: trimmed });
	}

	async resolvePrice(context) {
		if (typeof this._priceResolver === 'function') {
			return this._priceResolver(context);
		}
		const { fetchSymbolPrice } = require('../../controllers/commands/handlers/core/fetchPriceCryptoSymbol');
		return fetchSymbolPrice(context);
	}

_isStopRequested() {
		return this.stopRequested === true;
	}

	async _sendReply(text, chatId) {
		if (this._isStopRequested()) {
			return { success: false, error: 'Bridge is shutting down; reply suppressed', suppressed: true };
		}
		try {
			return await this.whatsAppService.send({ text, whatsappChatId: chatId });
		} catch (error) {
			if (this._isStopRequested()) {
				return { success: false, error: 'Bridge is shutting down; reply suppressed', suppressed: true };
			}
			throw error;
		}
	}

	/**
	 * Injected overrides are keyed by the canonical command so one override covers
	 * its aliases: `outcomes` covers `rendimiento`, `noticias` covers `news`.
	 */
	_resolveCommandHandler(name) {
		const entry = TELEGRAM_COMMAND_DELEGATES[name];
		if (!entry) {
			return null;
		}
		const injected = this._commandHandlers[name] || this._commandHandlers[entry.command];
		if (typeof injected === 'function') {
			return injected;
		}
		const handlers = require('../../controllers/commands');
		return handlers[entry.handlerName] || null;
	}

	async _executeDelegatedCommand({ chatId, command, args }) {
		const entry = TELEGRAM_COMMAND_DELEGATES[command];
		if (!entry) {
			return null;
		}

		if (entry.handlerName === 'outcomesCommand' && !args) {
			await this.whatsAppService.send({ text: OUTCOMES_USAGE_HINT, whatsappChatId: chatId });
			return { action: 'executed', command, chatId, promptUsage: true };
		}

		const handler = this._resolveCommandHandler(command);
		const fail = async (error) => {
			const detail = error && error.message ? error.message : 'Error desconocido';
			this.logger.error(`[WhatsAppCommandBridge] !${command} failed:`, detail);
			sentryService.captureRuntimeError({
				channel: 'whatsapp',
				error,
				extra: { command, chatId, type: 'command_handler_failure' },
			});
			await this.whatsAppService
				.send({
					text: `No pude ejecutar !${command}: ${detail}`,
					whatsappChatId: chatId,
				})
				.catch((sendError) => {
					this.logger.warn(`[WhatsAppCommandBridge] Failed to send !${command} error notice:`, sendError.message);
				});
			return detail;
		};

		if (!handler) {
			const detail = await fail(new Error('comando no disponible'));
			return { action: 'executed', command, chatId, error: detail };
		}

		const context = createWhatsAppCommandContext({
			chatId,
			command: entry.command,
			args,
			whatsAppService: this.whatsAppService,
		});

		let timer;
		let timedOut = false;
		const deadline = new Promise((resolve) => {
			timer = setTimeout(() => {
				timedOut = true;
				this.commandTimeouts += 1;
				this.lastCommandTimeoutAt = Date.now();
				this.logger.warn(`[WhatsAppCommandBridge] !${command} exceeded ${this.commandTimeoutMs}ms for chat ${chatId}`);
				sentryService.captureRuntimeError({
					channel: 'whatsapp',
					error: new Error(`whatsapp command timeout: ${command}`),
					extra: { command, chatId, timeoutMs: this.commandTimeoutMs, type: 'command_timeout' },
				});
				resolve();
			}, this.commandTimeoutMs);
			if (typeof timer.unref === 'function') {
				timer.unref();
			}
		});

		let handlerError = null;
		try {
			handlerError = await Promise.race([
				// `Promise.resolve().then(...)` converts a synchronous throw from an
				// injected handler into a rejection; calling `handler(context)` inside
				// the array literal would instead throw past the race and leave the
				// user with no reply at all.
				Promise.resolve().then(() => handler(context)).then(() => null, (error) => fail(error)),
				deadline,
			]);
		} finally {
			clearTimeout(timer);
		}

		if (timedOut) {
			await this.whatsAppService
				.send({
					text: `!${command} sigue procesando y tardó más de ${Math.round(this.commandTimeoutMs / 1000)}s. El resultado puede llegar más tarde; si no llega, vuelve a intentarlo.`,
					whatsappChatId: chatId,
				})
				.catch((error) => {
					this.logger.warn(`[WhatsAppCommandBridge] Failed to send !${command} timeout notice:`, error.message);
				});
			return { action: 'executed', command, chatId, timedOut: true };
		}
		return handlerError
			? { action: 'executed', command, chatId, error: handlerError }
			: { action: 'executed', command, chatId };
	}

	async executeCommand({ chatId, command, args, rawMessage }) {
		if (!chatId || !command) return { action: 'ignored' };

		if (command === 'precio') {
			if (!args) {
				await this._sendReply('Por favor indica un símbolo. Ejemplo: !precio BTCUSDT o !precio NVDA', chatId);
				return { action: 'executed', command: 'precio', chatId, promptSymbol: true };
			}

			try {
				const context = { message: { text: `/precio ${args}` } };
				const result = await this.resolvePrice(context);
				const replyText = result?.message || (result?.symbol && result?.price !== undefined
					? `Precio de ${result.symbol} es ${result.price}`
					: `No pude obtener el precio de ${args}.`);

				await this._sendReply(replyText, chatId);
				return { action: 'executed', command: 'precio', chatId, symbol: args };
			} catch (error) {
				const errorMessage = error.userMessage || error.message || `No pude obtener el precio de ${args}.`;
				await this._sendReply(errorMessage, chatId);
				return { action: 'executed', command: 'precio', chatId, error: errorMessage };
			}
		}

		if (command === 'help' || command === 'start') {
			await this._sendReply(this.buildHelpMessage(), chatId);
			return { action: 'executed', command: 'help', chatId };
		}

		const delegated = await this._executeDelegatedCommand({ chatId, command, args });
		if (delegated) {
			return delegated;
		}

		// Unknown command
		if (this._checkUnknownHintCooldown(chatId)) {
			await this._sendReply('Comando no reconocido. Usa !help para ver los comandos disponibles.', chatId);
			return { action: 'unknown_command_hint', command, chatId };
		}

		return { action: 'unknown_command_throttled', command, chatId };
	}

	async _fetchWithTimeout(url, method, timeoutMs) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await this.fetchFn(url, { method, signal: controller.signal });
		} finally {
			clearTimeout(timer);
		}
	}

	/**
 * `lastError` is published verbatim on `/api/status`, so no provider-authored
 * text may reach it: the delete URL is `/deleteNotification/{apiKey}/{receiptId}`
 * and a GreenAPI error body can echo that URL back, which would publish the api
 * key on a status endpoint. Failures are therefore described by our own status
 * code or a bounded classification, and `_sanitizeErrorText` only guards the
 * transport error text we did not author. Do not re-add the response body.
 */
_sanitizeErrorText(text) {
		let sanitized = typeof text === 'string' ? text.trim() : '';
		const apiKey = this.apiKey;
		if (apiKey && sanitized.includes(apiKey)) {
			sanitized = sanitized.split(apiKey).join('[redacted]');
		}
		if (sanitized.length > ERROR_TEXT_MAX_LENGTH) {
			sanitized = `${sanitized.slice(0, ERROR_TEXT_MAX_LENGTH)}…`;
		}
		return sanitized;
	}

	_describeDeleteFailure(deleteResult) {
		if (deleteResult.timeout || deleteResult.aborted) {
			return `acknowledgement step timed out after ${this.deleteTimeoutMs}ms`;
		}
		const statusCode = Number(deleteResult.statusCode);
		if (Number.isFinite(statusCode) && statusCode > 0) {
			return `HTTP ${statusCode}`;
		}
		return 'request failed';
	}

	async _deleteNotificationWithRetry(receiptId) {
		const deleteUrl = this._getDeleteNotificationUrl(receiptId);
		const pollSignal = this.abortController ? this.abortController.signal : undefined;
		return retryHelper.sendWithRetry(
			async ({ signal }) => {
				try {
					const response = await this._fetchWithTimeout(deleteUrl, 'DELETE', this.deleteTimeoutMs);
					if (response.ok) {
						return { success: true, receiptId };
					}
					const retryable = response.status === 429 || response.status >= 500;
					return {
						success: false,
						receiptId,
						statusCode: response.status,
						error: `HTTP ${response.status}`,
						retryable,
					};
				} catch (error) {
					return {
						success: false,
						receiptId,
						error: error.name === 'AbortError' ? 'aborted' : (error.message || String(error)),
						timeout: error.name === 'AbortError',
						retryable: true,
					};
				}
			},
			this.deleteMaxAttempts,
			null,
			{ signal: pollSignal, maxRetryDelayMs: DELETE_MAX_RETRY_DELAY_MS },
		);
	}

	async pollOnce() {
		this.lastPollAt = Date.now();
		let controller = new AbortController();
		this.abortController = controller;

		try {
			const receiveUrl = this._getReceiveNotificationUrl();
			const timer = setTimeout(() => controller.abort(), this.receiveTimeoutMs);
			let response;
			try {
				response = await this.fetchFn(receiveUrl, {
					method: 'GET',
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timer);
			}

			if (!response.ok) {
				const err = this._sanitizeErrorText(`GreenAPI receiveNotification failed: HTTP ${response.status}`);
				this.lastError = err;
				this.lastErrorAt = Date.now();
				this.logger.warn(`[WhatsAppCommandBridge] ${err}`);
				return { processed: false, error: err, statusCode: response.status };
			}

			let data;
			try {
				data = await response.json();
			} catch (jsonErr) {
				this.logger.warn('[WhatsAppCommandBridge] Non-JSON response from receiveNotification');
				return { processed: false, error: 'Invalid JSON response' };
			}

			if (!data || !data.receiptId) {
				return { processed: false, empty: true };
			}

			const receiptId = data.receiptId;
			const isDuplicate = this._isSeenReceipt(receiptId);

			let handlingResult;
			if (isDuplicate) {
				this.duplicateSkippedCount += 1;
				this.logger.info(`[WhatsAppCommandBridge] Skipping duplicate receipt ${receiptId} (already processed)`);
				handlingResult = { action: 'skipped_duplicate', receiptId };
			} else {
				this._markReceiptSeen(receiptId);
				try {
					handlingResult = await this.handleNotification(data);
				} catch (handlerErr) {
					this.logger.error('[WhatsAppCommandBridge] Error handling notification:', handlerErr);
					sentryService.captureRuntimeError({
						channel: 'whatsapp',
						error: handlerErr,
						extra: { receiptId, type: 'command_handler_failure' },
					});
				}
			}

			const deleteResult = await this._deleteNotificationWithRetry(receiptId);
			const deleteAttempts = Number.isFinite(deleteResult.attemptCount) ? deleteResult.attemptCount : 1;
			if (deleteAttempts > 1) {
				this.deleteRetryCount += deleteAttempts - 1;
			}
			if (!deleteResult.success) {
				this.deleteFailureCount += 1;
				if (deleteResult.timeout || deleteResult.aborted) {
					this.deleteAbortedCount += 1;
				}
				const err = this._sanitizeErrorText(
					`Failed to delete notification ${receiptId}: ${this._describeDeleteFailure(deleteResult)}`,
				);
				this.lastError = err;
				this.lastErrorAt = Date.now();
				this.logger.warn(`[WhatsAppCommandBridge] ${err}`);
			}

			return { processed: true, receiptId, handlingResult, deleted: deleteResult.success === true, duplicate: isDuplicate };
		} catch (error) {
			if (error.name === 'AbortError') {
				const err = `GreenAPI receiveNotification timeout (${this.receiveTimeoutMs}ms)`;
				this.lastError = err;
				this.lastErrorAt = Date.now();
				this.logger.warn(`[WhatsAppCommandBridge] ${err}`);
				return { processed: false, error: err, timeout: true };
			}
			const err = this._sanitizeErrorText(error.message || String(error));
			this.lastError = err;
			this.lastErrorAt = Date.now();
			this.logger.warn(`[WhatsAppCommandBridge] Polling error: ${err}`);
			return { processed: false, error: err };
		} finally {
			this.abortController = null;
			controller = null;
		}
	}

	async _pollLoop() {
		while (this.running) {
			try {
				const result = await this.pollOnce();
				if (!this.running) break;

				if (result.processed) {
					// Small yield before next poll
					await this._sleep(50);
				} else {
					await this._sleep(this.pollIntervalMs);
				}
			} catch (loopErr) {
				this.logger.error('[WhatsAppCommandBridge] Unexpected loop error:', loopErr);
				await this._sleep(Math.max(this.pollIntervalMs, 5000));
			}
		}
	}

	start() {
		if (this.running) return;
		this.running = true;
		this.stopRequested = false;
		this.abortController = null;
		this.activePollPromise = this._pollLoop();
		this.logger.info('[WhatsAppCommandBridge] Started WhatsApp inbound command bridge poller');
	}

	async stop(options = {}) {
		if (!this.running) return;
		this.running = false;
		this.stopRequested = true;
		if (this.abortController) {
			this.abortController.abort();
		}
		this.abortController = null;
		for (const cancel of this._sleepResolvers) {
			cancel();
		}
		this._sleepResolvers.clear();

		if (this.activePollPromise) {
			let timer;
			const timeoutPromise = new Promise((resolve) => {
				timer = setTimeout(resolve, options.timeoutMs || 2000);
			});
			await Promise.race([this.activePollPromise, timeoutPromise]);
			clearTimeout(timer);
		}
		this.logger.info('[WhatsAppCommandBridge] Stopped WhatsApp inbound command bridge poller');
	}

	isRunning() {
		return this.running;
	}

	getStatus() {
		const enabled = this.isEnabled();
		const configured = this.isConfigured();
		let status = 'disabled';
		if (enabled) {
			if (!configured) {
				status = 'misconfigured';
			} else if (this.lastError && (Date.now() - (this.lastErrorAt || 0) < 60000)) {
				status = 'degraded';
			} else {
				status = 'ready';
			}
		}

		return {
			enabled,
			configured,
			ready: status === 'ready',
			running: this.running,
			status,
			allowlistedChatsCount: this.getChatIds().size,
			lastPollAt: this.lastPollAt,
			lastError: this.lastError,
			lastErrorAt: this.lastErrorAt,
			duplicateSkippedCount: this.duplicateSkippedCount,
			deleteFailureCount: this.deleteFailureCount,
			deleteRetryCount: this.deleteRetryCount,
			deleteAbortedCount: this.deleteAbortedCount,
			trackedReceiptCount: this.seenReceiptMap.size,
			commandTimeoutMs: this.commandTimeoutMs,
			commandTimeouts: this.commandTimeouts,
			lastCommandTimeoutAt: this.lastCommandTimeoutAt,
		};
	}
}

// Singleton instance
const whatsAppCommandBridgeService = new WhatsAppCommandBridgeService();

module.exports = WhatsAppCommandBridgeService;
module.exports.whatsAppCommandBridgeService = whatsAppCommandBridgeService;
