/**
 * Issue #721 — Firestore storage feature flags as Remote Config parameters.
 *
 * The four Firestore storage gates are evaluated lazily, before the cached
 * `db` handle, so a remote override can flip them at runtime. Each consumer
 * must therefore resolve its gate as `remote ?? env`, never `env || remote`:
 *
 *   - `getRuntimeConfig()` always returns a boolean for a schema key, so a
 *     present remote value must WIN over a `true` environment value. Collapsing
 *     to `env || rc` would make flipping a gate OFF remotely impossible for the
 *     production deployment (render.yaml pins these to `true`).
 *   - Remote Config unavailable (gate off, stale, or the loader throwing) must
 *     fall back to `process.env` so `render.yaml` keeps full control.
 */
const fs = require('fs');
const path = require('path');

const FIRESTORE_FLAG_KEYS = [
	'ENABLE_FIRESTORE_ALERT_STORAGE',
	'ENABLE_FIRESTORE_IDEMPOTENCY',
	'ENABLE_FIRESTORE_JOB_STORAGE',
	'ENABLE_FIRESTORE_SCANNER_PRESETS',
];

function loadTemplate() {
	return JSON.parse(
		fs.readFileSync(path.join(__dirname, '../../firebase-remote-config-template.json'), 'utf8'),
	);
}

// Remote overrides are only honored when the Remote Config gate is on and a fresh
// template has loaded — the same precondition `getRuntimeConfig()` enforces. This
// enables that precondition without reaching for Firebase, then applies
// overrides directly to the published set.
function publishRemote(remoteConfigService, overrides) {
	process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
	remoteConfigService._resetForTesting();
	remoteConfigService._setRemoteOverridesForTesting(overrides, Date.now());
	return remoteConfigService;
}

describe('Issue #721 — Firestore storage flags in Remote Config', () => {
	let savedEnv;
	let remoteConfigService;

	beforeEach(() => {
		jest.resetModules();
		savedEnv = { ...process.env };
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'false';
		remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
		remoteConfigService._resetForTesting();
	});

	afterEach(() => {
		try {
			remoteConfigService.stop();
		} catch {
			// stop() is best-effort in teardown.
		}
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		Object.assign(process.env, savedEnv);
		jest.resetModules();
	});

	describe('PARAMETER_SCHEMA allow-list', () => {
		it('declares all four Firestore storage flags as booleans defaulting to false', () => {
			FIRESTORE_FLAG_KEYS.forEach((key) => {
				expect(remoteConfigService.PARAMETER_SCHEMA[key]).toEqual({
					type: 'boolean',
					defaultValue: false,
				});
			});
		});

		it('reports each flag as false when unset in the environment', () => {
			const config = remoteConfigService.getRuntimeConfig();
			FIRESTORE_FLAG_KEYS.forEach((key) => {
				expect(config[key]).toBe(false);
			});
		});

		it('preserves the environment value when Remote Config is disabled', () => {
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			expect(remoteConfigService.getRuntimeConfig().ENABLE_FIRESTORE_IDEMPOTENCY).toBe(true);
		});
	});

	describe('published template parity', () => {
		it('publishes every schema key in firebase-remote-config-template.json', () => {
			const templateKeys = Object.keys(loadTemplate().parameters || {});
			Object.keys(remoteConfigService.PARAMETER_SCHEMA).forEach((key) => {
				expect(templateKeys).toContain(key);
			});
		});

		it('ships useInAppDefault so publishing yields NO override for the storage gates', () => {
			// Regression (found in review): a template `defaultValue` is NOT a default.
			// `firebase-admin` evaluates an unmatched parameter's defaultValue and tags it
			// with source 'remote' (see remote-config.js: `configValues[key] = new
			// ValueImpl('remote', parameterDefaultValue)`), which `getRemoteValue()`
			// accepts as a real override. Shipping `false` therefore would have
			// silently disabled the three storage modes render.yaml pins to `true` on the
			// first publish, with no operator intent.
			//
			// `useInAppDefault: true` makes the SDK skip the parameter entirely, so
			// `getSource()` stays 'default', no override is stored, and the deployment
			// value decides — which is the documented `remote ?? env` contract.
			const { parameters } = loadTemplate();
			FIRESTORE_FLAG_KEYS.forEach((key) => {
				expect(parameters[key].defaultValue).toEqual({ useInAppDefault: true });
				expect(parameters[key].defaultValue.value).toBeUndefined();
			});
		});

		it('never ships a literal value that could override render.yaml', () => {
			// Any schema key carrying a literal `defaultValue` becomes a remote override
			// on publish. This is only safe when it agrees with the deployment pin, so
			// the storage gates specifically must not carry one.
			const { parameters } = loadTemplate();
			const renderYaml = fs.readFileSync(path.join(__dirname, '../../render.yaml'), 'utf8');
			FIRESTORE_FLAG_KEYS.filter((key) => renderYaml.includes(`- key: ${key}\n    value: true`))
				.forEach((key) => {
					expect(parameters[key].defaultValue).not.toHaveProperty('value');
				});
		});

		it('a published template with useInAppDefault leaves every storage gate on its env value', () => {
			// End-to-end proof through the real evaluate() path: with
			// useInAppDefault set and no conditional value, the SDK must produce no
			// remote value, so the gates keep the render.yaml `true`.
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
			process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			publishRemote(remoteConfigService, {
				ENABLE_FIRESTORE_IDEMPOTENCY: undefined,
			});

			const jobs = require('../../src/services/jobs/JobRepository');
			const idem = require('../../src/services/storage/IdempotencyStorageService');
			const storage = require('../../src/services/storage/AlertStorageService');

			expect(remoteConfigService.getRemoteOverride('ENABLE_FIRESTORE_JOB_STORAGE')).toBeUndefined();
			expect(jobs.isFirestoreEnabled()).toBe(true);
			expect(idem.isEnabled()).toBe(true);
			expect(storage.isEnabled()).toBe(true);
		});
	});

	describe('remote override precedence', () => {
		it('lets a remote true override a false environment value', () => {
			const service = publishRemote(remoteConfigService, {
				ENABLE_FIRESTORE_SCANNER_PRESETS: true,
			});
			expect(service.getRemoteOverride('ENABLE_FIRESTORE_SCANNER_PRESETS')).toBe(true);
			expect(service.getRuntimeConfig().ENABLE_FIRESTORE_SCANNER_PRESETS).toBe(true);
		});

		it('lets a remote false override a TRUE environment value (the production pins)', () => {
			// This is the case that makes `env || remote` wrong: render.yaml pins
			// these to `true` on the web service, so an operator could otherwise
			// never switch a gate off remotely.
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
			process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';

			const service = publishRemote(remoteConfigService, {
				ENABLE_FIRESTORE_IDEMPOTENCY: false,
				ENABLE_FIRESTORE_JOB_STORAGE: false,
				ENABLE_FIRESTORE_SCANNER_PRESETS: false,
			});

			const config = service.getRuntimeConfig();
			expect(config.ENABLE_FIRESTORE_IDEMPOTENCY).toBe(false);
			expect(config.ENABLE_FIRESTORE_JOB_STORAGE).toBe(false);
			expect(config.ENABLE_FIRESTORE_SCANNER_PRESETS).toBe(false);
		});

		it('falls back to the environment value when no override was published', () => {
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
			const service = publishRemote(remoteConfigService, {});
			expect(service.getRemoteOverride('ENABLE_FIRESTORE_JOB_STORAGE')).toBeUndefined();
			expect(service.getRuntimeConfig().ENABLE_FIRESTORE_JOB_STORAGE).toBe(true);
		});

		it('reports no override when the Remote Config gate is off', () => {
			// The previews' state: ENABLE_FIREBASE_REMOTE_CONFIG=false. A preview
			// must keep the render.yaml value and can never be steered by a
			// published template.
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'false';

			const service = require('../../src/services/remoteConfig/RemoteConfigService');
			service._resetForTesting();
			service._setRemoteOverridesForTesting({ ENABLE_FIRESTORE_IDEMPOTENCY: false }, Date.now());

			expect(service.getRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBeUndefined();
			expect(service.getRuntimeConfig().ENABLE_FIRESTORE_IDEMPOTENCY).toBe(true);
		});

		it('reports no override for a key outside the allow-list', () => {
			const service = publishRemote(remoteConfigService, { ENABLE_TEST_ALERT: true });
			expect(service.getRemoteOverride('ENABLE_TEST_ALERT')).toBeUndefined();
		});

		it('reports no override once a published template goes stale', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.FIREBASE_REMOTE_CONFIG_MAX_AGE_MS = '60000';
			const service = require('../../src/services/remoteConfig/RemoteConfigService');
			service._resetForTesting();
			service._setRemoteOverridesForTesting(
				{ ENABLE_FIRESTORE_IDEMPOTENCY: true },
				Date.now() - 120000,
			);

			expect(service.getRemoteOverride('ENABLE_FIRESTORE_IDEMPOTENCY')).toBeUndefined();
		});
	});

	describe('consumer resolution (remote ?? env)', () => {
		it('AlertStorageService.isEnabled resolves the remote value over the environment', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_ALERT_STORAGE: true });

			const storage = require('../../src/services/storage/AlertStorageService');
			expect(storage.isEnabled()).toBe(true);

			remoteConfigService._setRemoteOverridesForTesting(
				{ ENABLE_FIRESTORE_ALERT_STORAGE: false },
				Date.now(),
			);
			expect(storage.isEnabled()).toBe(false);
		});

		it('IdempotencyStorageService.isEnabled resolves the remote value over the environment', () => {
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_IDEMPOTENCY: false });

			const idempotency = require('../../src/services/storage/IdempotencyStorageService');
			expect(idempotency.isEnabled()).toBe(false);
		});

		it('IdempotencyStorageService keeps the deprecated env alias working without a remote override', () => {
			delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY;
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE = 'true';

			const idempotency = require('../../src/services/storage/IdempotencyStorageService');
			expect(idempotency.isEnabled()).toBe(true);
		});

		it('JobRepository.isFirestoreEnabled resolves the remote value over the environment', () => {
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'false';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_JOB_STORAGE: true });

			const jobs = require('../../src/services/jobs/JobRepository');
			expect(jobs.isFirestoreEnabled()).toBe(true);

			remoteConfigService._setRemoteOverridesForTesting(
				{ ENABLE_FIRESTORE_JOB_STORAGE: false },
				Date.now(),
			);
			expect(jobs.isFirestoreEnabled()).toBe(false);
		});

		it('JobRepository treats each of its two gates independently', () => {
			// Regression: `remote || env` per gate. Both gates env-on, both published
			// `false`, must disable the predicate. Combining the sources with `||`
			// let the `true` env pin win and the gate stayed on.
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			publishRemote(remoteConfigService, {
				ENABLE_FIRESTORE_JOB_STORAGE: false,
				ENABLE_FIRESTORE_ALERT_STORAGE: false,
			});

			const jobs = require('../../src/services/jobs/JobRepository');
			expect(jobs.isFirestoreEnabled()).toBe(false);
		});

		it('JobRepository falls back to the environment per gate when only one is published', () => {
			// Only JOB_STORAGE is published (as `false`); ALERT_STORAGE has no published
			// value, so the environment still decides it. The predicate must stay true
			// because the unpublished gate is environment-enabled.
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_JOB_STORAGE: false });

			const jobs = require('../../src/services/jobs/JobRepository');
			expect(jobs.isFirestoreEnabled()).toBe(true);
		});

		it('JobRepository keeps a published false when the environment is unset', () => {
			// Environment silent, template says `false`: the gate must be off rather
			// than falling back to the `false` default of the other source.
			delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;
			delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_JOB_STORAGE: false });

			const jobs = require('../../src/services/jobs/JobRepository');
			expect(jobs.isFirestoreEnabled()).toBe(false);
		});

		it('ScannerPresetService reports durable storage from the remote gate', () => {
			process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_SCANNER_PRESETS: false });

			const { scannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
			const status = scannerPresetService.getStorageStatus();
			expect(status.backend).toBe('memory');
		});

		it('canInitializeFirestore is decided solely by ENABLE_FIREBASE_REMOTE_CONFIG once RC is on', () => {
			// Why the companion gates are deliberately not wired into this predicate.
			// With Remote Config enabled, `ENABLE_FIREBASE_REMOTE_CONFIG === 'true'`
			// is unconditionally in the OR-chain and already forces `firebase-admin` to
			// initialize for the loader's own template fetch — so a published companion
			// value cannot change the outcome no matter which way it is set.
			//
			// This asserts that structurally: the environment is completely clear of
			// every companion gate, so the RC gate is the ONLY possible source of a
			// `true`. A companion-gate `false` therefore must not be observable here.
			delete process.env.ENABLE_FIRESTORE_SCANNER_PRESETS;
			delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;
			delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_SCANNER_PRESETS: false });

			const storage = require('../../src/services/storage/AlertStorageService');
			// True, because the RC gate itself is what initializes the SDK.
			expect(storage.canInitializeFirestore()).toBe(true);

			// And with Remote Config off plus no companion gate in the environment, the
			// predicate is false regardless of any published value — proving the
			// companion remote value is genuinely unreachable in both directions.
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'false';
			const storageWithRcOff = require('../../src/services/storage/AlertStorageService');
			expect(storageWithRcOff.canInitializeFirestore()).toBe(false);
		});

		it('canInitializeFirestore honors the environment companion gate with RC off', () => {
			process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
			const storage = require('../../src/services/storage/AlertStorageService');
			expect(storage.canInitializeFirestore()).toBe(true);
		});

		it('AlertStorageService.probeOrderedAlertRead is gated by the remote value', async () => {
			// The observable effect of the gate on a real public path. With the
			// environment on and a published remote `false`, the ordered-read probe
			// must short-circuit to `null` instead of querying Firestore.
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_ALERT_STORAGE: false });

			const storage = require('../../src/services/storage/AlertStorageService');
			await expect(storage.probeOrderedAlertRead()).resolves.toBeNull();
		});

		it('AlertStorageService.probeOrderedAlertRead runs when the remote value enables the gate', async () => {
			// With the environment OFF but Remote Config enabling the gate, the probe
			// must proceed past the `isEnabled()` guard rather than silently skip —
			// otherwise `/ready` would report a false green for a gate that is on.
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_ALERT_STORAGE: true });

			const storage = require('../../src/services/storage/AlertStorageService');
			// Returns `true`, not `null`: the gate opened, so the probe actually ran
			// the indexed read shape rather than short-circuiting.
			await expect(storage.probeOrderedAlertRead()).resolves.toBe(true);
		});

		it('falls back to the environment when the Remote Config module throws', () => {
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				getRemoteOverride: () => {
					throw new Error('remote config unavailable');
				},
			}));

			const idempotency = require('../../src/services/storage/IdempotencyStorageService');
			expect(idempotency.isEnabled()).toBe(true);
			jest.dontMock('../../src/services/remoteConfig/RemoteConfigService');
		});

		it('tolerates a Remote Config build without getRemoteOverride', () => {
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				getRuntimeConfig: () => ({ ENABLE_FIRESTORE_IDEMPOTENCY: false }),
			}));

			const idempotency = require('../../src/services/storage/IdempotencyStorageService');
			expect(idempotency.isEnabled()).toBe(true);
			jest.dontMock('../../src/services/remoteConfig/RemoteConfigService');
		});
	});

	describe('observability surfaces report the running gate', () => {
		function callStatusController() {
			// `getApiStatus` is an Express handler; drive it with a minimal response
			// double and return the captured payload, matching the pattern used by
			// tests/integration/status-endpoint.test.js.
			let captured = null;
			const response = {
				status() {
					return response;
				},
				json(body) {
					captured = body;
					return response;
				},
			};
			return require('../../src/controllers/status')
				.getApiStatus({}, response)
				.then(() => captured);
		}

		// Driven through the public `createReadinessService` surface rather than a
		// test-only export: the Firestore probe reports `skipped` when the gate is
		// off, which is the observable contract a monitor sees.
		function runFirestoreProbe() {
			const { createReadinessService } = require('../../src/lib/readiness');
			const service = createReadinessService({
				isFirestoreConfigured: () => true,
				getFirestoreClient: () => ({}),
				probeAlertReads: async () => undefined,
			});
			return service.collectReadiness().then((report) => report.dependencies.firestore);
		}

		it('the Firestore readiness probe is skipped when the remote gate is off', () => {
			// If readiness read process.env it would run the probe while the probe body
			// — `probeOrderedAlertRead`, which IS remotely gated — would not: the two
			// halves of one probe disagreeing.
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			publishRemote(remoteConfigService, { ENABLE_FIRESTORE_ALERT_STORAGE: false });

			return runFirestoreProbe().then((firestore) => {
				expect(firestore.skipped).toBe(true);
				expect(firestore.reason).toBe('firestore_storage_disabled');
			});
		});

		it('the Firestore readiness probe runs when nothing is published', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			return runFirestoreProbe().then((firestore) => {
				expect(firestore.skipped).not.toBe(true);
			});
		});

		it('/api/status featureFlags reflect the remote gate', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_FIRESTORE_SCANNER_PRESETS = 'true';
			publishRemote(remoteConfigService, {
				ENABLE_FIRESTORE_ALERT_STORAGE: false,
				ENABLE_FIRESTORE_SCANNER_PRESETS: false,
			});

			const payload = await callStatusController();
			expect(payload.featureFlags.firestoreAlertStorage).toBe(false);
			expect(payload.featureFlags.firestoreScannerPresets).toBe(false);
		});

		it('/api/status reports the environment value when nothing is published', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const payload = await callStatusController();
			expect(payload.featureFlags.firestoreAlertStorage).toBe(true);
		});
	});
});