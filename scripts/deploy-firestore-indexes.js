#!/usr/bin/env node
'use strict';

/**
 * Audits and deploys the composite indexes declared in `firestore.indexes.json`.
 *
 * This is general index deployment and audit tooling. A declaration in
 * `firestore.indexes.json` is the repository template of record; it does not
 * create anything in the live project, and a successful deploy command does not
 * prove that every index has reached `READY`.
 *
 * PR #1310 was initially motivated by issue #1285, but later production
 * evidence ruled out a missing composite index: a document lookup for a
 * nonexistent alert also returns 503. This script does not resolve that read
 * failure; keep the issue open until its root cause is fixed and production
 * reads are verified.
 *
 * Two properties matter more than convenience here:
 *
 * 1. **Build state is read from the Firestore REST API, not the Firebase CLI.**
 *    `firebase firestore:indexes` builds its output through
 *    `FirestoreApi.makeIndexSpec()`, which projects each index down to
 *    `collectionGroup`/`queryScope`/`fields`/`apiScope`/`density`/`multikey`/
 *    `unique` and **drops `state`**. Composite indexes also build asynchronously
 *    and a query is rejected until the build reaches `READY`. So the CLI command
 *    the existing runbook tells you to "confirm with" structurally cannot
 *    distinguish READY from CREATING. The raw REST collection returns `state`,
 *    so that is what this script reads.
 *
 * 2. **Dry-run by default, and it exits non-zero while a required index is not
 *    READY.** Readiness is the exit condition, not only the deploy command's
 *    exit code.
 *
 * Credentials are resolved in the same order the runtime uses
 * (`FIREBASE_SERVICE_ACCOUNT_JSON` → `GOOGLE_APPLICATION_CREDENTIALS` → ADC) and
 * are never read back into the output, the audit log, or an error message.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_PROJECT = 'cabros-bot';
const DEFAULT_DATABASE = '(default)';
// Firebase CLI defaults omitted database metadata to Standard edition.
const DEFAULT_DATABASE_EDITION = 'STANDARD';
const DEFAULT_LOG_FILE = '.firestore-indexes-deploy.log';
const INDEXES_PATH = path.resolve(__dirname, '..', 'firestore.indexes.json');
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const STALLED_CREDENTIAL_EXIT_GRACE_MS = 1000;

/**
 * `READY` is the only state a query can actually use. The API also reports
 * CREATING (still building), NEEDS_REPAIR (deployed but
 * unusable), and STATE_UNSPECIFIED. Anything not READY is reported as
 * not ready rather than assumed usable.
 */
const READY_STATE = 'READY';
const DATABASE_EDITIONS = new Set(['STANDARD', 'ENTERPRISE', 'DATABASE_EDITION_UNSPECIFIED']);
const INDEX_QUERY_SCOPES = new Set(['COLLECTION', 'COLLECTION_GROUP']);
const INDEX_API_SCOPES = new Set(['ANY_API', 'DATASTORE_MODE_API', 'MONGODB_COMPATIBLE_API']);
const INDEX_DENSITIES = new Set(['DENSITY_UNSPECIFIED', 'SPARSE_ALL', 'SPARSE_ANY', 'DENSE']);
const INDEX_STATES = new Set(['STATE_UNSPECIFIED', 'CREATING', 'READY', 'NEEDS_REPAIR']);
const INDEX_DECLARATION_PROPERTIES = new Set([
	'collectionGroup',
	'queryScope',
	'apiScope',
	'density',
	'multikey',
	'fields',
]);
const LIVE_INDEX_PROPERTIES = new Set([
	'name',
	'queryScope',
	'apiScope',
	'fields',
	'state',
	'density',
	'multikey',
	'shardCount',
	'unique',
	'searchIndexOptions',
]);
const INDEX_FIELD_PROPERTIES = new Set(['fieldPath', 'order', 'arrayConfig', 'searchConfig', 'vectorConfig']);
const SEARCH_CONFIG_PROPERTIES = new Set(['textSpec', 'geoSpec']);
const SEARCH_TEXT_SPEC_PROPERTIES = new Set(['indexSpecs']);
const SEARCH_TEXT_INDEX_SPEC_PROPERTIES = new Set(['indexType', 'matchType']);
const SEARCH_TEXT_INDEX_TYPES = new Set(['TOKENIZED']);
const SEARCH_TEXT_MATCH_TYPES = new Set(['MATCH_GLOBALLY']);
const SEARCH_GEO_SPEC_PROPERTIES = new Set(['geoJsonIndexingDisabled']);
const VECTOR_CONFIG_PROPERTIES = new Set(['dimension', 'flat']);
const VECTOR_FLAT_PROPERTIES = new Set();
const MAX_VECTOR_DIMENSION = 2048;

/**
 * `projects.databases.collectionGroups.indexes.list` is paginated: it accepts
 * `pageSize`/`pageToken` and answers with `nextPageToken`. 300 keeps the whole
 * listing inside a handful of round trips while staying well under the service's
 * per-request maximum.
 */
const INDEX_PAGE_SIZE = 300;

/**
 * Hard stop on the page loop. A well-behaved listing terminates on an absent
 * `nextPageToken`; this cap only exists so a malformed or cycling `pageToken`
 * cannot spin forever. 50 pages x 300 = 15,000 composite indexes in one
 * database, which is far above any real deployment, so hitting it means the
 * provider is misbehaving and the answer must be "cannot determine" (exit 2)
 * rather than a partial audit that could report a READY index as MISSING.
 */
const MAX_INDEX_PAGES = 50;

/** Default gap between readiness polls after `--apply`. */
const DEFAULT_POLL_INTERVAL_MS = 10000;

/**
 * Parse CLI arguments. Dry-run unless `--apply` is passed, matching the other
 * operator tooling in this repository.
 *
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv = process.argv.slice(2)) {
	const args = {
		apply: false,
		dryRun: true,
		project: DEFAULT_PROJECT,
		database: DEFAULT_DATABASE,
		indexesPath: INDEXES_PATH,
		json: false,
		help: false,
		logFile: DEFAULT_LOG_FILE,
		timeoutMs: 10 * 60 * 1000,
	};

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];

		if (arg === '--help' || arg === '-h') {
			args.help = true;
			i++;
		} else if (arg === '--json') {
			args.json = true;
			i++;
		} else if (arg === '--apply') {
			args.apply = true;
			args.dryRun = false;
			i++;
		} else if (arg === '--dry-run') {
			args.apply = false;
			args.dryRun = true;
			i++;
		} else if (arg === '--project') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --project');
			args.project = argv[i + 1];
			i += 2;
		} else if (arg === '--database') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --database');
			args.database = argv[i + 1];
			i += 2;
		} else if (arg === '--indexes') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --indexes');
			args.indexesPath = path.resolve(argv[i + 1]);
			i += 2;
		} else if (arg === '--timeout-ms') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --timeout-ms');
			const value = Number(argv[i + 1]);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error('--timeout-ms must be a positive number');
			}
			args.timeoutMs = value;
			i += 2;
		} else if (arg === '--log-file') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --log-file');
			args.logFile = argv[i + 1];
			i += 2;
		} else if (arg === '--') {
			// Separator emitted by `pnpm run <script> -- --flag`. Everything after
			// it is forwarded verbatim, so it must not be treated as an option.
			i++;
		} else if (arg.startsWith('--')) {
			throw new Error(`Unknown option: ${arg}`);
		} else {
			throw new Error(`Unexpected positional argument: ${arg}`);
		}
	}

	return args;
}

/**
 * Read the composite indexes declared in the repository template.
 *
 * @param {string} [indexesPath]
 * @returns {Array<{collectionGroup: string, queryScope: string, apiScope?: string, density?: string, multikey?: boolean, fields: Array<Record<string, unknown>>}>}
 */
function readDeclaredIndexes(indexesPath = INDEXES_PATH) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(indexesPath, 'utf8'));
	} catch (error) {
		throw new Error(`Failed to read ${indexesPath}: ${error.message}`, { cause: error });
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.indexes)) {
		throw new Error(`${indexesPath} must contain an indexes array.`);
	}

	return parsed.indexes.map((index, indexNumber) => {
		const invalid = (reason) => {
			throw new Error(`${indexesPath} indexes[${indexNumber}] ${reason}.`);
		};
		if (!index || typeof index !== 'object' || Array.isArray(index)) {
			invalid('must be an object');
		}
		if (typeof index.collectionGroup !== 'string' || index.collectionGroup.trim() === '') {
			invalid('must have a non-empty collectionGroup');
		}
		if (!Object.prototype.hasOwnProperty.call(index, 'queryScope') || !INDEX_QUERY_SCOPES.has(index.queryScope)) {
			invalid('has an invalid queryScope');
		}
		if (index.apiScope !== undefined && !INDEX_API_SCOPES.has(index.apiScope)) {
			invalid('has an invalid apiScope');
		}
		if (index.density !== undefined && !INDEX_DENSITIES.has(index.density)) {
			invalid('has an invalid density');
		}
		if (index.multikey !== undefined && typeof index.multikey !== 'boolean') {
			invalid('has an invalid multikey value');
		}
		for (const option of ['unique', 'shardCount', 'searchIndexOptions']) {
			if (index[option] !== undefined) {
				invalid(`uses the unsupported ${option} option`);
			}
		}
		if (!hasOnlyProperties(index, INDEX_DECLARATION_PROPERTIES)) {
			invalid('has unknown properties');
		}
		if (!Array.isArray(index.fields) || index.fields.length === 0) {
			invalid('must have a non-empty fields array');
		}

		const fields = index.fields.map((field, fieldNumber) => {
			if (!isValidIndexField(field)) {
				invalid(`fields[${fieldNumber}] has invalid or unsupported properties/configuration`);
			}
			return { ...field };
		});

		return {
			collectionGroup: index.collectionGroup,
			queryScope: index.queryScope,
			...(index.apiScope !== undefined ? { apiScope: index.apiScope } : {}),
			...(index.density !== undefined ? { density: index.density } : {}),
			...(index.multikey !== undefined ? { multikey: index.multikey } : {}),
			fields,
		};
	});
}

/**
 * Stable identity for an index: collection, scope, and the ordered field list.
 * Order matters — `receivedAt DESC, __name__ DESC` is a different index from
 * `receivedAt DESC, __name__ ASC` — so the comparison is on the ordered list.
 * Optional index-level fields are normalized to the defaults for the database
 * edition, matching firebase-tools' index comparison.
 *
 * @param {Object} index
 * @param {string} [databaseEdition]
 * @returns {string}
 */
function stableSerialize(value) {
	if (value === undefined) return 'undefined';
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
	return `{${Object.keys(value).sort()
		.filter((key) => value[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
		.join(',')}}`;
}

function normalizeIndexFields(indexFields, databaseEdition) {
	const fields = Array.isArray(indexFields) ? [...indexFields] : [];
	if (databaseEdition !== 'STANDARD') {
		return fields;
	}
	const lastField = fields[fields.length - 1];
	let nameOrder = 'ASCENDING';
	for (const field of fields) {
		if (field.order) nameOrder = field.order;
	}
	const nameSuffix = { fieldPath: '__name__', order: nameOrder };

	// firebase-tools places the implicit name field before a terminal vector
	// field. Match that canonical order for both template and REST forms.
	if (lastField && lastField.vectorConfig) {
		const vectorField = fields.pop();
		if (fields.length === 0 || fields[fields.length - 1].fieldPath !== '__name__') {
			fields.push(nameSuffix);
		}
		fields.push(vectorField);
	} else if (lastField && lastField.fieldPath !== '__name__') {
		fields.push(nameSuffix);
	}

	return fields;
}

function parseIndexResourceName(name, project, database) {
	if (typeof name !== 'string') return null;
	const expectedPrefix = project === undefined || database === undefined
		? /^projects\/[^/]+\/databases\/[^/]+\/collectionGroups\//
		: `projects/${project}/databases/${database}/collectionGroups/`;
	const prefix = typeof expectedPrefix === 'string'
		? (name.startsWith(expectedPrefix) ? expectedPrefix : null)
		: (expectedPrefix.exec(name)?.[0] || null);
	if (!prefix) return null;
	const suffix = name.slice(prefix.length);
	const match = suffix.match(/^([^/]+)\/indexes\/([^/]+)$/);
	return match ? { collectionGroup: match[1] } : null;
}

function getCollectionGroup(index) {
	const parsedName = parseIndexResourceName(index.name);
	if (parsedName) return parsedName.collectionGroup;
	return typeof index.collectionGroup === 'string' && index.collectionGroup.length > 0
		? index.collectionGroup
		: '';
}

function hasOnlyProperties(value, properties) {
	return Object.keys(value).every((property) => properties.has(property));
}

function isValidSearchConfig(searchConfig) {
	if (!searchConfig || typeof searchConfig !== 'object' || Array.isArray(searchConfig)
		|| !hasOnlyProperties(searchConfig, SEARCH_CONFIG_PROPERTIES)) {
		return false;
	}
	const hasTextSpec = Object.prototype.hasOwnProperty.call(searchConfig, 'textSpec');
	const hasGeoSpec = Object.prototype.hasOwnProperty.call(searchConfig, 'geoSpec');
	if (!hasTextSpec && !hasGeoSpec) return false;

	if (hasTextSpec) {
		const { textSpec } = searchConfig;
		if (!textSpec || typeof textSpec !== 'object' || Array.isArray(textSpec)
			|| !hasOnlyProperties(textSpec, SEARCH_TEXT_SPEC_PROPERTIES)
			|| !Array.isArray(textSpec.indexSpecs) || textSpec.indexSpecs.length === 0) {
			return false;
		}
		for (const spec of textSpec.indexSpecs) {
			if (!spec || typeof spec !== 'object' || Array.isArray(spec)
				|| !hasOnlyProperties(spec, SEARCH_TEXT_INDEX_SPEC_PROPERTIES)
				|| !SEARCH_TEXT_INDEX_TYPES.has(spec.indexType)
				|| !SEARCH_TEXT_MATCH_TYPES.has(spec.matchType)) {
				return false;
			}
		}
	}

	if (hasGeoSpec) {
		const { geoSpec } = searchConfig;
		if (!geoSpec || typeof geoSpec !== 'object' || Array.isArray(geoSpec)
			|| !hasOnlyProperties(geoSpec, SEARCH_GEO_SPEC_PROPERTIES)
			|| (geoSpec.geoJsonIndexingDisabled !== undefined
				&& typeof geoSpec.geoJsonIndexingDisabled !== 'boolean')) {
			return false;
		}
	}
	return true;
}

function isValidIndexField(field) {
	if (!field || typeof field !== 'object' || Array.isArray(field)
		|| typeof field.fieldPath !== 'string' || field.fieldPath.trim() === ''
		|| !hasOnlyProperties(field, INDEX_FIELD_PROPERTIES)) {
		return false;
	}
	const modes = ['order', 'arrayConfig', 'searchConfig', 'vectorConfig']
		.filter((mode) => Object.prototype.hasOwnProperty.call(field, mode));
	if (modes.length !== 1) return false;
	if (field.order !== undefined && !['ASCENDING', 'DESCENDING'].includes(field.order)) return false;
	if (field.arrayConfig !== undefined && field.arrayConfig !== 'CONTAINS') return false;
	if (field.searchConfig !== undefined && !isValidSearchConfig(field.searchConfig)) return false;
	if (field.vectorConfig === undefined) return true;
	const vectorConfig = field.vectorConfig;
	if (!vectorConfig || typeof vectorConfig !== 'object' || Array.isArray(vectorConfig)) return false;
	const { dimension, flat } = vectorConfig;
	return hasOnlyProperties(vectorConfig, VECTOR_CONFIG_PROPERTIES)
		&& Number.isInteger(dimension)
		&& dimension >= 1
		&& dimension <= MAX_VECTOR_DIMENSION
		&& Boolean(flat)
		&& typeof flat === 'object'
		&& !Array.isArray(flat)
		&& hasOnlyProperties(flat, VECTOR_FLAT_PROPERTIES);
}

function formatIndexField(field) {
	if (field.order) return `${field.fieldPath} ${field.order}`;
	if (field.arrayConfig) return `${field.fieldPath} ${field.arrayConfig}`;
	if (field.vectorConfig) return `${field.fieldPath} VECTOR(${field.vectorConfig.dimension})`;

	const searchModes = ['textSpec', 'geoSpec']
		.filter((mode) => field.searchConfig[mode])
		.map((mode) => mode === 'textSpec' ? 'TEXT' : 'GEO');
	return `${field.fieldPath} SEARCH(${searchModes.join('+')})`;
}

function isValidLiveIndex(index, project, database) {
	if (!index || typeof index !== 'object' || Array.isArray(index)
		|| !hasOnlyProperties(index, LIVE_INDEX_PROPERTIES)) return false;
	const parsedName = parseIndexResourceName(index.name, project, database);
	if (!parsedName) return false;
	if (!INDEX_QUERY_SCOPES.has(index.queryScope)) return false;
	if (!Array.isArray(index.fields) || index.fields.length === 0 || !index.fields.every(isValidIndexField)) {
		return false;
	}
	if (!INDEX_STATES.has(index.state)) return false;
	if (index.apiScope !== undefined && !INDEX_API_SCOPES.has(index.apiScope)) return false;
	if (index.density !== undefined && !INDEX_DENSITIES.has(index.density)) return false;
	if (index.multikey !== undefined && typeof index.multikey !== 'boolean') return false;
	// The pinned Firebase CLI does not support unique indexes, and these
	// additional API options are not represented in the comparison key.
	if (index.unique !== undefined || index.shardCount !== undefined || index.searchIndexOptions !== undefined) {
		return false;
	}
	return true;
}

function indexKey(index, databaseEdition = DEFAULT_DATABASE_EDITION) {
	if (!index) {
		return '';
	}
	const collectionGroup = getCollectionGroup(index);
	if (!collectionGroup) return '';
	const defaultDensity = databaseEdition === DEFAULT_DATABASE_EDITION ? 'SPARSE_ALL' : 'DENSE';
	const options = {
		apiScope: index.apiScope === undefined ? 'ANY_API' : index.apiScope,
		density: index.density === undefined ? defaultDensity : index.density,
		multikey: index.multikey === undefined ? false : index.multikey,
	};
	const fields = normalizeIndexFields(index.fields, databaseEdition);
	const serializedFields = fields
		.map((field) => `${field.fieldPath}:${stableSerialize(field)}`)
		.join(',');
	return `${collectionGroup}|${index.queryScope || 'COLLECTION'}|${stableSerialize(options)}|${serializedFields}`;
}

/**
 * Compare declared indexes against what the live project actually has.
 *
 * `declaredState` is the state of a matching live index (`null` when absent).
 * A declared index that exists but is still building is reported as `deployed`
 * with a non-READY `state`, because "the deploy ran" and "the query works" are
 * different claims and only the second one restores the read path.
 *
 * @param {Array<Object>} declared
 * @param {Array<Object>} live
 * @param {string} [databaseEdition]
 * @returns {Array<{key: string, collectionGroup: string, queryScope: string, fields: Array, deployed: boolean, state: string|null, ready: boolean}>}
 */
function auditIndexes(declared, live, databaseEdition = DEFAULT_DATABASE_EDITION) {
	const liveByKey = new Map();
	for (const index of live || []) {
		const key = indexKey(index, databaseEdition);
		if (key) {
			liveByKey.set(key, index);
		}
	}

	return (declared || []).map((index) => {
		const key = indexKey(index, databaseEdition);
		const match = liveByKey.get(key);
		const state = match ? (match.state || null) : null;
		return {
			key,
			collectionGroup: index.collectionGroup,
			queryScope: index.queryScope || 'COLLECTION',
			fields: index.fields || [],
			deployed: Boolean(match),
			state,
			ready: state === READY_STATE,
		};
	});
}

/**
 * Reduce an audit to the counts that decide the exit code.
 *
 * @param {Array<Object>} audit
 * @returns {{totalDeclared: number, deployed: number, ready: number, missing: number, building: number, allReady: boolean}}
 */
function summarizeAudit(audit) {
	const entries = audit || [];
	const missing = entries.filter((entry) => !entry.deployed);
	const building = entries.filter((entry) => entry.deployed && !entry.ready);
	const ready = entries.filter((entry) => entry.ready);
	return {
		totalDeclared: entries.length,
		deployed: entries.length - missing.length,
		ready: ready.length,
		missing: missing.length,
		building: building.length,
		allReady: entries.length > 0 && missing.length === 0 && building.length === 0,
	};
}

function waitForAbort(promise, signal) {
	if (!signal) {
		return Promise.resolve(promise);
	}
	if (signal.aborted) {
		return Promise.reject(signal.reason || new Error('Request aborted'));
	}

	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason || new Error('Request aborted'));
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		signal.addEventListener('abort', onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/**
 * Load an authenticated HTTP request function using the Admin SDK's public
 * credential API. Native fetch keeps Firestore calls abortable at the readiness
 * deadline without relying on Firebase Admin's private HTTP client.
 *
 * @returns {{request: Function}}
 */
function loadAuthenticatedClient() {
	const admin = require('firebase-admin');

	const appOptions = {};
	const configuredProjectId = process.env.FIREBASE_PROJECT_ID
		|| process.env.GCLOUD_PROJECT
		|| process.env.GOOGLE_CLOUD_PROJECT;
	if (configuredProjectId) {
		appOptions.projectId = configuredProjectId;
	}
	if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
		appOptions.credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
	} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
		appOptions.credential = admin.credential.applicationDefault();
	}

	const app = admin.apps.length ? admin.app() : admin.initializeApp(appOptions);
	const credential = app.options.credential;
	const projectId = app.options.projectId;
	if (!credential || typeof credential.getAccessToken !== 'function') {
		throw new Error('Firebase Admin did not provide an OAuth credential.');
	}
	let cachedToken = null;
	let tokenPromise = null;
	const getAccessToken = (signal) => {
		if (cachedToken && cachedToken.expirationTime - Date.now() > TOKEN_REFRESH_THRESHOLD_MS) {
			return Promise.resolve(cachedToken.accessToken);
		}
		if (!tokenPromise) {
			tokenPromise = Promise.resolve()
				.then(() => credential.getAccessToken())
				.then((token) => {
					if (!token || typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in)) {
						throw new Error('Firebase Admin returned an invalid OAuth access token.');
					}
					cachedToken = {
						accessToken: token.access_token,
						expirationTime: Date.now() + token.expires_in * 1000,
					};
					return cachedToken.accessToken;
				})
				.finally(() => {
					tokenPromise = null;
				});
		}
		return waitForAbort(tokenPromise, signal);
	};

	return {
		request: async (method, url, options = {}) => {
			const token = await getAccessToken(options.signal);
			const headers = { authorization: `Bearer ${token}` };
			if (projectId) {
				headers['x-goog-user-project'] = projectId;
			}
			const response = await fetch(url, {
				method,
				headers,
				signal: options.signal,
			});
			if (!response.ok) {
				throw new Error(`Firestore returned HTTP ${response.status}.`);
			}
			return { data: await response.json() };
		},
	};
}

async function requestWithDeadline(request, url, opts) {
	const remainingMs = opts.deadline - opts.now();
	const timeoutError = new Error(opts.timeoutMessage);
	timeoutError.code = 'FIRESTORE_INDEX_TIMEOUT';
	if (remainingMs <= 0) {
		throw timeoutError;
	}

	const controller = new AbortController();
	let onAbort;
	const aborted = new Promise((resolve, reject) => {
		onAbort = () => reject(timeoutError);
		controller.signal.addEventListener('abort', onAbort, { once: true });
	});
	const timeout = setTimeout(() => {
		controller.abort(timeoutError);
		if (typeof opts.onTimeout === 'function') {
			try {
				opts.onTimeout(timeoutError);
			} catch {
				// Timeout handling must not replace the authoritative timeout result.
			}
		}
	}, remainingMs);

	try {
		return await Promise.race([
			Promise.resolve().then(() => request('GET', url, { signal: controller.signal })),
			aborted,
		]);
	} catch (error) {
		if (controller.signal.aborted || (error && error.code === 'FIRESTORE_INDEX_TIMEOUT')) {
			throw timeoutError;
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		controller.signal.removeEventListener('abort', onAbort);
	}
}

/**
 * Read the database edition used to resolve Firestore's implicit index defaults.
 *
 * @param {Object} opts
 * @param {string} opts.project
 * @param {string} opts.database
 * @param {Function} [opts.request]
 * @param {number} [opts.deadline]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.now]
 * @param {Function} [opts.onTimeout]
 * @returns {Promise<string>}
 */
async function fetchDatabaseEdition(opts = {}) {
	const { project, database } = opts;
	const request = opts.request || loadAuthenticatedClient().request;
	const now = opts.now || Date.now;
	const deadline = Number.isFinite(opts.deadline)
		? opts.deadline
		: now() + (Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS);
	const databaseId = database === '(default)' ? '(default)' : database;
	const url = `${FIRESTORE_API}/projects/${project}/databases/${databaseId}`;
	const expectedName = `projects/${project}/databases/${databaseId}`;
	let response;
	try {
		response = await requestWithDeadline(request, url, {
			deadline,
			now,
			onTimeout: opts.onTimeout,
			timeoutMessage: `Timed out while reading Firestore database metadata for project ${project}.`,
		});
	} catch (error) {
		if (error && error.code === 'FIRESTORE_INDEX_TIMEOUT') throw error;
		throw new Error(`Failed to read Firestore database metadata for project ${project}. `
			+ 'Check that you are authenticated and hold datastore.databases.get.', { cause: error });
	}

	const body = response && Object.prototype.hasOwnProperty.call(response, 'data')
		? response.data
		: response;
	if (!body || typeof body !== 'object' || Array.isArray(body) || body.name !== expectedName) {
		throw new Error(`Firestore returned invalid database metadata for project ${project}.`);
	}
	if (body.databaseEdition !== undefined
		&& (typeof body.databaseEdition !== 'string' || !DATABASE_EDITIONS.has(body.databaseEdition))) {
		throw new Error(`Firestore returned invalid database edition metadata for project ${project}.`);
	}
	return body.databaseEdition ?? DEFAULT_DATABASE_EDITION;
}

/**
 * Fetch the live index collection, which — unlike the Firebase CLI — includes
 * each index's build `state`.
 *
 * The composite-index collection is paginated, so a project with many declared
 * indexes can exceed one page. Every
 * page is followed; stopping at page one would report a genuinely READY index as
 * MISSING and hold the tool at exit 1 forever, which is the opposite of what an
 * operator running this during a P0 needs.
 *
 * @param {Object} opts
 * @param {string} opts.project
 * @param {string} opts.database
 * @param {Function} [opts.request]
 * @param {number} [opts.deadline] Absolute timestamp after which the listing aborts.
 * @param {number} [opts.timeoutMs] Total request budget when no deadline is supplied.
 * @param {Function} [opts.now]
 * @param {Function} [opts.onTimeout]
 * @returns {Promise<Array<Object>>}
 */
async function fetchLiveIndexes(opts = {}) {
	const { project, database } = opts;
	const request = opts.request || loadAuthenticatedClient().request;
	const now = opts.now || Date.now;
	const deadline = Number.isFinite(opts.deadline)
		? opts.deadline
		: now() + (Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS);
	const databaseId = database === '(default)' ? '(default)' : database;
	const all = [];
	let pageToken = null;
	let pages = 0;
	const seenPageTokens = new Set();

	for (;;) {
		const url = new URL(
			`${FIRESTORE_API}/projects/${project}/databases/${databaseId}/collectionGroups/-/indexes`,
		);
		url.searchParams.set('pageSize', String(INDEX_PAGE_SIZE));
		if (pageToken) {
			url.searchParams.set('pageToken', pageToken);
		}

		let response;
		try {
			response = await requestWithDeadline(request, url.toString(), {
				deadline,
				now,
				onTimeout: opts.onTimeout,
				timeoutMessage: `Timed out while listing Firestore indexes for project ${project}.`,
			});
		} catch (error) {
			if (error && error.code === 'FIRESTORE_INDEX_TIMEOUT') {
				throw error;
			}
			// The provider message can embed the project/database path; surface a
			// fixed message so no project detail leaks into CI output or the log.
			throw new Error(`Failed to list Firestore indexes for project ${project}. `
				+ 'Check that you are authenticated and hold datastore.indexes.list.', { cause: error });
		}

		// `AuthorizedHttpClient.send()` resolves with the parsed JSON body on `.data`;
		// a bare object is also accepted so tests can inject a plain payload.
		const body = response && response.data ? response.data : response;

		// A body with no `indexes` array is *indeterminate*, not "zero indexes".
		// Firestore returns `{}` for a project that genuinely has none, but an
		// unauthenticated call (or an intercepting proxy) can also answer `200 {}`.
		// Collapsing that into an empty list would report every declared index as
		// missing and send an operator to create indexes that already exist - the
		// same "assert a cause you cannot know" defect that made #1285 misleading in
		// the first place. Refuse to audit instead. This runs per page so a
		// truncated response is refused too, rather than being treated as the last
		// page of an authoritative list.
		if (!body || !Array.isArray(body.indexes)) {
			throw new Error(`Firestore returned no index list for project ${project}. `
				+ 'The listing could not be read authoritatively, so the declared indexes '
				+ 'cannot be reported as missing or ready. Verify authentication '
				+ '(FIREBASE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS / ADC) and retry.');
		}
		for (const index of body.indexes) {
			if (!isValidLiveIndex(index, project, databaseId)) {
				throw new Error(`Firestore returned an invalid or out-of-scope index record for project ${project}. `
					+ 'The listing could not be read authoritatively, so declared indexes cannot be reported as missing or ready.');
			}
		}

		all.push(...body.indexes);
		pages += 1;

		if (Object.prototype.hasOwnProperty.call(body, 'nextPageToken')
			&& typeof body.nextPageToken !== 'string') {
			throw new Error(`Firestore returned a malformed pagination token for project ${project}. `
				+ 'The listing could not be read authoritatively, so the declared indexes cannot be reported as missing or ready.');
		}
		const next = typeof body.nextPageToken === 'string' && body.nextPageToken.length > 0
			? body.nextPageToken
			: null;
		if (!next) {
			break;
		}
		if (seenPageTokens.has(next)) {
			throw new Error(`Firestore repeated a pagination token for project ${project}. `
				+ 'The listing is being truncated, so the declared indexes cannot be reported as missing or ready.');
		}
		seenPageTokens.add(next);

		if (pages >= MAX_INDEX_PAGES) {
			// Discarding the pages already read and refusing is deliberate: a
			// partial list would report the unread suffix as MISSING, which is the
			// false alarm this tool exists to avoid.
			throw new Error(`Firestore kept paging the index list for project ${project} `
				+ `past ${MAX_INDEX_PAGES} pages. The listing is being truncated, so the `
				+ 'declared indexes cannot be reported as missing or ready.');
		}

		pageToken = next;
	}

	return all;
}

/**
 * Resolve the firebase-tools JS entry to drive from Node.
 *
 * `runDeploy` executes the result with `process.execPath`, so this must always be
 * a real JavaScript file. `node_modules/.bin/firebase` is a shell shim and is
 * deliberately not a fallback: handing it to `node` would fail on the shim's
 * shell syntax and report a CLI failure that never happened.
 *
 * @param {string} [repoRoot]
 * @returns {string}
 */
function resolveFirebaseBin(repoRoot = path.join(__dirname, '..')) {
	const candidates = [path.join(repoRoot, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js')];

	try {
		candidates.push(require.resolve('firebase-tools/lib/bin/firebase.js'));
	} catch {
		// Hoisted/pnpm layouts resolve through the package entry instead.
	}

	try {
		const pkgJson = require.resolve('firebase-tools/package.json');
		candidates.push(path.join(path.dirname(pkgJson), 'lib', 'bin', 'firebase.js'));
	} catch {
		// firebase-tools is not installed; nothing further to try.
	}

	const resolved = candidates.find((candidate) => fs.existsSync(candidate));
	if (resolved) {
		return resolved;
	}

	throw new Error('Unable to locate the firebase-tools CLI entry '
		+ '(firebase-tools/lib/bin/firebase.js). Run `pnpm install --frozen-lockfile` and retry.');
}

/**
 * Run `firebase deploy --only firestore:indexes`.
 *
 * @param {Object} opts
 * @param {string} opts.project
 * @param {string} [opts.binPath]
 * @param {string} [opts.cwd]
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
function runDeploy(opts = {}) {
	const binPath = opts.binPath || resolveFirebaseBin(opts.cwd || path.join(__dirname, '..'));
	const timeoutMs = Number.isSafeInteger(opts.timeoutMs) && opts.timeoutMs > 0
		? opts.timeoutMs
		: DEFAULT_DEPLOY_TIMEOUT_MS;
	const cliConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-index-cli-'));
	try {
		const env = { ...process.env, XDG_CONFIG_HOME: cliConfigHome };
		// The Firebase CLI must use the same Admin credential as the REST audit.
		// Isolate its cached login store and remove the legacy token override so
		// neither can silently select a different deploy identity.
		delete env.FIREBASE_TOKEN;
		delete env.FIREBASE_SERVICE_ACCOUNT_JSON;
		if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
			const credentialPath = path.join(cliConfigHome, 'service-account.json');
			fs.writeFileSync(credentialPath, process.env.FIREBASE_SERVICE_ACCOUNT_JSON, { mode: 0o600 });
			env.GOOGLE_APPLICATION_CREDENTIALS = credentialPath;
		}

		const result = spawnSync(process.execPath, [
			binPath,
			'deploy',
			'--only',
			'firestore:indexes',
			'--project',
			opts.project,
		], {
			encoding: 'utf8',
			maxBuffer: 10 * 1024 * 1024,
			timeout: timeoutMs,
			cwd: opts.cwd || path.join(__dirname, '..'),
			env,
		});

		if (result.error) {
			if (result.error.code === 'ETIMEDOUT') {
				throw new Error(`Firebase CLI deploy timed out after ${timeoutMs}ms.`, { cause: result.error });
			}
			throw new Error(`Failed to launch firebase CLI: ${result.error.message}`, { cause: result.error });
		}
		return {
			status: result.status,
			stdout: (result.stdout || '').trim(),
			stderr: (result.stderr || '').trim(),
		};
	} finally {
		fs.rmSync(cliConfigHome, { recursive: true, force: true });
	}
}

/**
 * Record a timestamped audit entry. Never writes credentials or provider output.
 *
 * @param {Object} entry
 * @returns {string} recorded line
 */
function recordDeployLog(entry) {
	const {
		project,
		database,
		mode,
		summary,
		logFile = DEFAULT_LOG_FILE,
	} = entry;
	const timestamp = new Date().toISOString();
	const logLine = `[${timestamp}] PROJECT=${project} DATABASE=${database} MODE=${mode} `
		+ `DECLARED=${summary.totalDeclared} DEPLOYED=${summary.deployed} READY=${summary.ready} `
		+ `MISSING=${summary.missing} NOT_READY=${summary.building} ALL_READY=${summary.allReady}\n`;

	const logDir = path.dirname(path.resolve(logFile));
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}
	fs.appendFileSync(logFile, logLine, 'utf8');
	return logLine;
}

function sleep(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * CLI main execution.
 *
 * Exit codes: 0 when every declared index is READY (or nothing is declared),
 * 1 when any index is missing or not yet READY, 2 on an operational error.
 *
 * `argv` and `deps` exist so the exit codes and the `--apply` wait loop can be
 * tested without credentials, a network, the real CLI, or a real clock. The CLI
 * path passes neither and behaves exactly as before.
 *
 * @param {string[]} [argv]
 * @param {{request?: Function|null, runDeploy?: Function, pollIntervalMs?: number, now?: Function, onTimeout?: Function}} [deps]
 * @returns {Promise<number>}
 */
async function main(argv = process.argv.slice(2), deps = {}) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`error: ${error.message}`);
		return 2;
	}

	if (args.help) {
		console.log(`
Cabros Bot - Firestore Composite Index Audit & Deploy Tool

Audits the composite indexes declared in firestore.indexes.json against the live
project and, with --apply, deploys them. Dry-run by default.

A declaration in firestore.indexes.json does not create an index in the live
project, and Firestore rejects a query until the index build reaches READY. This
tool reads the build state directly from the Firestore REST API (the Firebase
CLI's \`firestore:indexes\` output omits it) and exits non-zero while any declared
index is missing or not READY.

Usage:
  node scripts/deploy-firestore-indexes.js [options]

Options:
  --project <id>      Firebase project id (default: ${DEFAULT_PROJECT})
  --database <id>     Firestore database id (default: ${DEFAULT_DATABASE}; overrides are dry-run only)
  --indexes <path>    Path to the index template (default: firestore.indexes.json; overrides are dry-run only)
  --timeout-ms <n>    Readiness wait budget after --apply (default: ${10 * 60 * 1000})
  --dry-run           Report only (default)
  --apply             Deploy firebase.json indexes for the default database, then wait for READY
  --log-file <path>   Audit log path (default: ${DEFAULT_LOG_FILE})
  --json              Output the result as JSON
  --help, -h          Show this help message

Requires Application Default Credentials with datastore.databases.get and datastore.indexes.list.
--apply also needs the Firebase CLI's Firestore index deployment permissions. Supported credential
sources are FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or the runtime ADC provider.
The CLI login store and FIREBASE_TOKEN are ignored so deployment and REST auditing use the same credential.
`);
		return 0;
	}

	if (args.apply && (args.database !== DEFAULT_DATABASE || args.indexesPath !== INDEXES_PATH)) {
		console.error('error: --apply deploys only the default database and firestore.indexes.json from firebase.json; '
			+ 'use dry-run to audit a custom database or template.');
		return 2;
	}

	let declared;
	try {
		declared = readDeclaredIndexes(args.indexesPath);
	} catch (error) {
		console.error(`error: ${error.message}`);
		return 2;
	}

	if (declared.length === 0) {
		const payload = { mode: args.apply ? 'apply' : 'dry-run', project: args.project, database: args.database, indexes: [] };
		if (args.json) {
			console.log(JSON.stringify(payload, null, 2));
		} else {
			console.log('No composite indexes are declared; nothing to audit or deploy.');
		}
		return 0;
	}

	const request = deps.request !== undefined
		? deps.request
		: (() => {
			try {
				return loadAuthenticatedClient().request;
			} catch {
				return null;
			}
		})();

	if (!request) {
		console.error('error: unable to build an authenticated Firestore client from the '
			+ 'current environment (FIREBASE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS / ADC).');
		return 2;
	}

	const deploy = deps.runDeploy || runDeploy;
	const pollIntervalMs = deps.pollIntervalMs === undefined ? DEFAULT_POLL_INTERVAL_MS : deps.pollIntervalMs;
	const now = deps.now || Date.now;

	let deployed = false;
	let deployStatus = null;
	if (args.apply) {
		try {
			const result = deploy({ project: args.project });
			deployStatus = result.status;
			if (result.status !== 0) {
				// Surface the CLI's own message: this is the deploy failing, not
				// an index audit, and the operator needs its reason.
				console.error(`error: firebase deploy --only firestore:indexes failed (exit ${result.status}).`);
				if (result.stderr) {
					console.error(result.stderr);
				}
				return 2;
			}
			deployed = true;
			if (!args.json) {
				console.log(`Deploy finished for project ${args.project}; waiting for index builds to reach READY...`);
			}
		} catch (error) {
			console.error(`error: ${error.message}`);
			return 2;
		}
	}

	// Poll until every declared index is READY or the budget is exhausted. Without
	// this the script would exit 0 the instant the CLI returns, while reads are
	// still being rejected.
	const deadline = now() + args.timeoutMs;
	let audit;
	let summary;
	const wait = deps.sleep || sleep;
	let databaseEdition;
	try {
		databaseEdition = await fetchDatabaseEdition({
			project: args.project,
			database: args.database,
			request,
			deadline: args.apply ? deadline : undefined,
			now,
			onTimeout: deps.onTimeout,
		});
	} catch (error) {
		console.error(`error: ${error.message}`);
		return 2;
	}

	for (;;) {
		if (args.apply && summary && now() >= deadline) {
			break;
		}

		let live;
		try {
			live = await fetchLiveIndexes({
				project: args.project,
				database: args.database,
				request,
				deadline: args.apply ? deadline : undefined,
				now,
				onTimeout: deps.onTimeout,
			});
		} catch (error) {
			console.error(`error: ${error.message}`);
			return 2;
		}

		audit = auditIndexes(declared, live, databaseEdition);
		summary = summarizeAudit(audit);
		const remainingMs = deadline - now();
		if (summary.allReady || !args.apply || remainingMs <= 0) {
			break;
		}
		await wait(Math.min(pollIntervalMs, remainingMs));
	}

	const payload = {
		mode: args.apply ? 'apply' : 'dry-run',
		project: args.project,
		database: args.database,
		deployed,
		deployStatus,
		summary,
		indexes: audit.map((entry) => ({
			collectionGroup: entry.collectionGroup,
			queryScope: entry.queryScope,
			fields: entry.fields,
			deployed: entry.deployed,
			state: entry.state,
			ready: entry.ready,
		})),
	};

	if (args.apply) {
		try {
			recordDeployLog({
				project: args.project,
				database: args.database,
				mode: 'apply',
				summary,
				logFile: args.logFile,
			});
		} catch (error) {
			console.error(`warning: failed to write audit log ${args.logFile}: ${error.message}`);
		}
	}

	if (args.json) {
		console.log(JSON.stringify(payload, null, 2));
	} else {
		for (const entry of payload.indexes) {
			const status = entry.ready ? 'READY' : (entry.deployed ? (entry.state || 'UNKNOWN') : 'MISSING');
			const fields = entry.fields.map(formatIndexField).join(', ');
			console.log(`${entry.deployed ? ' ' : '!'} ${status.padEnd(8)} ${entry.collectionGroup} (${entry.queryScope}): ${fields}`);
		}
		console.log(
			`\n${summary.ready}/${summary.totalDeclared} declared indexes READY `
			+ `(${summary.missing} missing, ${summary.building} not ready).`,
		);
		if (!summary.allReady) {
			console.log('Queries using a missing or still-building index are rejected with FAILED_PRECONDITION.');
		}
	}

	return summary.allReady ? 0 : 1;
}

module.exports = {
	DEFAULT_DATABASE,
	DEFAULT_POLL_INTERVAL_MS,
	DEFAULT_PROJECT,
	DEFAULT_DATABASE_EDITION,
	INDEX_PAGE_SIZE,
	MAX_INDEX_PAGES,
	READY_STATE,
	auditIndexes,
	fetchDatabaseEdition,
	fetchLiveIndexes,
	indexKey,
	loadAuthenticatedClient,
	main,
	parseArgs,
	readDeclaredIndexes,
	recordDeployLog,
	resolveFirebaseBin,
	runDeploy,
	summarizeAudit,
};

if (require.main === module) {
	main(process.argv.slice(2), {
		onTimeout: () => {
			// Firebase Admin's public credential API cannot cancel a stalled token
			// exchange. If that socket keeps the one-shot CLI alive after the request
			// deadline, force the process down after giving stderr time to flush.
			const forcedExit = setTimeout(() => process.exit(2), STALLED_CREDENTIAL_EXIT_GRACE_MS);
			forcedExit.unref();
		},
	})
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(`error: ${error && error.message ? error.message : error}`);
			process.exitCode = 2;
		});
}
