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

		it('hashes operator strings to 64-char hex and hashes 64-char hex keys without bypass', () => {
			const raw = 'my-secret-operator-key';
			const expected = crypto.pbkdf2Sync(raw, 'cabros-bot:binance-order-audit', 10000, 32, 'sha256').toString('hex');
			expect(hashOperator(raw)).toBe(expected);

			// Critical: standard 32-byte hex keys (64 hex chars) must be hashed, never returned in plaintext
			const hexKey64 = 'a'.repeat(64);
			const hashedHexKey = hashOperator(hexKey64);
			expect(hashedHexKey).not.toBe(hexKey64);
			expect(hashedHexKey).toBe(
				crypto.pbkdf2Sync(hexKey64, 'cabros-bot:binance-order-audit', 10000, 32, 'sha256').toString('hex'),
			);

			expect(hashOperator('')).toBe('unknown');
			expect(hashOperator(null)).toBe('unknown');
			expect(hashOperator(undefined)).toBe('unknown');
		});

		it('extracts and hashes operator from request headers or query params including arrays', () => {
			const expected = crypto.pbkdf2Sync('test-api-key', 'cabros-bot:binance-order-audit', 10000, 32, 'sha256').toString('hex');

			expect(extractOperatorHash({ headers: { 'x-api-key': 'test-api-key' } })).toBe(expected);
			expect(extractOperatorHash({ headers: { 'X-API-Key': 'test-api-key' } })).toBe(expected);
			expect(extractOperatorHash({ query: { 'api-key': 'test-api-key' } })).toBe(expected);
			expect(extractOperatorHash({ query: { 'api-key': ['test-api-key', 'extra-key'] } })).toBe(expected);
			expect(extractOperatorHash({ headers: { authorization: 'Bearer jwt.token.here' } })).toBe(
				crypto.pbkdf2Sync('Bearer jwt.token.here', 'cabros-bot:binance-order-audit', 10000, 32, 'sha256').toString('hex'),
			);
			expect(extractOperatorHash(null)).toBe('unknown');
			expect(extractOperatorHash({})).toBe('anonymous');
		});

		it('sanitizes Firestore values by preserving Dates, removing undefined, and redacting credentials', () => {
			const date = new Date('2026-06-01T00:00:00.000Z');
			const sanitized = sanitizeFirestoreValue({
				regular: 'value',
				createdAt: date,
				missing: undefined,
				nested: {
					innerMissing: undefined,
					innerValue: 123,
					secret: 'do-not-leak',
					apiKey: 'strip-me',
					api_key: 'strip-me-too',
					binanceApiKey: 'strip-prefixed',
					access_token: 'strip-token',
					private_key: 'strip-private',
					authorization: 'Bearer 123',
					webhookUrl: 'https://secret.com',
				},
				array: ['a', undefined, 'b'],
			});

			expect(sanitized).toEqual({
				regular: 'value',
				createdAt: date,
				missing: null,
				nested: {
					innerMissing: null,
					innerValue: 123,
				},
				array: ['a', null, 'b'],
			});
			expect(sanitized.createdAt).toBeInstanceOf(Date);
			expect(sanitized.nested.secret).toBeUndefined();
			expect(sanitized.nested.apiKey).toBeUndefined();
			expect(sanitized.nested.api_key).toBeUndefined();
			expect(sanitized.nested.binanceApiKey).toBeUndefined();
			expect(sanitized.nested.access_token).toBeUndefined();
			expect(sanitized.nested.private_key).toBeUndefined();
			expect(sanitized.nested.authorization).toBeUndefined();
			expect(sanitized.nested.webhookUrl).toBeUndefined();
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
				operator: hashOperator('operator-key-123'),
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

		it('resolves and hashes operator from req object in recordMutation without plain text leak', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			const apiKey = 'b'.repeat(64);
			const expectedHash = crypto.pbkdf2Sync(apiKey, 'cabros-bot:binance-order-audit', 10000, 32, 'sha256').toString('hex');

			const result = await service.recordMutation({
				req: {
					headers: { 'x-api-key': apiKey },
				},
				action: 'PLACE',
				symbol: 'SOLUSDT',
				status: 'SUBMITTED',
			});

			const writtenData = mockDocRef.set.mock.calls[0][0];
			expect(writtenData.operator).toBe(expectedHash);
			expect(writtenData.operator).not.toBe(apiKey);
			expect(result.operator).toBe(expectedHash);
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

		it('records a dry-run mutation document with dryRun: true and status: dry_run', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			const result = await service.recordMutation({
				action: 'PLACE',
				symbol: 'BTCUSDT',
				side: 'BUY',
				type: 'LIMIT',
				quantity: '0.005',
				price: '50000',
				dryRun: true,
				status: 'dry_run',
				environment: 'testnet',
			});

			expect(mockDb.collection).toHaveBeenCalledWith('binanceOrderAudit');
			expect(mockDocRef.set).toHaveBeenCalledTimes(1);
			const writtenData = mockDocRef.set.mock.calls[0][0];
			expect(writtenData).toMatchObject({
				action: 'PLACE',
				symbol: 'BTCUSDT',
				status: 'dry_run',
				dryRun: true,
				environment: 'testnet',
			});
			expect(writtenData.requestFingerprint).toBeDefined();
			expect(result.dryRun).toBe(true);
			expect(result.status).toBe('dry_run');
		});

		it('records an ambiguous mutation document with errorCode and status: ambiguous', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			const result = await service.recordMutation({
				action: 'PLACE',
				symbol: 'ETHUSDT',
				status: 'ambiguous',
				errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
				dryRun: false,
			});

			const writtenData = mockDocRef.set.mock.calls[0][0];
			expect(writtenData).toMatchObject({
				symbol: 'ETHUSDT',
				status: 'ambiguous',
				errorCode: 'BINANCE_ORDER_STATUS_UNKNOWN',
				dryRun: false,
			});
			expect(result.status).toBe('ambiguous');
			expect(result.errorCode).toBe('BINANCE_ORDER_STATUS_UNKNOWN');
		});

		it('records a rejected mutation document with errorCode and status: rejected', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			const result = await service.recordMutation({
				action: 'PLACE',
				symbol: 'SOLUSDT',
				status: 'rejected',
				errorCode: '-1013',
				dryRun: false,
			});

			const writtenData = mockDocRef.set.mock.calls[0][0];
			expect(writtenData).toMatchObject({
				symbol: 'SOLUSDT',
				status: 'rejected',
				errorCode: '-1013',
				dryRun: false,
			});
			expect(result.status).toBe('rejected');
			expect(result.errorCode).toBe('-1013');
		});

		it('hashes idempotency key from req or parameters into idempotencyKeyHash', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			const idempotencyValue = 'test-idempotency-header-val';
			const expectedHash = crypto.createHash('sha256').update(idempotencyValue).digest('hex');

			await service.recordMutation({
				req: {
					headers: { 'x-idempotency-key': idempotencyValue },
				},
				action: 'PLACE',
				symbol: 'BTCUSDT',
			});

			const writtenData = mockDocRef.set.mock.calls[0][0];
			expect(writtenData.idempotencyKeyHash).toBe(expectedHash);
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

	describe('listAuditRecords', () => {
		let mockDb;
		let mockCollection;
		let service;
		let queryChain;

		beforeEach(() => {
			queryChain = {
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				startAfter: jest.fn().mockReturnThis(),
				where: jest.fn().mockReturnThis(),
				get: jest.fn(),
			};
			mockCollection = {
				orderBy: queryChain.orderBy,
				limit: queryChain.limit,
				startAfter: queryChain.startAfter,
				where: queryChain.where,
				get: queryChain.get,
			};
			mockDb = {
				collection: jest.fn().mockReturnValue(mockCollection),
			};
			service = new BinanceOrderAuditService({ firestore: mockDb });
		});

		it('returns null when audit service is disabled', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'false';
			const result = await service.listAuditRecords({ limit: 10 });
			expect(result).toBeNull();
			expect(queryChain.get).not.toHaveBeenCalled();
		});

		it('throws STORAGE_UNAVAILABLE when firestore is unconfigured', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
			delete process.env.FIREBASE_PROJECT_ID;
			const unconfiguredService = new BinanceOrderAuditService({ firestore: null });
			jest.spyOn(unconfiguredService, 'isConfigured').mockReturnValue(false);
			jest.spyOn(unconfiguredService, '_getFirestore').mockReturnValue(null);

			await expect(unconfiguredService.listAuditRecords({ limit: 10 })).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});

		it('throws INVALID_REQUEST when before cursor is invalid', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			await expect(service.listAuditRecords({ before: 'malformed_cursor_value' })).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
			});
		});

		it('lists audit records with filtering by symbol, status, and time range', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			queryChain.get.mockResolvedValueOnce({
				empty: false,
				docs: [
					{
						id: 'event-1',
						data: () => ({
							orderId: 'event-1',
							symbol: 'BTCUSDT',
							status: 'dry_run',
							dryRun: true,
							environment: 'testnet',
							timestamp: '2026-09-10T12:00:00.000Z',
						}),
					},
					{
						id: 'event-2',
						data: () => ({
							orderId: 'event-2',
							symbol: 'ETHUSDT',
							status: 'confirmed',
							dryRun: false,
							environment: 'testnet',
							timestamp: '2026-09-10T11:00:00.000Z',
						}),
					},
					{
						id: 'event-3',
						data: () => ({
							orderId: 'event-3',
							symbol: 'BTCUSDT',
							status: 'rejected',
							errorCode: 'LOT_SIZE',
							dryRun: false,
							environment: 'testnet',
							timestamp: '2026-09-08T10:00:00.000Z',
						}),
					},
				],
			});

			const result = await service.listAuditRecords({
				symbol: 'BTCUSDT',
				status: 'dry_run',
				from: '2026-09-09T00:00:00.000Z',
				to: '2026-09-11T00:00:00.000Z',
				limit: 10,
			});

			expect(result).toBeDefined();
			expect(result.records).toHaveLength(1);
			expect(result.records[0]).toMatchObject({
				id: 'event-1',
				symbol: 'BTCUSDT',
				status: 'dry_run',
				dryRun: true,
			});
			expect(result.hasMore).toBe(false);
			expect(result.nextBefore).toBeDefined();
		});

		it('matches status flexibly (confirmed matches FILLED, rejected matches failed)', async () => {
			process.env.ENABLE_BINANCE_ORDER_AUDIT = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'test' });

			queryChain.get.mockResolvedValueOnce({
				empty: false,
				docs: [
					{
						id: 'event-1',
						data: () => ({
							orderId: 'event-1',
							symbol: 'BTCUSDT',
							status: 'FILLED',
							timestamp: '2026-09-10T12:00:00.000Z',
						}),
					},
				],
			});

			const result = await service.listAuditRecords({
				status: 'confirmed',
				limit: 10,
			});

			expect(result.records).toHaveLength(1);
			expect(result.records[0].status).toBe('FILLED');
		});
	});
});
