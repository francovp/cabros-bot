'use strict';

/**
 * Unit tests for the opt-in per-alert decision audit trail
 * (ENABLE_ALERT_DECISION_AUDIT, GH-763).
 *
 * Covers sanitization, schema exposure on /api/alerts/:alertId,
 * includeDecision on export, includeDecisionRollup on summary,
 * and webhook handler capture (buildDecisionAudit).
 */

const admin = require('firebase-admin');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');

const {
	__mockAdd: mockAdd,
	__mockCollection: mockCollection,
	__mockDocGet: mockDocGet,
	__mockOrderBy: mockOrderBy,
	__mockLimit: mockLimit,
	__mockWhere: mockWhere,
	__mockGet: mockGet,
} = admin;

function buildTimestamp(isoString) {
	return { toDate: () => new Date(isoString) };
}

function buildQueryDoc(id, data) {
	return { id, data: () => data };
}

function buildDocSnapshot(id, data) {
	return {
		exists: Boolean(data),
		id,
		data: () => data,
	};
}

describe('AlertStorageService decision audit', () => {
	let originalFlag;

	beforeEach(() => {
		jest.clearAllMocks();
		admin.__resetApps();
		AlertStorageService._resetForTesting();
		originalFlag = process.env.ENABLE_ALERT_DECISION_AUDIT;
		delete process.env.ENABLE_ALERT_DECISION_AUDIT;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
	});

	afterEach(() => {
		jest.useRealTimers();
		if (originalFlag === undefined) {
			delete process.env.ENABLE_ALERT_DECISION_AUDIT;
		} else {
			process.env.ENABLE_ALERT_DECISION_AUDIT = originalFlag;
		}
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
	});

	describe('isDecisionAuditEnabled()', () => {
		it('returns false when env var is unset', () => {
			expect(AlertStorageService.isDecisionAuditEnabled()).toBe(false);
		});

		it('returns false when env var is "false"', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'false';
			expect(AlertStorageService.isDecisionAuditEnabled()).toBe(false);
		});

		it('returns true only when env var is "true"', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			expect(AlertStorageService.isDecisionAuditEnabled()).toBe(true);
		});
	});

	describe('sanitizeDecisionAudit()', () => {
		it('returns null when feature is disabled', () => {
			expect(AlertStorageService.sanitizeDecisionAudit({ parsed: { ok: true } })).toBeNull();
		});

		it('returns null for non-object input even when feature is enabled', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			expect(AlertStorageService.sanitizeDecisionAudit(null)).toBeNull();
			expect(AlertStorageService.sanitizeDecisionAudit(undefined)).toBeNull();
			expect(AlertStorageService.sanitizeDecisionAudit('string')).toBeNull();
		});

		it('drops undefined leaves and preserves string/number/boolean/object/array', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const result = AlertStorageService.sanitizeDecisionAudit({
				parsed: { ok: true, symbol: 'BTCUSDT', side: undefined, raw: null },
				enrichment: { status: 'success', sources: 3, fallback: false, dropped: undefined },
				gates: [{ name: 'dryRun', decision: 'skip', reason: 'probe' }],
				depth: 1,
			});
			expect(result.parsed.ok).toBe(true);
			expect(result.parsed.symbol).toBe('BTCUSDT');
			expect('side' in result.parsed).toBe(false);
			expect('raw' in result.parsed).toBe(false);
			expect(result.enrichment.status).toBe('success');
			expect(result.enrichment.sources).toBe(3);
			expect(result.enrichment.fallback).toBe(false);
			expect(result.gates[0].name).toBe('dryRun');
			expect(result.gates[0].decision).toBe('skip');
			expect(result.depth).toBe(1);
		});

		it('truncates string leaves over 1000 chars', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const huge = 'a'.repeat(2000);
			const result = AlertStorageService.sanitizeDecisionAudit({
				parsed: { ok: true, symbol: huge },
			});
			expect(result.parsed.symbol.length).toBe(1000);
		});

		it('caps each plain object at 32 keys', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const oversized = {};
			for (let i = 0; i < 100; i += 1) {
				oversized[`k${i}`] = i;
			}
			const result = AlertStorageService.sanitizeDecisionAudit({ parsed: oversized });
			expect(Object.keys(result.parsed).length).toBeLessThanOrEqual(32);
		});

		it('strips class instances (Date, etc.) without crashing', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const result = AlertStorageService.sanitizeDecisionAudit({
				parsed: { ok: true, ts: new Date('2026-09-01T00:00:00Z') },
			});
			expect(result.parsed.ok).toBe(true);
			expect('ts' in result.parsed).toBe(false);
		});
	});

	describe('sanitizeDecisionGates()', () => {
		it('returns empty array for non-array input', () => {
			expect(AlertStorageService.sanitizeDecisionGates(null)).toEqual([]);
			expect(AlertStorageService.sanitizeDecisionGates(undefined)).toEqual([]);
			expect(AlertStorageService.sanitizeDecisionGates('not-array')).toEqual([]);
		});

		it('keeps valid gates and drops invalid ones', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const out = AlertStorageService.sanitizeDecisionGates([
				{ name: 'dryRun', decision: 'skip' },
				{ name: 'same-signal-cooldown', decision: 'suppress', reason: 'active' },
				{ name: 'noop', decision: 'unknown-decision' },
				{ name: '', decision: 'allow' },
				null,
				'string',
			]);
			expect(out).toHaveLength(2);
			expect(out[0]).toEqual({ name: 'dryRun', decision: 'skip' });
			expect(out[1].reason).toBe('active');
		});

		it('sanitizes evidence to scalars only (string/number/boolean)', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const out = AlertStorageService.sanitizeDecisionGates([
				{
					name: 'same-signal-cooldown',
					decision: 'suppress',
					evidence: {
						key: 'BINANCE:BTCUSDT-1h-BUY',
						ageMs: 120000,
						active: true,
						skipped: undefined,
						nested: { not: 'allowed' },
					},
				},
			]);
			expect(out[0].evidence.key).toBe('BINANCE:BTCUSDT-1h-BUY');
			expect(out[0].evidence.ageMs).toBe(120000);
			expect(out[0].evidence.active).toBe(true);
			expect('skipped' in out[0].evidence).toBe(false);
			expect('nested' in out[0].evidence).toBe(false);
		});

		it('truncates gate.reason to 1000 chars', () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const longReason = 'x'.repeat(2000);
			const out = AlertStorageService.sanitizeDecisionGates([
				{ name: 'dryRun', decision: 'skip', reason: longReason },
			]);
			expect(out[0].reason.length).toBe(1000);
		});
	});

	describe('formatAlertDocument() decision exposure', () => {
		beforeEach(() => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		});

		it('omits decision when feature is disabled', async () => {
			const alertId = 'alert-1';
			mockDocGet.mockResolvedValueOnce(buildDocSnapshot(alertId, {
				receivedAt: buildTimestamp('2026-09-01T00:00:00Z'),
				text: 'BINANCE:BTCUSDT COMPRA 1h',
				enriched: true,
				decision: { parsed: { ok: true } },
			}));
			const alert = await AlertStorageService.getAlertById(alertId);
			expect(alert.decision).toBeUndefined();
		});

		it('exposes decision when feature is enabled and present', async () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const alertId = 'alert-2';
			mockDocGet.mockResolvedValueOnce(buildDocSnapshot(alertId, {
				receivedAt: buildTimestamp('2026-09-01T00:00:00Z'),
				text: 'BINANCE:BTCUSDT COMPRA 1h',
				enriched: true,
				decision: {
					parsed: { ok: true, symbol: 'BTCUSDT' },
					gates: [{ name: 'dryRun', decision: 'skip' }],
				},
			}));
			const alert = await AlertStorageService.getAlertById(alertId);
			expect(alert.decision).toBeDefined();
			expect(alert.decision.parsed.symbol).toBe('BTCUSDT');
		});
	});

	describe('saveAlert() decision persistence', () => {
		beforeEach(() => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		});

		it('omits decision from the document when feature is disabled', async () => {
			const setCalls = [];
			mockAdd.mockImplementation(async (doc) => {
				setCalls.push(doc);
				return { id: 'new-id' };
			});
			await AlertStorageService.saveAlert({
				text: 'BINANCE:BTCUSDT COMPRA 1h',
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				channels: ['telegram'],
				deliveryResults: [],
				useTradingViewData: false,
				processingTimeMs: 100,
				source: 'webhook-alert',
				decision: { parsed: { ok: true }, gates: [{ name: 'dryRun', decision: 'skip' }] },
			});
			expect(setCalls).toHaveLength(1);
			expect('decision' in setCalls[0]).toBe(false);
		});

		it('persists a sanitized decision when feature is enabled', async () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const setCalls = [];
			mockAdd.mockImplementation(async (doc) => {
				setCalls.push(doc);
				return { id: 'new-id' };
			});
			await AlertStorageService.saveAlert({
				text: 'BINANCE:BTCUSDT COMPRA 1h',
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				channels: ['telegram'],
				deliveryResults: [],
				useTradingViewData: false,
				processingTimeMs: 100,
				source: 'webhook-alert',
				decision: {
					parsed: { ok: true, symbol: 'BTCUSDT' },
					gates: [{ name: 'same-signal-cooldown', decision: 'suppress' }],
					dispatch: { requestedChannels: ['telegram'], sentTo: [] },
				},
			});
			expect(setCalls).toHaveLength(1);
			expect(setCalls[0].decision).toBeDefined();
			expect(setCalls[0].decision.parsed.symbol).toBe('BTCUSDT');
			expect(setCalls[0].decision.gates[0].name).toBe('same-signal-cooldown');
		});

		it('persists dry-run gate with sentTo: []', async () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			const setCalls = [];
			mockAdd.mockImplementation(async (doc) => {
				setCalls.push(doc);
				return { id: 'new-id' };
			});
			await AlertStorageService.saveAlert({
				text: 'BINANCE:BTCUSDT COMPRA 1h',
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				channels: ['telegram'],
				deliveryResults: [],
				useTradingViewData: false,
				processingTimeMs: 50,
				source: 'webhook-alert',
				decision: {
					parsed: { ok: true },
					gates: [{ name: 'dryRun', decision: 'skip' }],
					dispatch: { requestedChannels: ['telegram'], sentTo: [] },
				},
			});
			expect(setCalls[0].decision.gates).toEqual([
				{ name: 'dryRun', decision: 'skip' },
			]);
			expect(setCalls[0].decision.dispatch.sentTo).toEqual([]);
		});
	});

	describe('exportAlerts() includeDecision', () => {
		beforeEach(() => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
		});

		it('includes decision when includeDecision=true', async () => {
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('a-1', {
						receivedAt: buildTimestamp('2026-09-01T00:00:00Z'),
						text: 'BINANCE:BTCUSDT COMPRA 1h',
						enriched: false,
						deliveryResults: [],
						source: 'webhook-alert',
						decision: { parsed: { ok: true } },
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-08-31T00:00:00Z',
				to: '2026-09-02T00:00:00Z',
				limit: 100,
				includeDecision: true,
			});
			expect(result.alerts[0].decision).toEqual({ parsed: { ok: true } });
		});

		it('omits decision when includeDecision=false', async () => {
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('a-1', {
						receivedAt: buildTimestamp('2026-09-01T00:00:00Z'),
						text: 'BINANCE:BTCUSDT COMPRA 1h',
						enriched: false,
						deliveryResults: [],
						source: 'webhook-alert',
						decision: { parsed: { ok: true } },
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-08-31T00:00:00Z',
				to: '2026-09-02T00:00:00Z',
				limit: 100,
				includeDecision: false,
			});
			expect('decision' in result.alerts[0]).toBe(false);
		});
	});

	describe('summarizeAlerts() decision.gates rollup', () => {
		beforeEach(() => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		});

		it('omits decision section when includeDecisionRollup=false', async () => {
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('a-1', {
						receivedAt: buildTimestamp('2026-09-01T00:00:00Z'),
						text: 'BINANCE:BTCUSDT COMPRA 1h',
						enriched: false,
						deliveryResults: [],
						source: 'webhook-alert',
						decision: { gates: [{ name: 'dryRun', decision: 'skip' }] },
					}),
				],
			});

			const summary = await AlertStorageService.summarizeAlerts({
				from: '2026-08-31T00:00:00Z',
				to: '2026-09-02T00:00:00Z',
				limit: 100,
			});
			expect(summary.decision).toBeUndefined();
		});

		it('produces decision.gates[] rollup when includeDecisionRollup=true and feature enabled', async () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('a-1', {
						receivedAt: buildTimestamp('2026-09-01T00:00:00Z'),
						text: 'BINANCE:BTCUSDT COMPRA 1h',
						enriched: false,
						deliveryResults: [],
						source: 'webhook-alert',
						decision: { gates: [{ name: 'dryRun', decision: 'skip' }, { name: 'same-signal-cooldown', decision: 'suppress' }] },
					}),
					buildQueryDoc('a-2', {
						receivedAt: buildTimestamp('2026-09-01T01:00:00Z'),
						text: 'BINANCE:ETHUSDT VENTA 4h',
						enriched: false,
						deliveryResults: [],
						source: 'webhook-alert',
						decision: { gates: [{ name: 'dryRun', decision: 'skip' }] },
					}),
				],
			});

			const summary = await AlertStorageService.summarizeAlerts({
				from: '2026-08-31T00:00:00Z',
				to: '2026-09-02T00:00:00Z',
				limit: 100,
				includeDecisionRollup: true,
			});
			expect(summary.decision).toBeDefined();
			expect(summary.decision.gates.denominator).toBe(2);
			expect(summary.decision.gates.gates).toHaveLength(2);
			const dryRun = summary.decision.gates.gates.find((g) => g.name === 'dryRun');
			expect(dryRun.populated).toBe(2);
			expect(dryRun.percentage).toBe(1);
			const suppress = summary.decision.gates.gates.find((g) => g.name === 'same-signal-cooldown');
			expect(suppress.populated).toBe(1);
			expect(suppress.percentage).toBe(0.5);
		});

		it('rollup denominator counts scanned alerts and gates empty when no decision records', async () => {
			process.env.ENABLE_ALERT_DECISION_AUDIT = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('a-1', {
						receivedAt: buildTimestamp('2026-09-01T00:00:00Z'),
						text: 'BINANCE:BTCUSDT COMPRA 1h',
						enriched: false,
						deliveryResults: [],
						source: 'webhook-alert',
					}),
				],
			});

			const summary = await AlertStorageService.summarizeAlerts({
				from: '2026-08-31T00:00:00Z',
				to: '2026-09-02T00:00:00Z',
				limit: 100,
				includeDecisionRollup: true,
			});
			expect(summary.decision.gates.denominator).toBe(1);
			expect(summary.decision.gates.gates).toEqual([]);
		});
	});
});
