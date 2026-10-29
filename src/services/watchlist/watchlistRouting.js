const alertStorageService = require('../storage/AlertStorageService');
const {
	NotificationRoutingValidationError,
	sendWithNotificationRouting,
	getRequestedChannels,
	resolveSymbolRouteDispatches,
} = require('../notification/requestRouting');
const { watchlistService } = require('./WatchlistService');

function validateWatchlistFlag(value) {
	if (value !== undefined && typeof value !== 'boolean') {
		throw new NotificationRoutingValidationError('"requireWatchlistMatch" must be a boolean if provided',
			{ field: 'requireWatchlistMatch' });
	}
	return value === true;
}

async function sendWithWatchlistRouting(manager, alert, routing = {}, options = {}, service = watchlistService) {
	if (!routing.requireWatchlistMatch) {
		return sendWithNotificationRouting(manager, alert, routing, options);
	}
	const extracted = alertStorageService.extractSymbolAndExchange({
		text: alert.text, symbol: alert.symbol, enrichmentData: alert.enriched,
	});
	const channels = getRequestedChannels(manager, routing, alert.text);
	if (!channels.includes('telegram')) {
		return sendWithNotificationRouting(manager, alert, routing, options);
	}
	const chatId = routing.telegramChatId || process.env.TELEGRAM_CHAT_ID;
	if (chatId && routing.symbolRoutes) {
		const dispatches = resolveSymbolRouteDispatches(alert.text, routing.symbolRoutes, routing, true);
		if (dispatches) {
			const entries = Object.entries(routing.symbolRoutes);
			const activeReferences = new Map(dispatches.map(({ routeKey, references }) => [routeKey, references]));
			const matches = await Promise.all(entries.map(async ([symbol, route]) => {
				const references = activeReferences.get(symbol);
				if (!references) return true;
				if (!(route.channels || routing.channels || manager.getEnabledChannels()).includes('telegram')) return true;
				const qualified = references.filter((reference) => reference.includes(':'));
				const candidates = qualified.length > 0 ? qualified : references;
				return service.matchesAny(chatId, candidates);
			}));
			const skipped = entries.filter(([, route], index) => !matches[index]
				&& (route.channels || routing.channels || manager.getEnabledChannels()).includes('telegram'));
			if (skipped.length === 0) return sendWithNotificationRouting(manager, alert, routing, options);
			const narrowedRoutes = Object.fromEntries(entries.map(([symbol, route], index) => [symbol, {
				...route,
				channels: matches[index] ? route.channels : (route.channels || routing.channels || manager.getEnabledChannels())
					.filter((channel) => channel !== 'telegram'),
			}]));
			const delivered = await sendWithNotificationRouting(manager, alert,
				{ ...routing, symbolRoutes: narrowedRoutes }, options);
			return [...delivered, ...skipped.map(([symbol]) => ({ channel: 'telegram', symbol: symbol.split(':').at(-1),
				success: false, skipped: 'watchlist' }))];
		}
	}
	if (extracted.symbol === 'unknown') {
		return sendWithNotificationRouting(manager, alert, routing, options);
	}
	if (!chatId || await service.matches(chatId, extracted.exchange
		? `${extracted.exchange}:${extracted.symbol}` : extracted.symbol)) {
		return sendWithNotificationRouting(manager, alert, routing, options);
	}
	const otherChannels = channels.filter((channel) => channel !== 'telegram');
	const narrowedRouting = {
		...routing,
		channels: otherChannels,
		symbolRoutes: routing.symbolRoutes
			? Object.fromEntries(Object.entries(routing.symbolRoutes).map(([symbol, route]) => [
				symbol, { ...route, channels: (route.channels || []).filter((channel) => channel !== 'telegram') },
			]))
			: undefined,
	};
	const delivered = otherChannels.length
		? await sendWithNotificationRouting(manager, alert, narrowedRouting, options)
		: [];
	return [...delivered, { channel: 'telegram', success: false, skipped: 'watchlist' }];
}

module.exports = { validateWatchlistFlag, sendWithWatchlistRouting };
