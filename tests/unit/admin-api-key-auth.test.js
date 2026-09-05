'use strict';

const {
	getAdminApiKey,
	isAdminApiKeyScoped,
	isValidAdminApiKey,
	isValidBinanceTradingApiKey,
} = require('../../src/lib/auth');

function withEnv(vars, fn) {
	const saved = {};
	for (const key of Object.keys(vars)) {
		saved[key] = process.env[key];
		if (vars[key] === undefined) delete process.env[key];
		else process.env[key] = vars[key];
	}
	try {
		return fn();
	} finally {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe('admin/operator API key scope helpers', () => {
	it('isAdminApiKeyScoped reflects ADMIN_API_KEY presence', () => {
		expect(isAdminApiKeyScoped()).toBe(false);
		withEnv({ ADMIN_API_KEY: 'admin-secret' }, () => {
			expect(isAdminApiKeyScoped()).toBe(true);
		});
		expect(isAdminApiKeyScoped()).toBe(false);
	});

	it('getAdminApiKey returns ADMIN_API_KEY when set, else falls back to WEBHOOK_API_KEY', () => {
		withEnv({ WEBHOOK_API_KEY: 'webhook-only', ADMIN_API_KEY: undefined }, () => {
			expect(getAdminApiKey()).toBe('webhook-only');
		});
		withEnv({ WEBHOOK_API_KEY: 'webhook-only', ADMIN_API_KEY: 'admin-only' }, () => {
			expect(getAdminApiKey()).toBe('admin-only');
		});
		withEnv({ WEBHOOK_API_KEY: undefined, ADMIN_API_KEY: 'admin-only' }, () => {
			expect(getAdminApiKey()).toBe('admin-only');
		});
	});

	describe('isValidAdminApiKey scope separation', () => {
		const adminReq = { headers: { 'x-api-key': 'admin-only' } };
		const webhookReq = { headers: { 'x-api-key': 'webhook-only' } };
		const noKeyReq = { headers: {} };

		it('rejects the webhook key on admin when ADMIN_API_KEY is set', () => {
			withEnv({ WEBHOOK_API_KEY: 'webhook-only', ADMIN_API_KEY: 'admin-only' }, () => {
				expect(isValidAdminApiKey(adminReq)).toBe(true);
				expect(isValidAdminApiKey(webhookReq)).toBe(false);
			});
		});

		it('accepts the webhook key on admin when ADMIN_API_KEY is unset (legacy fallback)', () => {
			withEnv({ WEBHOOK_API_KEY: 'webhook-only', ADMIN_API_KEY: undefined }, () => {
				expect(isValidAdminApiKey(adminReq)).toBe(false);
				expect(isValidAdminApiKey(webhookReq)).toBe(true);
			});
		});

		it('returns true on no-credential dev/test fallback so the gate stays open', () => {
			withEnv({ WEBHOOK_API_KEY: undefined, ADMIN_API_KEY: undefined }, () => {
				expect(isValidAdminApiKey(noKeyReq)).toBe(true);
			});
		});
	});

	describe('isValidBinanceTradingApiKey', () => {
		const tradingReq = { headers: { 'x-api-key': 'trading-only' } };
		const webhookReq = { headers: { 'x-api-key': 'webhook-only' } };

		it('accepts the trading key when configured', () => {
			withEnv({ BINANCE_TRADING_API_KEY: 'trading-only' }, () => {
				expect(isValidBinanceTradingApiKey(tradingReq)).toBe(true);
				expect(isValidBinanceTradingApiKey(webhookReq)).toBe(false);
			});
		});

		it('returns false when no trading key is configured (caller must fall back)', () => {
			withEnv({ BINANCE_TRADING_API_KEY: undefined }, () => {
				expect(isValidBinanceTradingApiKey(tradingReq)).toBe(false);
			});
		});
	});
});
