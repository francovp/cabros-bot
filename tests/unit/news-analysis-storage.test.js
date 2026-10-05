'use strict';

const { generateKeyPairSync } = require('crypto');
const admin = require('firebase-admin');
const NewsAnalysisStorageService = require('../../src/services/storage/NewsAnalysisStorageService');

const {
	__mockCollection: mockCollection,
	__mockDocSet: mockDocSet,
	__mockDocGet: mockDocGet,
	__mockGet: mockGet,
	__mockWhere: mockWhere,
	__mockOrderBy: mockOrderBy,
	__mockLimit: mockLimit,
	__resetCollectionState: resetCollectionState,
} = admin;

describe('NewsAnalysisStorageService', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		resetCollectionState();
		admin.__resetApps();
		NewsAnalysisStorageService.__resetFirestoreClient();
		NewsAnalysisStorageService.__resetReadinessForTesting();
		process.env = { ...originalEnv };
		process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'true';
	});

	afterAll(() => {
		process.env = originalEnv;
	});

	describe('configuration & gating', () => {
		it('reports isEnabled() === true when ENABLE_FIRESTORE_NEWS_ANALYSIS=true', () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'true';
			expect(NewsAnalysisStorageService.isEnabled()).toBe(true);
		});

		it('reports isEnabled() === false when ENABLE_FIRESTORE_NEWS_ANALYSIS is false or unset', () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';
			expect(NewsAnalysisStorageService.isEnabled()).toBe(false);
			delete process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS;
			expect(NewsAnalysisStorageService.isEnabled()).toBe(false);
		});

		it('uses default retention days 30 when unset or invalid', () => {
			delete process.env.NEWS_ANALYSIS_RETENTION_DAYS;
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);

			process.env.NEWS_ANALYSIS_RETENTION_DAYS = 'invalid';
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);

			process.env.NEWS_ANALYSIS_RETENTION_DAYS = '500'; // above 365
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);

			process.env.NEWS_ANALYSIS_RETENTION_DAYS = '0'; // below 1
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);
		});

		it('uses valid configured retention days', () => {
			process.env.NEWS_ANALYSIS_RETENTION_DAYS = '60';
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(60);
		});
	});

	describe('stripUndefinedFieldsDeep', () => {
		it('recursively removes undefined fields while keeping null and other values', () => {
			const input = {
				a: 1,
				b: undefined,
				c: null,
				d: {
					e: undefined,
					f: 'hello',
					g: [1, undefined, 2, { h: undefined, i: true }],
				},
			};
			const sanitized = NewsAnalysisStorageService.stripUndefinedFieldsDeep(input);
			expect(sanitized).toEqual({
				a: 1,
				c: null,
				d: {
					f: 'hello',
					g: [1, 2, { i: true }],
				},
			});
		});
	});

	describe('recordAnalysis', () => {
		it('returns null and does not write if isEnabled() is false', async () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';
			const result = await NewsAnalysisStorageService.recordAnalysis({ symbol: 'BTCUSDT' });
			expect(result).toBeNull();
		});

		it('persists a complete analysis document with sanitized fields', async () => {
			const record = {
				symbol: 'btcusdt',
				eventCategory: 'price_surge',
				sentiment: 0.85,
				confidence: 0.9,
				headline: 'Bitcoin crosses key level',
				alertSent: true,
				promptVersion: 'v2.1',
				tokens: 1540.6,
			};

			const savedId = await NewsAnalysisStorageService.recordAnalysis(record);
			expect(savedId).toBeTruthy();

			// Read back from mock collection state
			const { analyses } = await NewsAnalysisStorageService.listAnalyses({ limit: 10 });
			expect(analyses).toHaveLength(1);
			const saved = analyses[0];
			expect(saved.id).toBe(savedId);
			expect(saved.symbol).toBe('BTCUSDT');
			expect(saved.eventCategory).toBe('price_surge');
			expect(saved.sentiment).toBe(0.85);
			expect(saved.confidence).toBe(0.9);
			expect(saved.headline).toBe('Bitcoin crosses key level');
			expect(saved.alertSent).toBe(true);
			expect(saved.promptVersion).toBe('v2.1');
			expect(saved.tokens).toBe(1541);
		});

		it('strips undefined promptVersion and defaults missing values gracefully', async () => {
			const record = {
				symbol: 'ETHUSDT',
				eventCategory: undefined,
				sentiment: undefined,
				confidence: undefined,
				headline: undefined,
				alertSent: false,
				promptVersion: undefined,
				tokens: undefined,
			};

			const savedId = await NewsAnalysisStorageService.recordAnalysis(record);
			expect(savedId).toBeTruthy();

			const { analyses } = await NewsAnalysisStorageService.listAnalyses({ limit: 10 });
			expect(analyses).toHaveLength(1);
			const saved = analyses[0];
			expect(saved.symbol).toBe('ETHUSDT');
			expect(saved.eventCategory).toBe('none');
			expect(saved.sentiment).toBe(0);
			expect(saved.confidence).toBe(0);
			expect(saved.headline).toBe('');
			expect(saved.alertSent).toBe(false);
			expect(saved.promptVersion).toBeNull();
			expect(saved.tokens).toBeNull();
		});

		it('fails open when Firestore write rejects', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			mockDocSet.mockImplementationOnce(() => Promise.reject(new Error('Firestore write quota exceeded')));

			const savedId = await NewsAnalysisStorageService.recordAnalysis({ symbol: 'SOLUSDT' });
			expect(savedId).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[NewsAnalysisStorageService] Failed to record news analysis:'),
				'Firestore write quota exceeded',
			);
			warnSpy.mockRestore();
		});
	});

	describe('recordAnalyses', () => {
		it('records multiple analyses concurrently and returns array of ids', async () => {
			const records = [
				{ symbol: 'BTCUSDT', confidence: 0.8, alertSent: true },
				{ symbol: 'ETHUSDT', confidence: 0.6, alertSent: false },
			];
			const ids = await NewsAnalysisStorageService.recordAnalyses(records);
			expect(ids).toHaveLength(2);

			const { analyses } = await NewsAnalysisStorageService.listAnalyses({ limit: 10 });
			expect(analyses).toHaveLength(2);
		});

		it('returns empty array when records is empty or invalid', async () => {
			expect(await NewsAnalysisStorageService.recordAnalyses([])).toEqual([]);
			expect(await NewsAnalysisStorageService.recordAnalyses(null)).toEqual([]);
		});
	});

	describe('summarizeAnalyses', () => {
		it('throws FEATURE_DISABLED error when disabled', async () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';
			await expect(NewsAnalysisStorageService.summarizeAnalyses()).rejects.toMatchObject({
				code: 'FEATURE_DISABLED',
			});
		});

		it('aggregates per-symbol and per-eventCategory metrics', async () => {
			// Record test data
			await NewsAnalysisStorageService.recordAnalyses([
				{ symbol: 'BTCUSDT', eventCategory: 'price_surge', confidence: 0.8, alertSent: true },
				{ symbol: 'BTCUSDT', eventCategory: 'regulatory', confidence: 0.6, alertSent: false },
				{ symbol: 'ETHUSDT', eventCategory: 'price_surge', confidence: 0.9, alertSent: true },
			]);

			const summary = await NewsAnalysisStorageService.summarizeAnalyses();
			expect(summary.totalAnalyses).toBe(3);
			expect(summary.totalAlertsSent).toBe(2);

			// bySymbol
			expect(summary.bySymbol.BTCUSDT).toEqual({
				totalAnalyses: 2,
				alertsSent: 1,
				averageConfidence: 0.7,
			});
			expect(summary.bySymbol.ETHUSDT).toEqual({
				totalAnalyses: 1,
				alertsSent: 1,
				averageConfidence: 0.9,
			});

			// byEventCategory
			expect(summary.byEventCategory.price_surge).toEqual({
				total: 2,
				alertsSent: 2,
				averageConfidence: 0.85,
			});
			expect(summary.byEventCategory.regulatory).toEqual({
				total: 1,
				alertsSent: 0,
				averageConfidence: 0.6,
			});
		});

		it('computes false-positive proxy metric accurately', async () => {
			const now = Date.now();
			// Mock records directly with simulated createdAt timestamps
			const collectionState = global.__firebaseAdminMockState.collections.get('news_analysis') || new Map();
			global.__firebaseAdminMockState.collections.set('news_analysis', collectionState);

			// Alert 1: BTC alert at t=0 (confidence 0.85)
			collectionState.set('doc-1', {
				id: 'doc-1',
				symbol: 'BTCUSDT',
				eventCategory: 'price_surge',
				confidence: 0.85,
				alertSent: true,
				createdAt: { toDate: () => new Date(now - 100000) },
			});
			// Alert 2: BTC alert at t=1 hour later (confidence 0.8) -> Follows up Alert 1!
			collectionState.set('doc-2', {
				id: 'doc-2',
				symbol: 'BTCUSDT',
				eventCategory: 'price_surge',
				confidence: 0.8,
				alertSent: true,
				createdAt: { toDate: () => new Date(now - 100000 + 3600000) },
			});
			// Alert 3: ETH alert with high confidence but NO follow up within 24h
			collectionState.set('doc-3', {
				id: 'doc-3',
				symbol: 'ETHUSDT',
				eventCategory: 'regulatory',
				confidence: 0.9,
				alertSent: true,
				createdAt: { toDate: () => new Date(now - 200000) },
			});

			const summary = await NewsAnalysisStorageService.summarizeAnalyses({ threshold: 0.75 });
			// Total evaluated alerts: 3 (Alert 1, Alert 2, Alert 3 all have confidence >= 0.75 and alertSent=true)
			// Alert 1 had follow-up (Alert 2).
			// Alert 2 had NO follow-up.
			// Alert 3 had NO follow-up.
			// No followup count = 2 / 3 = 66.67%
			expect(summary.falsePositiveProxy.totalEvaluated).toBe(3);
			expect(summary.falsePositiveProxy.noFollowupCount).toBe(2);
			expect(summary.falsePositiveProxy.ratePercent).toBe(66.67);
		});

		// Regression (#1152)
		it('excludes high-confidence analyses that never sent an alert from the false-positive proxy', async () => {
			await NewsAnalysisStorageService.recordAnalyses([
				{
					symbol: 'BTCUSDT',
					eventCategory: 'price_surge',
					confidence: 0.95,
					alertSent: false,
				},
			]);

			const summary = await NewsAnalysisStorageService.summarizeAnalyses({ threshold: 0.7 });

			// The analysis still counts as an analysis, just not as an evaluated alert.
			expect(summary.totalAnalyses).toBe(1);
			expect(summary.totalAlertsSent).toBe(0);
			expect(summary.bySymbol.BTCUSDT.alertsSent).toBe(0);
			expect(summary.bySymbol.BTCUSDT.averageConfidence).toBe(0.95);

			expect(summary.falsePositiveProxy.totalEvaluated).toBe(0);
			expect(summary.falsePositiveProxy.noFollowupCount).toBe(0);
			expect(summary.falsePositiveProxy.ratePercent).toBe(0);
		});

		it('ignores a no-follow-up unsent record when a delivered alert shares its symbol', async () => {
			const now = Date.now();
			const collectionState = global.__firebaseAdminMockState.collections.get('news_analysis') || new Map();
			global.__firebaseAdminMockState.collections.set('news_analysis', collectionState);

			// Unsent high-confidence analysis 1h before the delivered alert. It must not
			// become the follow-up that masks the delivered alert as a true positive.
			collectionState.set('doc-unsent', {
				id: 'doc-unsent',
				symbol: 'BTCUSDT',
				eventCategory: 'price_surge',
				confidence: 0.95,
				alertSent: false,
				createdAt: { toDate: () => new Date(now - 3600000) },
			});
			collectionState.set('doc-sent', {
				id: 'doc-sent',
				symbol: 'BTCUSDT',
				eventCategory: 'price_surge',
				confidence: 0.9,
				alertSent: true,
				createdAt: { toDate: () => new Date(now - 100000) },
			});

			const summary = await NewsAnalysisStorageService.summarizeAnalyses({ threshold: 0.7 });

			expect(summary.totalAnalyses).toBe(2);
			expect(summary.totalAlertsSent).toBe(1);
			expect(summary.falsePositiveProxy.totalEvaluated).toBe(1);
			expect(summary.falsePositiveProxy.noFollowupCount).toBe(1);
			expect(summary.falsePositiveProxy.ratePercent).toBe(100);
		});
	});

	describe('listAnalyses', () => {
		it('returns paginated analyses with nextCursor', async () => {
			await NewsAnalysisStorageService.recordAnalyses([
				{ symbol: 'BTCUSDT', confidence: 0.8 },
				{ symbol: 'ETHUSDT', confidence: 0.7 },
				{ symbol: 'SOLUSDT', confidence: 0.9 },
			]);

			const result = await NewsAnalysisStorageService.listAnalyses({ limit: 2 });
			expect(result.analyses).toHaveLength(2);
			expect(result.nextCursor).toBeTruthy();
		});
	});

	describe('production enablement (#1180)', () => {
		it('is a process-startup gate, so the Remote Config allow-list must not carry it', () => {
			const { PARAMETER_SCHEMA } = require('../../src/services/remoteConfig/RemoteConfigService');
			expect(PARAMETER_SCHEMA).not.toHaveProperty('ENABLE_FIRESTORE_NEWS_ANALYSIS');
			// The retention window is the genuine runtime knob and stays eligible.
			expect(PARAMETER_SCHEMA).toHaveProperty('NEWS_ANALYSIS_RETENTION_DAYS');
		});

		it('does not let a published template entry revert the env gate to false', () => {
			const template = require('../../firebase-remote-config-template.json');
			// A template parameter's defaultValue is reported by the Admin SDK with
			// source `remote`, so a published `"false"` here would override render.yaml.
			expect(Object.keys(template.parameters)).not.toContain('ENABLE_FIRESTORE_NEWS_ANALYSIS');
		});

		it('declares the composite indexes required by the ordered reads', () => {
			const indexes = require('../../firestore.indexes.json');
			const declared = indexes.indexes
				.filter(entry => entry.collectionGroup === 'news_analysis')
				.map(entry => entry.fields.map(f => `${f.fieldPath}:${f.order}`).join(','));

			// Firestore never merges single-field indexes, so an equality filter plus a
			// sort on createdAt each need an explicit composite.
			expect(declared).toEqual(expect.arrayContaining([
				'symbol:ASCENDING,createdAt:DESCENDING',
				'eventCategory:ASCENDING,createdAt:DESCENDING',
				'symbol:ASCENDING,eventCategory:ASCENDING,createdAt:DESCENDING',
			]));
		});

		it('declares the gate in render.yaml for the web service with previews off', () => {
			const fs = require('fs');
			const yaml = fs.readFileSync(require.resolve('../../render.yaml'), 'utf8');
			expect(yaml).toMatch(
				/- key: ENABLE_FIRESTORE_NEWS_ANALYSIS\s+value: true\s+previewValue: false/,
			);
		});
	});

	describe('getStorageStatus proven readiness', () => {
		// Generated at runtime, never committed: `isFirestoreConfigured()` runs
		// `createPrivateKey`, so the fixture must be a real PEM, and a checked-in
		// private key block would trip the Gitleaks secret-scan workflow (CB-257).
		let testPrivateKey;

		beforeAll(() => {
			testPrivateKey = generateKeyPairSync('rsa', {
				modulusLength: 2048,
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
				publicKeyEncoding: { type: 'spki', format: 'pem' },
			}).privateKey;
		});

		beforeEach(() => {
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
				type: 'service_account',
				project_id: 'demo-project',
				private_key: testPrivateKey,
				client_email: 'a@b.iam.gserviceaccount.com',
			});
		});

		it('reports disabled with ephemeral intent when the gate is off', () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';
			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status).toMatchObject({
				enabled: false,
				status: 'disabled',
				mode: 'ephemeral',
				backend: 'memory',
				ready: false,
				failOpen: true,
				collection: 'news_analysis',
			});
		});

		it('reports misconfigured — not ready — when the gate is on but credentials are absent', () => {
			delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.status).toBe('misconfigured');
			expect(status.configured).toBe(false);
			expect(status.ready).toBe(false);
			expect(status.mode).toBe('ephemeral');
		});

		it('reports unverified — not ready — on a cold process with the gate on', () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'true';
			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.status).toBe('unverified');
			expect(status.readiness).toBe('unverified');
			expect(status.ready).toBe(false);
			expect(status.mode).toBe('durable');
			expect(status.backend).toBe('firestore');
		});

		it('keeps mode/backend as intent even after a durable failure', async () => {
			mockDocSet.mockRejectedValueOnce(new Error('transient outage'));
			await NewsAnalysisStorageService.recordAnalysis({ symbol: 'BTCUSDT' });
			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.status).toBe('degraded');
			// An operator reading `memory` concludes the flag is off, which is the
			// opposite of the truth while the gate is on.
			expect(status.mode).toBe('durable');
			expect(status.backend).toBe('firestore');
		});

		it('records no durable attempt for a status read', () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'true';
			NewsAnalysisStorageService.getStorageStatus();
			NewsAnalysisStorageService.getStorageStatus();
			expect(NewsAnalysisStorageService.getStorageStatus().operationsAttempted).toBe(0);
		});

		it('becomes ready only after an observed successful durable write', async () => {
			await NewsAnalysisStorageService.recordAnalysis({ symbol: 'BTCUSDT', confidence: 0.8 });
			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.status).toBe('ready');
			expect(status.ready).toBe(true);
			expect(status.operationsSucceeded).toBeGreaterThan(0);
			expect(status.consecutiveFailures).toBe(0);
		});

		it('self-heals from degraded on the next success without a restart', async () => {
			mockDocSet.mockRejectedValueOnce(new Error('transient outage'));
			await NewsAnalysisStorageService.recordAnalysis({ symbol: 'BTCUSDT' });
			expect(NewsAnalysisStorageService.getStorageStatus().status).toBe('degraded');

			await NewsAnalysisStorageService.recordAnalysis({ symbol: 'BTCUSDT' });
			expect(NewsAnalysisStorageService.getStorageStatus().status).toBe('ready');
		});

		it('keeps operationsFailed <= operationsAttempted when initialization is rejected', () => {
			// Issue #1128: configured-but-invalid inline credentials must be refused by
			// the shared bootstrap rather than entering initializeApp({}).
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
				type: 'authorized_user',
				client_id: 'abc',
				client_secret: 'shh',
				refresh_token: 'token',
			});
			expect(NewsAnalysisStorageService.getFirestore()).toBeNull();
			expect(admin.__mockInitializeApp).not.toHaveBeenCalled();

			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.operationsAttempted).toBe(1);
			expect(status.operationsFailed).toBe(1);
			expect(status.operationsFailed).toBeLessThanOrEqual(status.operationsAttempted);
			// Gate state wins over observed health: an `authorized_user` document has no
			// project_id/private_key, so this is a credential fault to fix, not a
			// transient outage. #1128 refuses it instead of authenticating with a
			// different credential than the operator configured.
			expect(status.status).toBe('misconfigured');
			expect(status.lastErrorReason).toBe('uninitialized');
		});

		it('classifies a rejected query as a storage failure and names a missing index', async () => {
			const missingIndex = new Error(
				'Failed to get query results. The query requires an index. You can create an index here: https://console.firebase.google.com/project/demo-project/databases/(default)/indexes',
			);
			missingIndex.code = 9;
			mockGet.mockRejectedValueOnce(missingIndex);

			await expect(NewsAnalysisStorageService.summarizeAnalyses({})).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});

			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.status).toBe('degraded');
			expect(status.lastMissingIndex).toBe(true);
			expect(status.lastErrorReason).toBe('failed_precondition');
		});

		it('never leaks the provider message or project path into the status payload', async () => {
			const leaky = new Error('permission denied at projects/demo-project/databases/(default)');
			leaky.code = 7;
			mockGet.mockRejectedValueOnce(leaky);

			await expect(NewsAnalysisStorageService.listAnalyses({})).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});

			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.lastErrorReason).toBe('permission_denied');
			expect(JSON.stringify(status)).not.toContain('demo-project');
			expect(JSON.stringify(status)).not.toContain('(default)');
		});

		it('records read outcomes so a broken read path stays observable', async () => {
			await NewsAnalysisStorageService.listAnalyses({});
			await NewsAnalysisStorageService.summarizeAnalyses({});
			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.operationsAttempted).toBe(2);
			expect(status.operationsSucceeded).toBe(2);
		});

		it('resets counters in place for tests', async () => {
			await NewsAnalysisStorageService.recordAnalysis({ symbol: 'BTCUSDT' });
			NewsAnalysisStorageService.__resetReadinessForTesting();
			const status = NewsAnalysisStorageService.getStorageStatus();
			expect(status.operationsAttempted).toBe(0);
			expect(status.operationsSucceeded).toBe(0);
			expect(status.lastSuccessAt).toBeNull();
			expect(status.lastMissingIndex).toBe(false);
		});
	});
});
