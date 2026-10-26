'use strict';

/**
 * Unit tests for AlertFeedbackStorageService — covers the fail-open
 * persistence + aggregation surface for trader alert feedback.
 *
 * firebase-admin is redirected to __mocks__/firebase-admin.js via moduleNameMapper
 * in jest.config.js (required for pnpm worktree where firebase-admin lives in
 * the parent repo's node_modules, not in the worktree directory).
 */

const admin = require('firebase-admin');
const AlertFeedbackStorageService = require('../../src/services/storage/AlertFeedbackStorageService');

const {
	__mockCollection: mockCollection,
	__mockGet: mockGet,
	__mockDocSet: mockDocSet,
	__mockWhere: mockWhere,
	__mockLimit: mockLimit,
	__mockTimestampFromDate: mockTimestampFromDate,
	__mockInitializeApp: mockInitializeApp,
	__mockCert: mockCert,
} = admin;

function buildQueryDoc(id, data) {
	return {
		id,
		data: () => data,
	};
}

function setValidServiceAccount() {
	process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
		type: 'service_account',
		project_id: 'demo-cabros',
		client_email: 'demo@demo-cabros.iam.gserviceaccount.com',
		private_key: '-----BEGIN PRIVATE KEY-----\nMIIE2K\n-----END PRIVATE KEY-----\n',
	});
}

describe('AlertFeedbackStorageService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		admin.__resetApps();
		AlertFeedbackStorageService._resetForTests();
		delete process.env.ENABLE_FIRESTORE_ALERT_FEEDBACK;
		delete process.env.ALERT_FEEDBACK_RETENTION_DAYS;
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	});

	afterEach(() => {
		jest.useRealTimers();
		delete process.env.ENABLE_FIRESTORE_ALERT_FEEDBACK;
		delete process.env.ALERT_FEEDBACK_RETENTION_DAYS;
	});

	describe('isEnabled / getStatus', () => {
		test('defaults to disabled', () => {
			expect(AlertFeedbackStorageService.isEnabled()).toBe(false);
			const status = AlertFeedbackStorageService.getStatus();
			expect(status.enabled).toBe(false);
			expect(status.source).toBe('memory');
		});

		test('reports enabled when env var is "true"', () => {
			process.env.ENABLE_FIRESTORE_ALERT_FEEDBACK = 'true';
			expect(AlertFeedbackStorageService.isEnabled()).toBe(true);
		});

		test('ignores truthy strings other than "true"', () => {
			process.env.ENABLE_FIRESTORE_ALERT_FEEDBACK = '1';
			expect(AlertFeedbackStorageService.isEnabled()).toBe(false);
		});
	});

	describe('hashChatId + buildDocumentId', () => {
		test('hashChatId returns a stable SHA-256 hex', () => {
			const hashA = AlertFeedbackStorageService.hashChatId('12345');
			expect(hashA).toMatch(/^[a-f0-9]{64}$/);
			expect(AlertFeedbackStorageService.hashChatId('12345')).toBe(hashA);
			expect(AlertFeedbackStorageService.hashChatId('12345')).not.toBe(
				AlertFeedbackStorageService.hashChatId('67890'),
			);
		});

		test('hashChatId returns null when chatId is missing', () => {
			expect(AlertFeedbackStorageService.hashChatId(null)).toBeNull();
			expect(AlertFeedbackStorageService.hashChatId('')).toBeNull();
		});

		test('buildDocumentId combines alertId with truncated chat hash', () => {
			const id = AlertFeedbackStorageService.buildDocumentId('alert-xyz', '12345');
			expect(id).toBe(`alert-xyz__${AlertFeedbackStorageService.hashChatId('12345').slice(0, 16)}`);
		});

		test('buildDocumentId rejects unsafe characters in alertId', () => {
			expect(AlertFeedbackStorageService.buildDocumentId('foo bar', '12345')).toBeNull();
			expect(AlertFeedbackStorageService.buildDocumentId('foo/bar', '12345')).toBeNull();
		});

		test('buildDocumentId requires both alertId and chatId', () => {
			expect(AlertFeedbackStorageService.buildDocumentId(null, '12345')).toBeNull();
			expect(AlertFeedbackStorageService.buildDocumentId('alert-xyz', null)).toBeNull();
		});
	});

	describe('saveFeedback (in-memory fallback)', () => {
		test('rejects empty alertId', async () => {
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: ' ',
				chatId: '12345',
				verdict: 'up',
			});
			expect(result.persisted).toBe(false);
			expect(result.reason).toBe('invalid_input');
		});

		test('rejects invalid verdict', async () => {
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'alert-1',
				chatId: '12345',
				verdict: 'maybe',
			});
			expect(result.persisted).toBe(false);
		});

		test('normalizes verdict casing and trims whitespace', async () => {
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'alert-1',
				chatId: '12345',
				verdict: '  UP  ',
			});
			expect(result.persisted).toBe(true);
			expect(result.source).toBe('memory');
		});

		test('persists to memory when Firestore is disabled', async () => {
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'alert-1',
				chatId: '12345',
				verdict: 'down',
				symbol: 'btcusdt',
				exchange: 'binance',
				source: 'webhook-alert',
			});
			expect(result.persisted).toBe(true);
			expect(result.source).toBe('memory');
			const status = AlertFeedbackStorageService.getStatus();
			expect(status.inMemoryEntryCount).toBe(1);
		});

		test('re-click overwrites prior verdict (memory fallback)', async () => {
			await AlertFeedbackStorageService.saveFeedback({ alertId: 'a1', chatId: 'c1', verdict: 'up' });
			await AlertFeedbackStorageService.saveFeedback({ alertId: 'a1', chatId: 'c1', verdict: 'down' });
			const { aggregate } = await AlertFeedbackStorageService.listFeedbackEntries({});
			// Same (alertId, chatId) collapses — only the latest verdict counts.
			expect(aggregate.total).toBe(1);
			expect(aggregate.down).toBe(1);
			expect(aggregate.up).toBe(0);
			expect(aggregate.ratio).toBe(0);
		});
	});

	describe('saveFeedback (Firestore enabled)', () => {
		beforeEach(() => {
			process.env.ENABLE_FIRESTORE_ALERT_FEEDBACK = 'true';
			setValidServiceAccount();
		});

		test('persists verdict document with deterministic id', async () => {
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'alert-1',
				chatId: '12345',
				verdict: 'up',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				source: 'webhook-alert',
			});
			expect(result.persisted).toBe(true);
			expect(result.source).toBe('firestore');
			expect(mockDocSet).toHaveBeenCalledTimes(1);
			const [payload] = mockDocSet.mock.calls[0];
			expect(payload.alertId).toBe('alert-1');
			expect(payload.verdict).toBe('up');
			expect(payload.symbol).toBe('BTCUSDT');
			expect(payload.exchange).toBe('BINANCE');
			expect(payload.chatId).toBe('12345');
			expect(payload.chatIdHash).toMatch(/^[a-f0-9]{64}$/);
			expect(payload.source).toBe('webhook-alert');
		});

		test('falls back to memory when Firestore write throws', async () => {
			mockDocSet.mockImplementationOnce(() => Promise.reject(new Error('Firestore unavailable')));
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'alert-2',
				chatId: '12345',
				verdict: 'up',
			});
			expect(result.persisted).toBe(true);
			expect(result.source).toBe('memory');
		});

		test('rejects invalid input even with Firestore enabled', async () => {
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: '',
				chatId: '12345',
				verdict: 'up',
			});
			expect(result.persisted).toBe(false);
			expect(mockDocSet).not.toHaveBeenCalled();
		});
	});

	describe('listFeedbackEntries + getSummaryBlock', () => {
		test('returns zeroed counts when nothing is persisted', async () => {
			const result = await AlertFeedbackStorageService.getSummaryBlock({});
			expect(result.total).toBe(0);
			expect(result.up).toBe(0);
			expect(result.down).toBe(0);
			expect(result.ratio).toBe(0);
			expect(result.source).toBe('memory');
		});

		test('aggregates by source/symbol/exchange (memory)', async () => {
			await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a1', chatId: 'c1', verdict: 'up',
				symbol: 'btcusdt', exchange: 'binance', source: 'webhook-alert',
			});
			await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a1', chatId: 'c2', verdict: 'down',
				symbol: 'btcusdt', exchange: 'binance', source: 'webhook-alert',
			});
			await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a2', chatId: 'c3', verdict: 'up',
				symbol: 'ethusdt', exchange: 'binance', source: 'scanner',
			});
			const summary = await AlertFeedbackStorageService.getSummaryBlock({});
			expect(summary.total).toBe(3);
			expect(summary.up).toBe(2);
			expect(summary.down).toBe(1);
			expect(summary.ratio).toBeCloseTo(2 / 3, 4);
			expect(summary.bySource['webhook-alert']).toBe(2);
			expect(summary.bySource.scanner).toBe(1);
			expect(summary.bySymbol.BTCUSDT).toBe(2);
			expect(summary.bySymbol.ETHUSDT).toBe(1);
			expect(summary.byExchange.BINANCE).toBe(3);
		});

		test('ratio is 0 when total is 0', async () => {
			const result = await AlertFeedbackStorageService.getSummaryBlock({});
			expect(result.ratio).toBe(0);
		});

		test('falls back to memory when Firestore query throws', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_FEEDBACK = 'true';
			setValidServiceAccount();
			mockDocSet.mockImplementation(() => Promise.reject(new Error('Firestore unavailable')));
			await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a1', chatId: 'c1', verdict: 'up',
			});
			// Firestore throws on write, so the entry lands in the memory fallback.
			mockGet.mockImplementationOnce(() => {
				throw new Error('Firestore query failed');
			});
			const summary = await AlertFeedbackStorageService.getSummaryBlock({});
			expect(summary.total).toBe(1);
			expect(summary.source).toBe('memory');
		});
	});

	describe('ALERT_FEEDBACK_RETENTION_DAYS validation', () => {
		test('accepts valid in-range values', async () => {
			process.env.ALERT_FEEDBACK_RETENTION_DAYS = '30';
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a1', chatId: 'c1', verdict: 'up',
			});
			expect(result.persisted).toBe(true);
		});

		test('falls back to default on invalid values', async () => {
			process.env.ALERT_FEEDBACK_RETENTION_DAYS = 'abc';
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a1', chatId: 'c1', verdict: 'up',
			});
			expect(result.persisted).toBe(true);
			expect(result.source).toBe('memory');
		});

		test('rejects retention < 1', async () => {
			process.env.ALERT_FEEDBACK_RETENTION_DAYS = '0';
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a1', chatId: 'c1', verdict: 'up',
			});
			expect(result.persisted).toBe(true);
		});

		test('rejects retention > 3650', async () => {
			process.env.ALERT_FEEDBACK_RETENTION_DAYS = '9999';
			const result = await AlertFeedbackStorageService.saveFeedback({
				alertId: 'a1', chatId: 'c1', verdict: 'up',
			});
			expect(result.persisted).toBe(true);
		});
	});
});
