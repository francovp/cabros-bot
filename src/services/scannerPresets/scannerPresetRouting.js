'use strict';

const { MarketScannerRequestError } = require('../tradingview/marketScannerReport');
const { parseNotificationRouting } = require('../notification/requestRouting');

const MAX_DESTINATIONS_PER_CHANNEL = 20;
const DESTINATION_FIELDS = Object.freeze({
	telegramChatIds: 'telegramChatId',
	whatsappChatIds: 'whatsappChatId',
	discordWebhookUrls: 'discordWebhookUrl',
});

function invalidDestinations(field, message) {
	return new MarketScannerRequestError(message || `Invalid scanner preset destination field: ${field}`, 'INVALID_DESTINATIONS', {
		statusCode: 400,
		details: { field: `destinations.${field}` },
	});
}

function normalizePresetDestinations(raw) {
	if (raw === undefined) {
		return undefined;
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw invalidDestinations('', 'destinations must be an object');
	}

	const unknownFields = Object.keys(raw).filter((field) => !Object.hasOwn(DESTINATION_FIELDS, field));
	if (unknownFields.length > 0) {
		throw invalidDestinations(unknownFields[0], `Unsupported scanner preset destination field: ${unknownFields[0]}`);
	}

	const normalized = {};
	for (const [field, routingField] of Object.entries(DESTINATION_FIELDS)) {
		if (!Object.hasOwn(raw, field)) {
			continue;
		}
		const values = raw[field];
		if (!Array.isArray(values) || values.length > MAX_DESTINATIONS_PER_CHANNEL) {
			throw invalidDestinations(field, `${field} must be an array with at most ${MAX_DESTINATIONS_PER_CHANNEL} entries`);
		}

		const unique = [];
		for (const value of values) {
			if (typeof value !== 'string' || value.length === 0) {
				throw invalidDestinations(field, `Every ${field} entry must be a non-empty string`);
			}
			let parsed;
			try {
				parsed = parseNotificationRouting({ [routingField]: value }, { strictChatIds: true });
			} catch (_) {
				throw invalidDestinations(field, `Invalid ${field} entry`);
			}
			const normalizedValue = parsed[routingField];
			if (!unique.includes(normalizedValue)) {
				unique.push(normalizedValue);
			}
		}
		normalized[field] = unique;
	}

	return normalized;
}

function hasLegacyPresetRouting(params = {}) {
	return ['channels', 'telegramChatId', 'telegramThreadId', 'whatsappChatId', 'discordWebhookUrl']
		.some((field) => params[field] !== undefined && params[field] !== null && params[field] !== '');
}

function normalizePresetMode(mode, params = {}) {
	if (mode === undefined && hasLegacyPresetRouting(params)) {
		// Old records and older clients that explicitly save legacy routing retain
		// that behavior. A clean new preset defaults to inherited broadcast.
		return undefined;
	}
	if (mode === undefined) {
		return 'inherit';
	}
	if (mode !== 'preset' && mode !== 'inherit') {
		throw new MarketScannerRequestError('mode must be either "preset" or "inherit"', 'INVALID_REQUEST');
	}
	return mode;
}

function definedFields(value = {}) {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function resolveScannerPresetRouting(preset = {}, requestRouting = {}) {
	const request = definedFields(requestRouting);
	if (preset.mode === 'inherit') {
		return request;
	}

	if (preset.mode === 'preset') {
		const destinations = {};
		for (const [field, routingField] of Object.entries(DESTINATION_FIELDS)) {
			const saved = preset.destinations && preset.destinations[field];
			if (Array.isArray(saved) && saved.length > 0) {
				destinations[field] = [...saved];
			}
			if (requestRouting[routingField] !== undefined) {
				destinations[field] = [requestRouting[routingField]];
			}
		}

		const destinationChannelByField = {
			telegramChatIds: 'telegram',
			whatsappChatIds: 'whatsapp',
			discordWebhookUrls: 'discord',
		};
		const configuredChannels = Object.entries(destinationChannelByField)
			.filter(([field]) => Array.isArray(destinations[field]) && destinations[field].length > 0)
			.map(([, channel]) => channel);
		const channels = requestRouting.channels
			? requestRouting.channels.filter((channel) => configuredChannels.includes(channel))
			: configuredChannels;
		if (requestRouting.channels && channels.length === 0) {
			throw new MarketScannerRequestError(
				'Selected channels have no configured destinations for this preset',
				'INVALID_REQUEST',
				{ statusCode: 400, details: { field: 'channels' } },
			);
		}
		for (const [field, channel] of Object.entries(destinationChannelByField)) {
			if (!channels.includes(channel)) {
				delete destinations[field];
			}
		}
		const routing = {
			channels,
			destinations,
		};
		const telegramThreadId = requestRouting.telegramThreadId !== undefined
			? requestRouting.telegramThreadId
			: preset.telegramThreadId;
		if (telegramThreadId !== undefined) {
			routing.telegramThreadId = telegramThreadId;
		}
		return routing;
	}

	// Mode-less documents are pre-feature presets. Keep their established
	// single-destination routing and let an explicit run request override it.
	return definedFields({
		channels: requestRouting.channels !== undefined ? requestRouting.channels : preset.channels,
		telegramChatId: requestRouting.telegramChatId !== undefined ? requestRouting.telegramChatId : preset.telegramChatId,
		telegramThreadId: requestRouting.telegramThreadId !== undefined ? requestRouting.telegramThreadId : preset.telegramThreadId,
		whatsappChatId: requestRouting.whatsappChatId !== undefined ? requestRouting.whatsappChatId : preset.whatsappChatId,
		discordWebhookUrl: requestRouting.discordWebhookUrl !== undefined ? requestRouting.discordWebhookUrl : preset.discordWebhookUrl,
	});
}

module.exports = {
	MAX_DESTINATIONS_PER_CHANNEL,
	DESTINATION_FIELDS,
	normalizePresetDestinations,
	normalizePresetMode,
	resolveScannerPresetRouting,
};
