const { createWatchlistCommand } = require('../../src/controllers/commands/handlers/watchlist');
const { WatchlistService } = require('../../src/services/watchlist/WatchlistService');

describe('/watchlist Telegram command', () => {
	let command;
	let service;
	let reply;
	const context = (chatId, text) => ({ chat: { id: chatId }, message: { text }, reply });

	beforeEach(() => {
		service = new WatchlistService({ firestoreEnabled: false });
		command = createWatchlistCommand(service);
		reply = jest.fn().mockResolvedValue(undefined);
	});

	it('adds comma- and space-separated symbols to the calling chat', async () => {
		await command(context(-10012345, '/watchlist add BTCUSDT,ETHUSDT NASDAQ:NVDA'));
		expect(await service.get('-10012345')).toEqual(['BTCUSDT', 'ETHUSDT', 'NASDAQ:NVDA']);
		expect(await service.get('-10099999')).toEqual([]);
		expect(reply).toHaveBeenCalledWith(expect.stringContaining('BTCUSDT'), { parse_mode: 'MarkdownV2' });
	});

	it('lists, removes, and clears symbols', async () => {
		await command(context(12345, '/watchlist add BTCUSDT ETHUSDT'));
		await command(context(12345, '/watchlist'));
		await command(context(12345, '/watchlist list'));
		expect(reply).toHaveBeenLastCalledWith(expect.stringContaining('ETHUSDT'), { parse_mode: 'MarkdownV2' });
		await command(context(12345, '/watchlist remove BTCUSDT'));
		expect(await service.get('12345')).toEqual(['ETHUSDT']);
		await command(context(12345, '/watchlist clear'));
		expect(await service.get('12345')).toEqual([]);
	});

	it('rejects an invalid symbol without changing the list', async () => {
		await command(context(12345, '/watchlist add bad/thing'));
		expect(await service.get('12345')).toEqual([]);
		expect(reply).toHaveBeenCalledWith(expect.stringContaining('Invalid'), { parse_mode: 'MarkdownV2' });
	});

	it('shows how many recent stored alerts the current list would have skipped', async () => {
		command = createWatchlistCommand(service, {
			listRecentAlerts: async () => ({ alerts: [
				{ symbol: 'BTCUSDT', exchange: 'BINANCE' },
				{ symbol: 'ETHUSDT', exchange: 'BINANCE' },
				{ symbol: 'unknown', exchange: null },
			] }),
		});
		await command(context(12345, '/watchlist add BTCUSDT'));
		await command(context(12345, '/watchlist'));
		expect(reply.mock.lastCall[0]).toContain('1 de 3');
	});

	it('still replies when optional recent-alert lookup stalls', async () => {
		command = createWatchlistCommand(service, { listRecentAlerts: () => new Promise(() => {}) });
		await command(context(12345, '/watchlist list'));
		expect(reply.mock.lastCall[0]).toContain('Volumen reciente no disponible');
	});
});
