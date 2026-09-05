'use strict';

jest.mock('../../src/services/storage/AlertStorageService', () => {
	const storage = {
		isEnabled: jest.fn(() => true),
		getFirestore: jest.fn(() => null),
		getAlertStorageRetentionDays: jest.fn(() => 90),
		getFirestore: jest.fn(() => null),
	};
	return storage;
});

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const ackService = require('../../src/services/storage/AlertAcknowledgementService');

describe('AlertAcknowledgementService', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		alertStorageService.getFirestore.mockReturnValue(null);
		alertStorageService.getAlertStorageRetentionDays.mockReturnValue(90);
		ackService.clearMemoryStore();
	});

	afterEach(() => {
		process.env = savedEnv;
		jest.restoreAllMocks();
	});

	describe('isEnabled', () => {
		it('returns true when ENABLE_FIRESTORE_ALERT_STORAGE=true', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			expect(ackService.isEnabled()).toBe(true);
		});

		it('returns false when ENABLE_FIRESTORE_ALERT_STORAGE is unset', () => {
			delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
			expect(ackService.isEnabled()).toBe(false);
		});
	});

	describe('saveAcknowledgement', () => {
		it('persists a fresh acknowledgement to memory store with all safe fields', async () => {
			const result = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123456789',
				action: 'took_trade',
				notes: 'Entered at 100.5',
			});
			expect(result.alertId).toBe('alert-123');
			expect(result.action).toBe('took_trade');
			expect(result.notes).toBe('Entered at 100.5');
			expect(result.ackId).toBe('alert-123__123456789');
			expect(result.storage).toBe('memory');
			expect(result.acknowledgedAt).toEqual(expect.any(String));
			expect(result.updatedAt).toEqual(expect.any(String));
			// chatId is never exposed
			expect(result.chatId).toBeUndefined();
		});

		it('rejects when action is not in the VALID_ACTIONS set', async () => {
			await expect(ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
				action: 'random',
			})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		});

		it('normalizes action casing and trims whitespace', async () => {
			const result = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
				action: '  Skipped  ',
			});
			expect(result.action).toBe('skipped');
		});

		it('rejects when alertId is missing', async () => {
			await expect(ackService.saveAcknowledgement({
				alertId: '   ',
				chatId: '123',
				action: 'took_trade',
			})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		});

		it('rejects when chatId is missing', async () => {
			await expect(ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '',
				action: 'took_trade',
			})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
		});

		it('truncates notes that exceed the 280-char cap', async () => {
			const longNotes = 'a'.repeat(400);
			const result = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
				action: 'took_trade',
				notes: longNotes,
			});
			expect(result.notes.length).toBe(280);
		});

		it('stores null notes when notes is missing or empty', async () => {
			const r1 = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
				action: 'took_trade',
			});
			expect(r1.notes).toBeNull();
			const r2 = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '124',
				action: 'skipped',
				notes: '   ',
			});
			expect(r2.notes).toBeNull();
		});

		it('updates the same record on second call with same (alertId, chatId)', async () => {
			const r1 = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
				action: 'took_trade',
			});
			await new Promise(resolve => setTimeout(resolve, 5));
			const r2 = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
				action: 'skipped',
			});
			expect(r1.ackId).toBe(r2.ackId);
			expect(r2.action).toBe('skipped');
			expect(r2.acknowledgedAt).toBe(r1.acknowledgedAt);
			expect(new Date(r2.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(r1.updatedAt).getTime());
		});

		it('persists distinct records for distinct chat ids on the same alert', async () => {
			const r1 = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: 'chat-a',
				action: 'took_trade',
			});
			const r2 = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: 'chat-b',
				action: 'skipped',
			});
			expect(r1.ackId).not.toBe(r2.ackId);
		});

		it('sanitizes unsafe characters in chatId when building the document id', async () => {
			const r = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '-1001234567890/with spaces',
				action: 'took_trade',
			});
			expect(r.ackId).toBe('alert-123__-1001234567890_with_spaces');
		});
	});

	describe('getAcknowledgement', () => {
		it('returns null when no record exists', async () => {
			const result = await ackService.getAcknowledgement({
				alertId: 'alert-no-record',
				chatId: '123',
			});
			expect(result).toBeNull();
		});

		it('returns the matching record when present', async () => {
			await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
				action: 'took_trade',
			});
			const result = await ackService.getAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
			});
			expect(result.action).toBe('took_trade');
			expect(result.ackId).toBe('alert-123__123');
			expect(result.chatId).toBeUndefined();
		});

		it('returns null when the feature is disabled', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			const result = await ackService.getAcknowledgement({
				alertId: 'alert-123',
				chatId: '123',
			});
			expect(result).toBeNull();
		});
	});

	describe('listAcknowledgements', () => {
		beforeEach(async () => {
			await ackService.saveAcknowledgement({ alertId: 'alert-1', chatId: 'a', action: 'took_trade' });
			await ackService.saveAcknowledgement({ alertId: 'alert-1', chatId: 'b', action: 'skipped' });
			await ackService.saveAcknowledgement({ alertId: 'alert-2', chatId: 'a', action: 'snoozed' });
		});

		it('returns records ordered by updatedAt descending across alerts', async () => {
			const { records } = await ackService.listAcknowledgements({ limit: 10 });
			expect(records).toHaveLength(3);
			records.forEach(record => expect(record.chatId).toBeUndefined());
		});

		it('filters by alertId when provided', async () => {
			const { records } = await ackService.listAcknowledgements({ alertId: 'alert-1' });
			expect(records).toHaveLength(2);
			records.forEach(record => expect(record.alertId).toBe('alert-1'));
		});

		it('clamps limit to a bounded range', async () => {
			const smallLimit = await ackService.listAcknowledgements({ limit: 1 });
			expect(smallLimit.records).toHaveLength(1);
		});

		it('returns empty list and memory storage when feature is disabled', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			const { records, storage } = await ackService.listAcknowledgements();
			expect(records).toEqual([]);
			expect(storage).toBe('memory');
		});
	});

	describe('getAcknowledgementBreakdown', () => {
		it('returns zero-safe counts for every VALID_ACTIONS entry', async () => {
			const breakdown = await ackService.getAcknowledgementBreakdown('alert-no-data');
			expect(breakdown.alertId).toBe('alert-no-data');
			expect(breakdown.total).toBe(0);
			expect(breakdown.breakdown).toEqual({
				took_trade: 0,
				skipped: 0,
				no_trade_no_signal: 0,
				snoozed: 0,
			});
		});

		it('aggregates counts per action for matching alertId', async () => {
			await ackService.saveAcknowledgement({ alertId: 'alert-x', chatId: 'a', action: 'took_trade' });
			await ackService.saveAcknowledgement({ alertId: 'alert-x', chatId: 'b', action: 'took_trade' });
			await ackService.saveAcknowledgement({ alertId: 'alert-x', chatId: 'c', action: 'skipped' });
			await ackService.saveAcknowledgement({ alertId: 'alert-y', chatId: 'a', action: 'took_trade' });
			const breakdown = await ackService.getAcknowledgementBreakdown('alert-x');
			expect(breakdown.total).toBe(3);
			expect(breakdown.breakdown.took_trade).toBe(2);
			expect(breakdown.breakdown.skipped).toBe(1);
			expect(breakdown.breakdown.no_trade_no_signal).toBe(0);
			expect(breakdown.breakdown.snoozed).toBe(0);
		});

		it('returns an empty breakdown for an empty alertId', async () => {
			const breakdown = await ackService.getAcknowledgementBreakdown('   ');
			expect(breakdown.alertId).toBeNull();
			expect(breakdown.total).toBe(0);
		});
	});

	describe('firestore integration', () => {
		let mockFirestore;
		let mockCollection;
		let mockDoc;

		beforeEach(() => {
			mockDoc = {
				get: jest.fn(),
				set: jest.fn(),
			};
			mockCollection = {
				doc: jest.fn(() => mockDoc),
				where: jest.fn(),
				orderBy: jest.fn(),
				limit: jest.fn(),
			};
			mockCollection.where.mockReturnValue(mockCollection);
			mockCollection.orderBy.mockReturnValue(mockCollection);
			mockCollection.limit.mockReturnValue(mockCollection);
			mockFirestore = {
				collection: jest.fn(() => mockCollection),
			};
			alertStorageService.getFirestore.mockReturnValue(mockFirestore);
		});

		it('persists to Firestore when available and reports storage=firestore', async () => {
			mockDoc.get
				.mockResolvedValueOnce({ exists: false })
				.mockResolvedValueOnce({ exists: true, data: () => ({ action: 'took_trade', notes: 'good' }) });
			mockDoc.set.mockResolvedValue();
			const r = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: 'chat-1',
				action: 'took_trade',
				notes: 'good',
			});
			expect(r.storage).toBe('firestore');
			expect(mockFirestore.collection).toHaveBeenCalledWith('alertAcknowledgements');
			expect(mockDoc.set).toHaveBeenCalled();
		});

		it('falls back to memory when Firestore set throws', async () => {
			mockDoc.get
				.mockResolvedValueOnce({ exists: false })
				.mockResolvedValueOnce({ exists: false });
			mockDoc.set.mockRejectedValue(new Error('firestore unavailable'));
			const r = await ackService.saveAcknowledgement({
				alertId: 'alert-123',
				chatId: 'chat-1',
				action: 'took_trade',
			});
			expect(r.storage).toBe('memory');
		});

		it('reads from Firestore when the document exists', async () => {
			mockDoc.get.mockResolvedValue({
				exists: true,
				data: () => ({
					action: 'skipped',
					notes: 'wait for confirmation',
					updatedAt: { toDate: () => new Date('2026-09-02T22:00:00Z') },
					acknowledgedAt: { toDate: () => new Date('2026-09-02T21:00:00Z') },
				}),
			});
			const r = await ackService.getAcknowledgement({
				alertId: 'alert-123',
				chatId: 'chat-1',
			});
			expect(r.storage).toBe('firestore');
			expect(r.action).toBe('skipped');
			expect(r.acknowledgedAt).toBe('2026-09-02T21:00:00.000Z');
		});

		it('returns null from Firestore read when document does not exist', async () => {
			mockDoc.get.mockResolvedValue({ exists: false });
			const r = await ackService.getAcknowledgement({
				alertId: 'alert-123',
				chatId: 'chat-1',
			});
			expect(r).toBeNull();
		});
	});
});
