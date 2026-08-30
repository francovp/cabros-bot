'use strict';

const WhatsAppService = require('./WhatsAppService');
const sentryService = require('../monitoring/SentryService');

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_COMMANDS_PER_MINUTE = 10;
const DEFAULT_UNKNOWN_HINT_COOLDOWN_MS = 60000;
const REQUEST_TIMEOUT_MS = 10000;

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

		this.whatsAppService = options.whatsAppService || new WhatsAppService();
		this._priceResolver = options.priceResolver || null;
		this.fetchFn = options.fetchFn || globalThis.fetch;
		this.logger = options.logger || console;

		this.running = false;
		this.abortController = null;
		this.activePollPromise = null;
		this.lastPollAt = null;
		this.lastError = null;
		this.lastErrorAt = null;

		this.rateLimitMap = new Map(); // chatId -> timestamp[]
		this.unknownHintMap = new Map(); // chatId -> timestamp
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

	async executeCommand({ chatId, command, args, rawMessage }) {
		if (!chatId || !command) return { action: 'ignored' };

		if (command === 'precio') {
			if (!args) {
				await this.whatsAppService.send({
					text: 'Por favor indica un símbolo. Ejemplo: !precio BTCUSDT o !precio NVDA',
					whatsappChatId: chatId,
				});
				return { action: 'executed', command: 'precio', chatId, promptSymbol: true };
			}

			try {
				const context = { message: { text: `/precio ${args}` } };
				const result = await this.resolvePrice(context);
				const replyText = result?.message || (result?.symbol && result?.price !== undefined
					? `Precio de ${result.symbol} es ${result.price}`
					: `No pude obtener el precio de ${args}.`);

				await this.whatsAppService.send({
					text: replyText,
					whatsappChatId: chatId,
				});
				return { action: 'executed', command: 'precio', chatId, symbol: args };
			} catch (error) {
				const errorMessage = error.userMessage || error.message || `No pude obtener el precio de ${args}.`;
				await this.whatsAppService.send({
					text: errorMessage,
					whatsappChatId: chatId,
				});
				return { action: 'executed', command: 'precio', chatId, error: errorMessage };
			}
		}

		if (command === 'help' || command === 'start') {
			await this.whatsAppService.send({
				text: this.buildHelpMessage(),
				whatsappChatId: chatId,
			});
			return { action: 'executed', command: 'help', chatId };
		}

		// Unknown command
		if (this._checkUnknownHintCooldown(chatId)) {
			await this.whatsAppService.send({
				text: 'Comando no reconocido. Usa !help para ver los comandos disponibles.',
				whatsappChatId: chatId,
			});
			return { action: 'unknown_command_hint', command, chatId };
		}

		return { action: 'unknown_command_throttled', command, chatId };
	}

	async pollOnce() {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		this.lastPollAt = Date.now();

		try {
			const receiveUrl = this._getReceiveNotificationUrl();
			const response = await this.fetchFn(receiveUrl, {
				method: 'GET',
				signal: controller.signal,
			});

			if (!response.ok) {
				const rawText = await response.text().catch(() => '');
				const err = `GreenAPI receiveNotification failed: HTTP ${response.status} ${rawText}`;
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
			let handlingResult;
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

			// Acknowledge notification
			try {
				const deleteUrl = this._getDeleteNotificationUrl(receiptId);
				await this.fetchFn(deleteUrl, {
					method: 'DELETE',
					signal: controller.signal,
				});
			} catch (deleteErr) {
				this.logger.warn(`[WhatsAppCommandBridge] Failed to delete notification ${receiptId}:`, deleteErr.message);
			}

			return { processed: true, receiptId, handlingResult };
		} catch (error) {
			if (error.name === 'AbortError') {
				const err = 'GreenAPI receiveNotification timeout (10s)';
				this.lastError = err;
				this.lastErrorAt = Date.now();
				this.logger.warn(`[WhatsAppCommandBridge] ${err}`);
				return { processed: false, error: err, timeout: true };
			}
			const err = error.message || String(error);
			this.lastError = err;
			this.lastErrorAt = Date.now();
			this.logger.warn(`[WhatsAppCommandBridge] Polling error: ${err}`);
			return { processed: false, error: err };
		} finally {
			clearTimeout(timeoutId);
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
		this.activePollPromise = this._pollLoop();
		this.logger.info('[WhatsAppCommandBridge] Started WhatsApp inbound command bridge poller');
	}

	async stop(options = {}) {
		if (!this.running) return;
		this.running = false;
		if (this.abortController) {
			this.abortController.abort();
		}
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
		};
	}
}

// Singleton instance
const whatsAppCommandBridgeService = new WhatsAppCommandBridgeService();

module.exports = WhatsAppCommandBridgeService;
module.exports.whatsAppCommandBridgeService = whatsAppCommandBridgeService;
