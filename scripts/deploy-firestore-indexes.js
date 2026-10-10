#!/usr/bin/env node
'use strict';

/**
 * Audits and deploys the composite indexes declared in `firestore.indexes.json`.
 *
 * Why this exists (issue #1285): the stored-alert read paths order by
 * `receivedAt` **and** `FieldPath.documentId()`. Firestore applies only a *free*
 * final `__name__` **ascending** sort and never merges single-field indexes, so
 * the descending tie-breaker needs the composite index
 * `alerts { receivedAt DESC, __name__ DESC }`. A declaration in
 * `firestore.indexes.json` is the *repository template of record only* — it does
 * not create anything in the live project. Adding it to the file and merging is
 * therefore not a fix, and reading is still rejected with FAILED_PRECONDITION
 * until someone runs the deploy. This script makes that step runnable and
 * auditable instead of folklore.
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
 *    distinguish READY from BUILDING — which is how a completed deploy still
 *    leaves every read returning 503. The raw REST collection returns `state`,
 *    so that is what this script reads.
 *
 * 2. **Dry-run by default, and it exits non-zero while a required index is not
 *    READY.** A deploy command that reports success while the read path is still
 *    broken is exactly the failure mode this issue documents, so readiness is
 *    the exit condition, not the exit code of the CLI call.
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
const DEFAULT_LOG_FILE = '.firestore-indexes-deploy.log';
const INDEXES_PATH = path.resolve(__dirname, '..', 'firestore.indexes.json');
const FIRESTORE_API = 'https://firestore.googleapis.com/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;
const STALLED_CREDENTIAL_EXIT_GRACE_MS = 1000;

/**
 * `READY` is the only state a query can actually use. The API also reports
 * CREATING/BUILDING (still building), NEEDS_REPAIR/ERROR (deployed but
 * unusable), DISABLED, and STATE_UNSPECIFIED. Anything not READY is reported as
 * not ready rather than assumed usable.
 */
const READY_STATE = 'READY';

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
 * @returns {Array<{collectionGroup: string, queryScope: string, fields: Array<{fieldPath: string, order: string}>}>}
 */
function readDeclaredIndexes(indexesPath = INDEXES_PATH) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(indexesPath, 'utf8'));
	} catch (error) {
		throw new Error(`Failed to read ${indexesPath}: ${error.message}`, { cause: error });
	}

	const indexes = parsed && Array.isArray(parsed.indexes) ? parsed.indexes : [];
	return indexes.map((index) => ({
		collectionGroup: index.collectionGroup,
		queryScope: index.queryScope || 'COLLECTION',
		fields: Array.isArray(index.fields)
			? index.fields.map((field) => ({
				fieldPath: field.fieldPath,
				order: field.order,
			}))
			: [],
	}));
}

/**
 * Stable identity for an index: collection, scope, and the ordered field list.
 * Order matters — `receivedAt DESC, __name__ DESC` is a different index from
 * `receivedAt DESC, __name__ ASC` — so the comparison is on the ordered list.
 *
 * @param {Object} index
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

function normalizeIndexFields(indexFields) {
	const fields = Array.isArray(indexFields) ? [...indexFields] : [];
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

function indexKey(index) {
	if (!index || !index.collectionGroup) {
		return '';
	}
	const fields = normalizeIndexFields(index.fields);
	const serializedFields = fields
		.map((field) => `${field.fieldPath}:${stableSerialize(field)}`)
		.join(',');
	return `${index.collectionGroup}|${index.queryScope || 'COLLECTION'}|${serializedFields}`;
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
 * @returns {Array<{key: string, collectionGroup: string, queryScope: string, fields: Array, deployed: boolean, state: string|null, ready: boolean}>}
 */
function auditIndexes(declared, live) {
	const liveByKey = new Map();
	for (const index of live || []) {
		const key = indexKey(index);
		if (key) {
			liveByKey.set(key, index);
		}
	}

	return (declared || []).map((index) => {
		const key = indexKey(index);
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

/**
 * Fetch the live index collection, which — unlike the Firebase CLI — includes
 * each index's build `state`.
 *
 * The collection is paginated, and the listing also carries Firestore's
 * automatic single-field indexes alongside the declared composites, so a project
 * with a modest number of declared composites can still exceed one page. Every
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
		const remainingMs = deadline - now();
		if (remainingMs <= 0) {
			const error = new Error(`Timed out while listing Firestore indexes for project ${project}.`);
			error.code = 'FIRESTORE_INDEX_TIMEOUT';
			throw error;
		}

		const controller = new AbortController();
		const timeoutError = new Error(`Timed out while listing Firestore indexes for project ${project}.`);
		timeoutError.code = 'FIRESTORE_INDEX_TIMEOUT';
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
			response = await Promise.race([
				Promise.resolve().then(() => request('GET', url.toString(), { signal: controller.signal })),
				aborted,
			]);
		} catch (error) {
			if (controller.signal.aborted || error.code === 'FIRESTORE_INDEX_TIMEOUT') {
				throw timeoutError;
			}
			// The provider message can embed the project/database path; surface a
			// fixed message so no project detail leaks into CI output or the log.
			throw new Error(`Failed to list Firestore indexes for project ${project}. `
				+ 'Check that you are authenticated and hold datastore.indexes.list.', { cause: error });
		} finally {
			clearTimeout(timeout);
			controller.signal.removeEventListener('abort', onAbort);
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

		all.push(...body.indexes);
		pages += 1;

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

Requires Application Default Credentials with datastore.indexes permissions. Supported sources are
FIREBASE_SERVICE_ACCOUNT_JSON, GOOGLE_APPLICATION_CREDENTIALS, or the runtime ADC provider. The CLI
login store and FIREBASE_TOKEN are ignored so deployment and REST auditing use the same credential.
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

		audit = auditIndexes(declared, live);
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
			const fields = entry.fields.map((field) => `${field.fieldPath} ${field.order}`).join(', ');
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
	INDEX_PAGE_SIZE,
	MAX_INDEX_PAGES,
	READY_STATE,
	auditIndexes,
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
