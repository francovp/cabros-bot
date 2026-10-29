const { sendWithWatchlistRouting, validateWatchlistFlag } = require('../../src/services/watchlist/watchlistRouting');
const { WatchlistService } = require('../../src/services/watchlist/WatchlistService');

describe('watchlist webhook routing', () => {
	let service;
	let manager;

	beforeEach(async () => {
		service = new WatchlistService({ firestoreEnabled: false });
		await service.add('12345', ['BTCUSDT']);
		manager = {
			getEnabledChannels: () => ['telegram', 'whatsapp'],
			sendToAll: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }, { channel: 'whatsapp', success: true }]),
			sendToChannels: jest.fn().mockResolvedValue([{ channel: 'whatsapp', success: true }]),
		};
	});

	it('suppresses only Telegram for an unmatched known symbol', async () => {
		const results = await sendWithWatchlistRouting(manager, { text: 'BINANCE:ETHUSDT buy' },
			{ requireWatchlistMatch: true, telegramChatId: '12345' }, {}, service);
		expect(results).toEqual([{ channel: 'whatsapp', success: true },
			{ channel: 'telegram', success: false, skipped: 'watchlist' }]);
		expect(manager.sendToChannels).toHaveBeenCalledWith(expect.any(Object), ['whatsapp'], {});
		expect(manager.sendToAll).not.toHaveBeenCalled();
	});

	it('retains broadcast for an unknown symbol or disabled flag', async () => {
		await sendWithWatchlistRouting(manager, { text: 'market update' },
			{ requireWatchlistMatch: true, telegramChatId: '12345' }, {}, service);
		expect(manager.sendToAll).toHaveBeenCalledTimes(1);
		await sendWithWatchlistRouting(manager, { text: 'ETHUSDT buy' },
			{ telegramChatId: '12345' }, {}, service);
		expect(manager.sendToAll).toHaveBeenCalledTimes(2);
	});

	it('rejects non-boolean opt-in values', () => {
		expect(() => validateWatchlistFlag('true')).toThrow('requireWatchlistMatch');
		expect(validateWatchlistFlag(true)).toBe(true);
	});

	it('filters each symbol route independently', async () => {
		manager.sendToChannels.mockImplementation(async (_alert, channels) => channels.map((channel) => ({ channel, success: true })));
		const results = await sendWithWatchlistRouting(manager,
			{ text: 'BTCUSDT and ETHUSDT' },
			{ requireWatchlistMatch: true, telegramChatId: '12345', symbolRoutes: {
				BTCUSDT: { channels: ['telegram', 'whatsapp'] },
				ETHUSDT: { channels: ['telegram', 'whatsapp'] },
			} }, {}, service);
		expect(results.filter((result) => result.channel === 'telegram' && result.success).map((result) => result.symbol)).toEqual(['BTCUSDT']);
		expect(results.filter((result) => result.channel === 'whatsapp').map((result) => result.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
	});

	it('does not skip an inactive route sharing a bare symbol', async () => {
		const results = await sendWithWatchlistRouting(manager, { text: 'NASDAQ:NVDA earnings' },
			{ requireWatchlistMatch: true, telegramChatId: '12345', symbolRoutes: {
				'NASDAQ:NVDA': { channels: ['telegram'] },
				'NYSE:NVDA': { channels: ['telegram'] },
			} }, {}, service);
		expect(results.filter((result) => result.skipped)).toHaveLength(1);
	});

	it('keeps the matched exchange when a bare symbol route is used', async () => {
		await service.add('12345', ['NASDAQ:NVDA']);
		manager.sendToChannels.mockImplementation(async (_alert, channels) => channels.map((channel) => ({ channel, success: true })));
		const routing = { requireWatchlistMatch: true, telegramChatId: '12345',
			symbolRoutes: { NVDA: { channels: ['telegram'] } } };
		const results = await sendWithWatchlistRouting(manager, { text: 'NYSE:NVDA earnings' }, routing, {}, service);
		expect(results).toEqual([{ channel: 'telegram', symbol: 'NVDA', success: false, skipped: 'watchlist' }]);
		expect(manager.sendToChannels).toHaveBeenCalledWith(expect.any(Object), [], {});
	});

	it('allows a bare route when any matching exchange appears in the alert', async () => {
		await service.add('12345', ['NASDAQ:NVDA']);
		const routing = { requireWatchlistMatch: true, telegramChatId: '12345',
			symbolRoutes: { NVDA: { channels: ['telegram'] } } };
		const results = await sendWithWatchlistRouting(manager,
			{ text: 'NYSE:NVDA and NASDAQ:NVDA earnings' }, routing, {}, service);
		expect(results.some((result) => result.skipped === 'watchlist')).toBe(false);
	});

	it('does not let a bare repetition override a known exchange mismatch', async () => {
		await service.add('12345', ['NASDAQ:NVDA']);
		manager.sendToChannels.mockImplementation(async (_alert, channels) => channels.map((channel) => ({ channel, success: true })));
		const results = await sendWithWatchlistRouting(manager,
			{ text: 'NYSE:NVDA earnings for NVDA' },
			{ requireWatchlistMatch: true, telegramChatId: '12345', symbolRoutes: {
				NVDA: { channels: ['telegram'] },
			} }, {}, service);
		expect(results).toEqual([{ channel: 'telegram', symbol: 'NVDA', success: false, skipped: 'watchlist' }]);
	});
});
