'use strict';

const alertStorageService = require('../storage/AlertStorageService');
const { eventBus } = require('../../lib/eventBus');
const { EVENT_NAMES } = require('../../lib/eventBusCatalog');
const logger = require('../../lib/logging');

const APPROVE_EMOJIS = ['👍', '❤️', '❤', '🔥', '🚀', '🎉', '👏', '⚡', '🎯', '✅'];
const REJECT_EMOJIS = ['👎', '💩', '🤮', '❌', '💔'];

const APPROVE_SET = new Set(APPROVE_EMOJIS);
const REJECT_SET = new Set(REJECT_EMOJIS);

const DEBOUNCE_WINDOW_MS = 60_000;

class TelegramReactionService {
	constructor() {
		this.debounceCache = new Map();
	}

	classifyEmoji(emoji) {
		if (!emoji) {
			return {
				approve: false,
				reject: false,
				neutral: false,
				removed: true,
				weight: 0,
			};
		}
		if (APPROVE_SET.has(emoji)) {
			return {
				approve: true,
				reject: false,
				neutral: false,
				removed: false,
				weight: 1,
			};
		}
		if (REJECT_SET.has(emoji)) {
			return {
				approve: false,
				reject: true,
				neutral: false,
				removed: false,
				weight: -1,
			};
		}
		return {
			approve: false,
			reject: false,
			neutral: true,
			removed: false,
			weight: 0,
		};
	}

	_cleanupDebounce() {
		const now = Date.now();
		for (const [key, timestamp] of this.debounceCache.entries()) {
			if (now - timestamp > DEBOUNCE_WINDOW_MS) {
				this.debounceCache.delete(key);
			}
		}
	}

	async handleReactionUpdate(ctx = {}) {
		if (process.env.ENABLE_TELEGRAM_REACTION_AGGREGATION !== 'true') {
			return { processed: false, reason: 'disabled' };
		}

		const update = ctx.update?.message_reaction || ctx.message_reaction;
		if (!update) {
			return { processed: false, reason: 'missing_identifiers' };
		}

		const chatId = update.chat?.id;
		const messageId = update.message_id;
		const userId = update.user?.id;

		if (chatId == null || messageId == null || userId == null) {
			return { processed: false, reason: 'missing_identifiers' };
		}

		this._cleanupDebounce();

		const debounceKey = `${chatId}_${messageId}_${userId}`;
		const lastAt = this.debounceCache.get(debounceKey);
		const now = Date.now();
		if (lastAt && now - lastAt < DEBOUNCE_WINDOW_MS) {
			return { processed: false, reason: 'debounced' };
		}
		this.debounceCache.set(debounceKey, now);

		try {
			const alert = await alertStorageService.findAlertByTelegramMessageId(messageId, chatId);
			if (!alert || !alert.id) {
				return { processed: false, reason: 'alert_not_found' };
			}

			const newReaction = update.new_reaction;
			let emoji = null;
			if (Array.isArray(newReaction) && newReaction.length > 0) {
				const item = newReaction[0];
				emoji = typeof item === 'object' && item.emoji ? item.emoji : (typeof item === 'string' ? item : null);
			}

			const classification = this.classifyEmoji(emoji);

			await alertStorageService.updateAlertReactions(alert.id, {
				chatId: String(chatId),
				userId: String(userId),
				emoji,
				weight: classification.weight,
				removed: classification.removed,
			});

			eventBus.emit(EVENT_NAMES.SIGNAL_EVALUATED, {
				source: 'reaction',
				alertId: alert.id,
				symbol: alert.symbol,
				chatId: String(chatId),
				userId: String(userId),
				emoji,
				weight: classification.weight,
				removed: classification.removed,
			});

			return { processed: true, alertId: alert.id };
		} catch (error) {
			logger.warn(`[TelegramReactionService] handleReactionUpdate failed: ${error.message}`);
			return { processed: false, reason: 'error', error: error.message };
		}
	}

	_resetForTesting() {
		this.debounceCache.clear();
	}
}

const telegramReactionService = new TelegramReactionService();

module.exports = {
	TelegramReactionService,
	telegramReactionService,
	APPROVE_EMOJIS,
	REJECT_EMOJIS,
};
