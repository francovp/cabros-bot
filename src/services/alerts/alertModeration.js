'use strict';

/**
 * Alert content moderation service.
 *
 * Opt-in defense-in-depth layer that screens webhook alert text before
 * enrichment or delivery. Rejects payloads that match a configurable
 * denylist, a configurable regex, or the always-on universal content
 * rules (control characters, lone surrogates, 200+ identical chars).
 *
 * Fail-open: a moderation crash never blocks alert delivery.
 */

const fs = require('fs');
const crypto = require('crypto');
const sentryService = require('../monitoring/SentryService');

const MAX_IDENTICAL_CHARS = 200;
const MAX_DENYLIST_ENTRIES = 500;
const MAX_REGEX_LENGTH = 1024;
const MAX_FILE_BYTES = 64 * 1024;

function isEnvFlagTrue(name) {
	const value = process.env[name];
	return value === 'true' || value === '1';
}

function resolveEnabled() {
	if (process.env.ENABLE_ALERT_MODERATION === undefined) {
		return false;
	}
	return isEnvFlagTrue('ENABLE_ALERT_MODERATION');
}

function parseList(value) {
	if (typeof value !== 'string') {
		return [];
	}
	return value
		.split(',')
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0 && entry.length <= 64)
		.slice(0, MAX_DENYLIST_ENTRIES);
}

function resolveDenylist() {
	const fromEnv = parseList(process.env.ALERT_MODERATION_DENYLIST);
	if (fromEnv.length > 0) {
		return fromEnv;
	}
	const filePath = process.env.ALERT_MODERATION_DENYLIST_FILE;
	if (typeof filePath === 'string' && filePath.trim().length > 0) {
		try {
			const stat = fs.statSync(filePath);
			if (stat.isFile() && stat.size <= MAX_FILE_BYTES) {
				const contents = fs.readFileSync(filePath, 'utf8');
				return parseList(contents);
			}
		} catch (error) {
			console.warn('[AlertModeration] Failed to read denylist file:', error.message);
		}
	}
	return [];
}

function resolveRegex() {
	const raw = process.env.ALERT_MODERATION_REGEX;
	if (typeof raw !== 'string') {
		return null;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_REGEX_LENGTH) {
		return null;
	}
	try {
		return new RegExp(trimmed, 'i');
	} catch (error) {
		console.warn('[AlertModeration] Invalid ALERT_MODERATION_REGEX pattern:', error.message);
		return null;
	}
}

function hasControlCharacters(text) {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
			return true;
		}
		if (code === 0x7f) {
			return true;
		}
	}
	return false;
}

function hasLoneSurrogate(text) {
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
			if (next < 0xdc00 || next > 0xdfff) {
				return true;
			}
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

function hasIdenticalRun(text) {
	if (text.length < MAX_IDENTICAL_CHARS) {
		return false;
	}
	let run = 1;
	for (let index = 1; index < text.length; index += 1) {
		if (text[index] === text[index - 1]) {
			run += 1;
			if (run >= MAX_IDENTICAL_CHARS) {
				return true;
			}
		} else {
			run = 1;
		}
	}
	return false;
}

function hashPayload(text) {
	return crypto
		.createHash('sha256')
		.update(typeof text === 'string' ? text : String(text || ''))
		.digest('hex')
		.slice(0, 32);
}

function findDenylistMatch(text, denylist) {
	if (!Array.isArray(denylist) || denylist.length === 0) {
		return null;
	}
	const lower = text.toLowerCase();
	for (let index = 0; index < denylist.length; index += 1) {
		const term = denylist[index];
		if (term.length > 0 && lower.indexOf(term) !== -1) {
			return term;
		}
	}
	return null;
}

function findRegexMatch(text, regex) {
	if (!regex) {
		return null;
	}
	const match = text.match(regex);
	return match ? match[0] : null;
}

function createAlertModeration(options = {}) {
	const state = {
		counters: {
			accepted: 0,
			rejected: 0,
			regexMatches: 0,
			lastRejectedAt: null,
		},
		denylist: options.denylist || [],
		regex: options.regex || null,
	};

	function recordRejection({ reason, payload, textLength, requestId, feature }) {
		state.counters.rejected += 1;
		state.counters.lastRejectedAt = new Date().toISOString();
		if (reason === 'regex') {
			state.counters.regexMatches += 1;
		}

		try {
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				feature: feature || 'alert-moderation',
				error: new Error(`Alert moderation rejected payload: ${reason}`),
				http: {
					endpoint: '/api/webhook/alert',
					method: 'POST',
					statusCode: 200,
					requestId,
				},
				alert: {
					textLength,
					hasEnrichment: false,
					enrichedSource: 'other',
					truncated: false,
				},
				extra: {
					reason,
					payloadHash: hashPayload(payload),
				},
			});
		} catch (error) {
			console.warn('[AlertModeration] Failed to capture rejection event:', error.message);
		}
	}

	function evaluate(text, evalOptions = {}) {
		try {
			if (typeof text !== 'string' || text.length === 0) {
				return { rejected: false };
			}

			if (hasControlCharacters(text)) {
				recordRejection({
					reason: 'control_characters',
					payload: text,
					textLength: text.length,
					requestId: evalOptions.requestId,
				});
				return { rejected: true, reason: 'control_characters' };
			}

			if (hasLoneSurrogate(text)) {
				recordRejection({
					reason: 'lone_surrogate',
					payload: text,
					textLength: text.length,
					requestId: evalOptions.requestId,
				});
				return { rejected: true, reason: 'lone_surrogate' };
			}

			if (hasIdenticalRun(text)) {
				recordRejection({
					reason: 'identical_run',
					payload: text,
					textLength: text.length,
					requestId: evalOptions.requestId,
				});
				return { rejected: true, reason: 'identical_run' };
			}

			const matched = findDenylistMatch(text, state.denylist);
			if (matched) {
				recordRejection({
					reason: 'denylist',
					payload: text,
					textLength: text.length,
					requestId: evalOptions.requestId,
				});
				return { rejected: true, reason: 'denylist', matched };
			}

			const regexMatch = findRegexMatch(text, state.regex);
			if (regexMatch) {
				recordRejection({
					reason: 'regex',
					payload: text,
					textLength: text.length,
					requestId: evalOptions.requestId,
				});
				return { rejected: true, reason: 'regex', matched: regexMatch };
			}

			state.counters.accepted += 1;
			return { rejected: false };
		} catch (error) {
			console.warn('[AlertModeration] Evaluation failed, failing open:', error.message);
			return { rejected: false, failOpen: true };
		}
	}

	return {
		isEnabled: resolveEnabled,
		evaluate,
		getStats() {
			return { ...state.counters };
		},
		reset() {
			state.counters.accepted = 0;
			state.counters.rejected = 0;
			state.counters.regexMatches = 0;
			state.counters.lastRejectedAt = null;
		},
		refreshConfig() {
			state.denylist = resolveDenylist();
			state.regex = resolveRegex();
		},
		_state: state,
	};
}

const singleton = createAlertModeration();
singleton.refreshConfig();

module.exports = {
	alertModeration: singleton,
	createAlertModeration,
	resolveDenylist,
	resolveRegex,
	resolveEnabled,
	hasControlCharacters,
	hasLoneSurrogate,
	hasIdenticalRun,
	hashPayload,
	MAX_IDENTICAL_CHARS,
	MAX_DENYLIST_ENTRIES,
	MAX_REGEX_LENGTH,
};
