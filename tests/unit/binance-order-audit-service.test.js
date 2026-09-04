'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const {
	BinanceOrderAuditService,
	binanceOrderAuditService,
	isEnabled,
	getRetentionDays,
	hashOperator,
	extractOperatorHash,
	sanitizeFirestoreValue,
	COLLECTION_NAME,
	DEFAULT_RETENTION_DAYS,
} = require('../../src/services/trading/BinanceOrderAuditService');

describe('BinanceOrderAuditService', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.ENABLE_BINANCE_ORDER_AUDIT;
		delete process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS;
		binanceOrderAuditService._resetForTesting();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
		binanceOrderAuditService._resetForTesting();
	});

	describe('configuration and helpers', () => {
		it('is disabled by default', () => {
			expect(isEnabled()).toBe(false);
			expect(binanceOrderAuditService.isEnabled()).toBe(false);
		});

		it('enables when ENABLE_BINANCE_ORDER_AUDIT is true', () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			expect(isEnabled()).toBe(true);
			expect(binanceOrderAuditService.isEnabled()).toBe(true);
		});

		it('returns default retention days of 30', () => {
			expect(getRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
			expect(binanceOrderAuditService.getRetentionDays()).toBe(30);
		});

		it('parses valid custom retention days within 1 to 365', () => {
			process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS = '60';
			expect(getRetentionDays()).toBe(60);

			process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS = '1';
			expect(getRetentionDays()).toBe(1);

			process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS = '365';
			expect(getRetentionDays()).toBe(365);
		});

		it('falls back to 30 for invalid or out-of-range retention days', () => {
			process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS = '0';
			expect(getRetentionDays()).toBe(30);

			process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS = '366';
			expect(getRetentionDays()).toBe(30);

			process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS = 'not-a-number';
			expect(getRetentionDays()).toBe(30);
		});

		it('hashes operator strings to 64-char sha256 hex', () => {
			const raw = 'my-secret-operator-key';
			const expected = crypto.createHash('sha256').update(raw).digest('hex');
			expect(hashOperator(raw)).toBe(expected);
			expect(hashOperator(expected)).toBe(expected);
			expect(hashOperator('')).toBe('unknown');
			expect(hashOperator(null)).toBe('unknown');
			expect(hashOperator(undefined)).toBe('unknown');
		});

		it('extracts and hashes operator from request headers or query params', () => {
			const expected = crypto.createHash('sha256').update('test-api-key').digest('hex');

			expect(extractOperatorHash({ headers: { 'x-api-key': 'test-api-key' } })).toBe(expected);
			expect(extractOperatorHash({ headers: { 'X-API-Key': 'test-api-key' } })).toBe(expected);
			expect(extractOperatorHash({ query: { 'api-key': 'test-api-key' } })).toBe(expected);
			expect(extractOperatorHash({ headers: { authorization: 'Bearer jwt.token.here' } })).toBe(
				crypto.createHash('sha256').update('Bearer jwt.token.here').digest('hex'),
			);
			expect(extractOperatorHash(null)).toBe('unknown');
			expect(extractOperatorHash({})).toBe('unknown');
		});

		it('sanitizes Firestore values by removing undefined and redacting credentials', () => {
			const sanitized = sanitizeFirestoreValue({
				regular: 'value',
				missing: undefined,
				nested: {
					innerMissing: undefined,
					innerValue: 123,
					secret: 'do-not-leak',
					apiKey: 'strip-me',
					token: 'remove-me',
				},
				array: ['a', undefined, 'b'],
			});

			expect(sanitized).toEqual({
				regular: 'value',
				missing: null,
				nested: {
					innerMissing: null,
					innerValue: 123,
				},
				array: ['a', null, 'b'],
			});
			expect(sanitized.nested.secret).toBeUndefined();
			expect(sanitized.nested.apiKey).toBeUndefined();
			expect(sanitized.nested.token).toBeUndefined();
		});
	});

	describe('getStatus', () => {
		it('reports disabled status when ENABLE_BINANCE_ORDER_AUDIT is false', () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'false';
			const status = binanceOrderAuditService.getStatus();
			expect(status).toEqual({
				enabled: false,
				configured: expect.any(Boolean),
				ready: false,
				status: 'disabled',
				collection: COLLECTION_NAME,
				retentionDays: 30,
			});
		});

		it('reports misconfigured status when enabled without Firestore credentials', () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
			delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

			const status = binanceOrderAuditService.getStatus();
			expect(status.enabled).toBe(true);
			if (!status.configured) {
				expect(status.ready).toBe(false);
				expect(status.status).toBe('misconfigured');
			}
		});
	});

	describe('recordMutation and getAuditRecord', () => {
		let mockDb;
		let mockDocRef;
		let mockCollection;
		let service;

		beforeEach(() => {
			mockDocRef = {
				set: jest.fn().mockResolvedValue({ writeTime: {} }),
				get: jest.fn(),
			};
			mockCollection = {
				doc: jest.fn().mockReturnValue(mockDocRef),
			};
			mockDb = {
				collection: jest.fn().mockReturnValue(mockCollection),
			};

			service = new BinanceOrderAuditService({ firestore: mockDb });
		});

		it('returns null and does not write when disabled', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'false';
			const result = await service.recordMutation({
				action: 'PLACE',
				symbol: 'BTCUSDT',
			});

			expect(result).toBeNull();
			expect(mockDb.collection).not.toHaveBeenCalled();
		});

		it('records a PLACE mutation document with complete fields and TTL', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });
			process.env.BINANCE_ORDER_AUDIT_RETENTION_DAYS = '45';

			const result = await service.recordMutation({
				orderId: 'test-order-uuid-1',
				operator: 'operator-key-123',
				action: 'PLACE',
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.5',
				price: '50000',
				status: 'FILLED',
				binanceOrderId: 1234567,
				response: { orderId: 1234567, status: 'FILLED' },
				processingMs: 42,
			});

			expect(mockDb.collection).toHaveBeenCalledWith('binanceOrderAudit');
			expect(mockCollection.doc).toHaveBeenCalledWith('test-order-uuid-1');
			expect(mockDocRef.set).toHaveBeenCalledTimes(1);

			const writtenData = mockDocRef.set.mock.calls[0][0];
			expect(writtenData).toMatchObject({
				orderId: 'test-order-uuid-1',
				operator: crypto.createHash('sha256').update('operator-key-123').digest('hex'),
				action: 'PLACE',
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.5',
				price: '50000',
				status: 'FILLED',
				binanceOrderId: '1234567',
				processingMs: 42,
			});
			expect(writtenData.timestamp).toBeDefined();
			expect(writtenData.expiresAt).toBeDefined();
			expect(result).toEqual(writtenData);
		});

		it('records a CANCEL mutation document with complete fields', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			const result = await service.recordMutation({
				operator: 'operator-cancel-key',
				action: 'CANCEL',
				symbol: 'ETHUSDT',
				status: 'CANCELED',
				binanceOrderId: 987654,
				processingMs: 15,
			});

			expect(mockDb.collection).toHaveBeenCalledWith('binanceOrderAudit');
			expect(mockDocRef.set).toHaveBeenCalledTimes(1);

			const writtenData = mockDocRef.set.mock.calls[0][0];
			expect(writtenData).toMatchObject({
				action: 'CANCEL',
				symbol: 'ETHUSDT',
				status: 'CANCELED',
				binanceOrderId: '987654',
				processingMs: 15,
			});
			expect(result).toEqual(writtenData);
		});

		it('fails open and returns null when firestore.set rejects', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });
			mockDocRef.set.mockRejectedValue(new Error('Firestore network error'));

			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await service.recordMutation({
				action: 'PLACE',
				symbol: 'BTCUSDT',
			});

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				'[BinanceOrderAuditService] Failed to record mutation audit log:',
				'Firestore network error',
			);
			warnSpy.mockRestore();
		});

		it('reads an audit record by orderId via getAuditRecord', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });
			mockDocRef.get.mockResolvedValue({
				exists: true,
				id: 'order-123',
				data: () => ({ symbol: 'BTCUSDT', action: 'PLACE' }),
			});

			const record = await service.getAuditRecord('order-123');
			expect(record).toEqual({
				id: 'order-123',
				symbol: 'BTCUSDT',
				action: 'PLACE',
			});
		});

		it('returns null when getAuditRecord document does not exist', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });
			mockDocRef.get.mockResolvedValue({
				exists: false,
			});

			const record = await service.getAuditRecord('non-existent');
			expect(record).toBeNull();
		});
	});
});
