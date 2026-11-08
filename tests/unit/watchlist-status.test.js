const { getStatus } = require('../../src/controllers/status');

describe('watchlist status', () => {
	it('exposes the Telegram watchlist and storage mode without chat IDs', () => {
		const status = getStatus();
		expect(status.featureFlags.watchlist).toBe(true);
		expect(status.dependencies.watchlist).toEqual(expect.objectContaining({ mode: expect.any(String) }));
		expect(status.dependencies.watchlist.enabled).toBe(true);
		expect(JSON.stringify(status.dependencies.watchlist)).not.toMatch(/chatId|symbols/);
	});
});
