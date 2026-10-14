'use strict';

/**
 * telegramAlertKeyboard — composes the inline keyboard markup that gets
 * attached to Telegram alert messages. Buttons map to action codes that fit
 * inside Telegram's 64-byte callback_data limit. Each action code is a
 * short, ASCII, deterministic string:
 *
 *   r:<alertId>   — Replay the alert to the originating channels.
 *   d:<alertId>   — Return the stored enrichment (sources, technical levels,
 *                   risk parameters) as a follow-up message.
 *   x:<alertId>   — Acknowledge / dismiss the alert; reply_markup is removed
 *                   from the source message and a dismissal marker is
 *                   recorded.
 *   vu:<alertId>  — Quality feedback: thumbs up.
 *   vd:<alertId>  — Quality feedback: thumbs down.
 *
 * The alert UUID is used directly so callbacks survive process restarts and
 * rolling deployments. `vd:<uuid>` is 39 bytes, below Telegram's 64-byte
 * callback_data limit.
 */

const TELEGRAM_MAX_CALLBACK_BYTES = 64;
const ACTION_REPLAY = 'r';
const ACTION_DETAILS = 'd';
const ACTION_DISMISS = 'x';
const ACTION_VOTE_UP = 'vu';
const ACTION_VOTE_DOWN = 'vd';
const CALLBACK_ALERT_ID_PATTERN = /^[A-Za-z0-9_-]{1,60}$/;

function buildCallbackData(action, alertId) {
	if (typeof action !== 'string' || !action) {
		throw new TypeError('action must be a non-empty string');
	}
	if (typeof alertId !== 'string' || !alertId) {
		throw new TypeError('alertId must be a non-empty string');
	}
	if (!CALLBACK_ALERT_ID_PATTERN.test(alertId)) {
		throw new RangeError('alertId is not valid for Telegram callback_data');
	}
	const data = `${action}:${alertId}`;
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

function buildReplyMarkup({ alertId, hasEnrichment = true, includeReplay = true } = {}) {
	if (typeof alertId !== 'string' || !alertId || !CALLBACK_ALERT_ID_PATTERN.test(alertId)) {
		return null;
	}
	const rows = [];
	const topRow = [];
	if (includeReplay) {
		topRow.push({
			text: BUTTON_LABELS[ACTION_REPLAY],
			callback_data: buildCallbackData(ACTION_REPLAY, alertId),
		});
	}
	topRow.push({
		text: BUTTON_LABELS[ACTION_DISMISS],
		callback_data: buildCallbackData(ACTION_DISMISS, alertId),
	});
	rows.push(topRow);

	if (hasEnrichment) {
		rows.push([
			{
				text: BUTTON_LABELS[ACTION_DETAILS],
				callback_data: buildCallbackData(ACTION_DETAILS, alertId),
			},
		]);
	}

	rows.push([
		{
			text: BUTTON_LABELS[ACTION_VOTE_UP],
			callback_data: buildCallbackData(ACTION_VOTE_UP, alertId),
		},
		{
			text: BUTTON_LABELS[ACTION_VOTE_DOWN],
			callback_data: buildCallbackData(ACTION_VOTE_DOWN, alertId),
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
	const alertId = data.slice(separatorIndex + 1);
	if (!CALLBACK_ALERT_ID_PATTERN.test(alertId)) {
		return null;
	}
	return { action, alertId };
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
