'use strict';

/**
 * telegramAlertKeyboard — composes the inline keyboard markup that gets
 * attached to Telegram alert messages. Buttons map to action codes that fit
 * inside Telegram's 64-byte callback_data limit. Each action code is a
 * short, ASCII, deterministic string:
 *
 *   r:<shortId>   — Replay the alert to the originating channels.
 *   d:<shortId>   — Return the stored enrichment (sources, technical levels,
 *                   risk parameters) as a follow-up message.
 *   x:<shortId>   — Acknowledge / dismiss the alert; reply_markup is removed
 *                   from the source message and a dismissal marker is
 *                   recorded.
 *   vu:<shortId>  — Quality feedback: thumbs up.
 *   vd:<shortId>  — Quality feedback: thumbs down.
 *
 * `shortId` is 8 characters of the telegramActionStore mapping. The longest
 * callback_data is therefore `vd:<8chars>` = 11 bytes, well within the
 * 64-byte limit and leaves room for future prefixes without touching the
 * handler regex.
 */

const TELEGRAM_MAX_CALLBACK_BYTES = 64;
const ACTION_REPLAY = 'r';
const ACTION_DETAILS = 'd';
const ACTION_DISMISS = 'x';
const ACTION_VOTE_UP = 'vu';
const ACTION_VOTE_DOWN = 'vd';

function buildCallbackData(action, shortId) {
	if (typeof action !== 'string' || !action) {
		throw new TypeError('action must be a non-empty string');
	}
	if (typeof shortId !== 'string' || !shortId) {
		throw new TypeError('shortId must be a non-empty string');
	}
	const data = `${action}:${shortId}`;
	if (Buffer.byteLength(data, 'utf8') > TELEGRAM_MAX_CALLBACK_BYTES) {
		throw new RangeError(
			`Telegram callback_data exceeds ${TELEGRAM_MAX_CALLBACK_BYTES} bytes (${data})`,
		);
	}
	return data;
}

const BUTTON_LABELS = Object.freeze({
	[ACTION_REPLAY]: '🔁 Replay',
	[ACTION_DETAILS]: 'ℹ️ Detalles',
	[ACTION_DISMISS]: '✖️ Descartar',
	[ACTION_VOTE_UP]: '👍',
	[ACTION_VOTE_DOWN]: '👎',
});

function buildReplyMarkup({ shortId, hasEnrichment = true, includeReplay = true } = {}) {
	if (typeof shortId !== 'string' || !shortId) {
		return null;
	}
	const rows = [];
	const topRow = [];
	if (includeReplay) {
		topRow.push({
			text: BUTTON_LABELS[ACTION_REPLAY],
			callback_data: buildCallbackData(ACTION_REPLAY, shortId),
		});
	}
	topRow.push({
		text: BUTTON_LABELS[ACTION_DISMISS],
		callback_data: buildCallbackData(ACTION_DISMISS, shortId),
	});
	rows.push(topRow);

	if (hasEnrichment) {
		rows.push([
			{
				text: BUTTON_LABELS[ACTION_DETAILS],
				callback_data: buildCallbackData(ACTION_DETAILS, shortId),
			},
		]);
	}

	rows.push([
		{
			text: BUTTON_LABELS[ACTION_VOTE_UP],
			callback_data: buildCallbackData(ACTION_VOTE_UP, shortId),
		},
		{
			text: BUTTON_LABELS[ACTION_VOTE_DOWN],
			callback_data: buildCallbackData(ACTION_VOTE_DOWN, shortId),
		},
	]);

	return { inline_keyboard: rows };
}

function parseCallbackData(data) {
	if (typeof data !== 'string' || !data) {
		return null;
	}
	const separatorIndex = data.indexOf(':');
	if (separatorIndex <= 0) {
		return null;
	}
	const action = data.slice(0, separatorIndex);
	const shortId = data.slice(separatorIndex + 1);
	if (!shortId) {
		return null;
	}
	return { action, shortId };
}

function getActionCodes() {
	return {
		ACTION_REPLAY,
		ACTION_DETAILS,
		ACTION_DISMISS,
		ACTION_VOTE_UP,
		ACTION_VOTE_DOWN,
	};
}

module.exports = {
	buildReplyMarkup,
	buildCallbackData,
	parseCallbackData,
	getActionCodes,
	TELEGRAM_MAX_CALLBACK_BYTES,
	BUTTON_LABELS,
};
