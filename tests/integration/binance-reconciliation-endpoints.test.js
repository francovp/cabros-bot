'use strict';

const express = require('express');
const request = require('supertest');
const { getRoutes } = require('../../src/routes');
const { idempotencyService } = require('../../src/services/storage/IdempotencyService');
const { binanceOrderAuditService } = require('../../src/services/trading/BinanceOrderAuditService');
const autoTradeReservationService = require('../../src/services/trading/AutoTradeReservationService');
const { getStatus } = require('../../src/controllers/status');

const mockRecords = new Map();
let mockUnavailable = false;

const mockFirestore = {
	collection: (name) => ({
		doc: (id) => ({
			id: `${name}/${id}`,
			get: async () => ({
				exists: mockRecords.has(`${name}/${id}`),
				id,
				data: () => mockRecords.get(`${name}/${id}`),
			}),
			update: async (data) => mockRecords.set(`${name}/${id}`, { ...mockRecords.get(`${name}/${id}`), ...data }),
			delete: async () => mockRecords.delete(`${name}/${id}`),
		}),
		where: (field, op, value) => ({
			limit: (lim) => ({
				get: async () => {
					const docs = [];
					for (const [key, data] of mockRecords.entries()) {
						if (!key.startsWith(`${name}/`)) continue;
						let match = false;
						if (field.includes('.')) {
							const parts = field.split('.');
							let val = data;
							for (const part of parts) {
								val = val?.[part];
							}
							match = op === '==' ? val === value : false;
						} else {
							match = op === '==' ? data[field] === value : false;
						}
						if (match) docs.push({ id: key.replace(`${name}/`, ''), data: () => data });
						if (docs.length >= lim) break;
					}
					return { docs };
				},
			}),
			get: async () => {
				const docs = [];
				for (const [key, data] of mockRecords.entries()) {
					if (!key.startsWith(`${name}/`)) continue;
					const match = op === '==' ? data[field] === value : false;
					if (match) docs.push({ id: key.replace(`${name}/`, ''), data: () => data });
				}
				return { docs };
			},
		}),
		limit: (lim) => ({
			get: async () => {
				const docs = [];
				for (const [key, data] of mockRecords.entries()) {
					if (!key.startsWith(`${name}/`)) continue;
					docs.push({ id: key.replace(`${name}/`, ''), data: () => data });
					if (docs.length >= lim) break;
				}
				return { docs };
			},
		}),
	}),
	runTransaction: async (callback) => {
		return callback({
			get: async (ref) => ({
				exists: mockRecords.has(ref.id),
				id: ref.id.includes('/') ? ref.id.split('/')[1] : ref.id,
				data: () => mockRecords.get(ref.id),
			}),
			set: (ref, data) => mockRecords.set(ref.id, data),
			update: (ref, data) => mockRecords.set(ref.id, { ...mockRecords.get(ref.id), ...data }),
			delete: (ref) => mockRecords.delete(ref.id),
		});
	},
};

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	getFirestore: () => mockUnavailable ? null : mockFirestore,
	isEnabled: () => true,
	isConfigured: () => true,
}));

describe('Binance Reconciliation Endpoints (#1466)', () => {
	let app;
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-api-key',
			ADMIN_API_KEY: 'test-admin-key',
			ENABLE_BINANCE_TRADING: 'true',
			BINANCE_API_KEY: 'fake-key',
			BINANCE_API_SECRET: 'fake-secret',
			BINANCE_TRADING_ALLOWED_SYMBOLS: 'BTCUSDT,ETHUSDT',
			ENABLE_BINANCE_ORDER_AUDIT: 'true',
		});

		mockRecords.clear();
		mockUnavailable = false;
		autoTradeReservationService.__resetForTesting();
		idempotencyService.clear();

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes());
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in savedEnv)) delete process.env[key];
		}
		Object.assign(process.env, savedEnv);
	});

	it('requires authentication for reconciliation endpoints', async () => {
		const res = await request(app).get('/api/trading/binance/reconciliation');
		expect([401, 403]).toContain(res.status);
	});

	it('lists ambiguous reservations via GET /api/trading/binance/reconciliation', async () => {
		const reservation = await autoTradeReservationService.reserveAutoTrade('sig-recon-1', 'fingerprint-1', {
			cooldownKey: 'autotrade|BINANCE|BTCUSDT|1h|BUY',
			cooldownMs: 3600000,
			context: { symbol: 'BTCUSDT', side: 'BUY', timeframe: '1h' },
		});
		await autoTradeReservationService.finishAutoTrade(reservation, 'unknown', {
			errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
			errorMessage: 'Execution unknown',
		});

		const res = await request(app)
			.get('/api/trading/binance/reconciliation')
			.set('x-api-key', 'test-admin-key');

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.reservations).toHaveLength(1);
		expect(res.body.reservations[0]).toMatchObject({
			signalId: 'sig-recon-1',
			ambiguous: true,
			ambiguousReason: 'BINANCE_ORDER_STATUS_UNKNOWN',
		});
		expect(res.body.ambiguousCount).toBe(1);
	});

	it('returns an ambiguous reservation by id via GET /api/trading/binance/reconciliation/:reservationId', async () => {
		const reservation = await autoTradeReservationService.reserveAutoTrade('sig-recon-2', 'fingerprint-2', {
			cooldownKey: 'autotrade|BINANCE|BTCUSDT|1h|BUY',
			cooldownMs: 3600000,
			context: { symbol: 'BTCUSDT', side: 'BUY' },
		});
		await autoTradeReservationService.finishAutoTrade(reservation, 'unknown', {
			errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
		});

		const res = await request(app)
			.get(`/api/trading/binance/reconciliation/${reservation.id}`)
			.set('x-api-key', 'test-admin-key');

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.reservation.id).toBe(reservation.id);
		expect(res.body.reservation.ambiguous).toBe(true);
	});

	it('returns 404 when reservation is not found', async () => {
		const res = await request(app)
			.get('/api/trading/binance/reconciliation/nonexistent-id')
			.set('x-api-key', 'test-admin-key');

		expect(res.status).toBe(404);
		expect(res.body.code).toBe('RESERVATION_NOT_FOUND');
	});

	it('resolves an ambiguous reservation as placed via POST', async () => {
		const reservation = await autoTradeReservationService.reserveAutoTrade('sig-recon-placed', 'fingerprint-p', {
			cooldownKey: 'autotrade|BINANCE|BTCUSDT|1h|BUY',
			cooldownMs: 3600000,
			context: { symbol: 'BTCUSDT', side: 'BUY' },
		});
		await autoTradeReservationService.finishAutoTrade(reservation, 'unknown', {
			errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
		});

		const res = await request(app)
			.post(`/api/trading/binance/reconciliation/${reservation.id}`)
			.set('x-api-key', 'test-admin-key')
			.send({
				resolvedAs: 'placed',
				orderId: 554433,
				notes: 'Matched with Binance order 554433',
			});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.action).toBe('reconcile_resolve');
		expect(res.body.resolvedAs).toBe('placed');
		expect(res.body.reservation).toMatchObject({
			status: 'submitted',
			ambiguous: false,
			orderId: 554433,
			notes: 'Matched with Binance order 554433',
		});
	});

	it('resolves an ambiguous reservation as not_placed and settles cooldown', async () => {
		const reservation = await autoTradeReservationService.reserveAutoTrade('sig-recon-notplaced', 'fingerprint-np', {
			cooldownKey: 'autotrade|BINANCE|BTCUSDT|1h|BUY',
			cooldownMs: 3600000,
			context: { symbol: 'BTCUSDT', side: 'BUY' },
		});
		await autoTradeReservationService.finishAutoTrade(reservation, 'unknown', {
			errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
		});

		const res = await request(app)
			.post(`/api/trading/binance/reconciliation/${reservation.id}`)
			.set('x-api-key', 'test-admin-key')
			.send({
				resolvedAs: 'not_placed',
				notes: 'Order never appeared in open or historical orders',
			});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.resolvedAs).toBe('not_placed');
		expect(res.body.reservation.status).toBe('failed');
		expect(res.body.reservation.ambiguous).toBe(false);
	});

	it('rejects invalid resolvedAs values with 400', async () => {
		const res = await request(app)
			.post('/api/trading/binance/reconciliation/some-id')
			.set('x-api-key', 'test-admin-key')
			.send({ resolvedAs: 'invalid_choice' });

		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('exposes ambiguous reservations on GET /api/trading/binance/orders?reconciliation=ambiguous', async () => {
		const reservation = await autoTradeReservationService.reserveAutoTrade('sig-orders-filter', 'fingerprint-f', {
			cooldownKey: 'autotrade|BINANCE|BTCUSDT|1h|BUY',
			cooldownMs: 3600000,
			context: { symbol: 'BTCUSDT', side: 'BUY' },
		});
		await autoTradeReservationService.finishAutoTrade(reservation, 'unknown', {
			errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
		});

		const res = await request(app)
			.get('/api/trading/binance/orders?reconciliation=ambiguous')
			.set('x-api-key', 'test-admin-key');

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.reconciliation).toBe(true);
		expect(res.body.reservations).toHaveLength(1);
	});

	it('exposes ambiguousCount in status endpoint', () => {
		autoTradeReservationService.trackAmbiguous('res-1');
		autoTradeReservationService.trackAmbiguous('res-2');

		const status = getStatus();
		expect(status.dependencies.binanceTrading.ambiguousCount).toBe(2);
		expect(status.dependencies.binanceTrading.ambiguousReservationsCount).toBe(2);
	});
});
