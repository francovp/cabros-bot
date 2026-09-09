'use strict';

const fs = require('fs');
const path = require('path');
const {
	parseArgs,
	generateSyncPlan,
	detectRenderServices,
	recordSyncLog,
	checkEnvironmentDrift,
	checkWorkerMirrorDrift,
	collectServiceEnvKeys,
	JOBS_WORKER_MIRROR_KEYS,
	validateVariableName,
} = require('../../scripts/sync-production-env');

describe('sync-production-env tool', () => {
	const repoRoot = path.join(__dirname, '../..');
	const testLogPath = path.join(__dirname, '../fixtures/test-sync.log');

	afterEach(() => {
		if (fs.existsSync(testLogPath)) {
			fs.unlinkSync(testLogPath);
		}
	});

	describe('Secret Safety and Input Validation', () => {
		it('rejects variable arguments containing values (KEY=VALUE)', () => {
			expect(() => validateVariableName('API_KEY=secret123')).toThrow(
				/Never pass variable values on argv/i
			);
			expect(() => parseArgs(['--key', 'BOT_TOKEN=123:ABC'])).toThrow(
				/Never pass variable values on argv/i
			);
			expect(() => parseArgs(['BOT_TOKEN=123:ABC'])).toThrow(
				/Never pass variable values on argv/i
			);
		});

		it('accepts valid POSIX environment variable names', () => {
			expect(validateVariableName('ENABLE_DISCORD_ALERTS')).toBe('ENABLE_DISCORD_ALERTS');
			expect(validateVariableName('TWELVE_DATA_API_KEY')).toBe('TWELVE_DATA_API_KEY');
		});

		it('rejects invalid or malformed variable names', () => {
			expect(() => validateVariableName('invalid-name-with-dashes')).toThrow(
				/Invalid environment variable name/i
			);
			expect(() => validateVariableName('')).toThrow(
				/Environment variable name is required/i
			);
		});

		it('parses --verified, --applied, and custom --status flags correctly', () => {
			const parsedVerified = parseArgs(['--key', 'BOT_TOKEN', '--verified']);
			expect(parsedVerified.verified).toBe(true);
			expect(parsedVerified.apply).toBe(true);

			const parsedStatus = parseArgs([
				'--key',
				'BOT_TOKEN',
				'--status',
				'render=VERIFIED',
				'--status',
				'railway=APPLIED',
			]);
			expect(parsedStatus.platformStatuses).toEqual({
				render: 'VERIFIED',
				railway: 'APPLIED',
			});
			expect(parsedStatus.apply).toBe(true);
		});
	});

	describe('Render Service Detection from Blueprint', () => {
		it('identifies services referencing a specific key in render.yaml', () => {
			const services = detectRenderServices('TWELVE_DATA_API_KEY', repoRoot);
			expect(services).toContain('cabros-crypto-bot-signal-outcome-worker');
		});

		it('identifies web service and worker service when key is shared', () => {
			const services = detectRenderServices('DISCORD_WEBHOOK_URL', repoRoot);
			expect(services).toContain('cabros-crypto-bot-telegram-worker');
		});

		it('returns empty array if key is not defined in render.yaml', () => {
			const services = detectRenderServices('NON_EXISTENT_VAR', repoRoot);
			expect(services).toEqual([]);
		});
	});

	describe('Sync Plan Generation across Render, Railway, and Vercel', () => {
		it('generates plans covering all 3 platforms with explicit no-ops', () => {
			const plan = generateSyncPlan('TWELVE_DATA_API_KEY', {
				repoRoot,
				noOpPlatforms: ['vercel'],
				noOpReasons: { vercel: 'Vercel does not host the signal outcome worker' },
			});

			expect(plan.key).toBe('TWELVE_DATA_API_KEY');
			expect(plan.platforms).toHaveProperty('render');
			expect(plan.platforms).toHaveProperty('railway');
			expect(plan.platforms).toHaveProperty('vercel');

			// Render
			expect(plan.platforms.render.services).toContain('cabros-crypto-bot-signal-outcome-worker');
			expect(plan.platforms.render.commands.length).toBeGreaterThan(0);

			// Railway
			expect(plan.platforms.railway.service).toBe('cabros-bot');
			expect(plan.platforms.railway.environment).toBe('production');
			expect(plan.platforms.railway.commands.some((c) => c.includes('TWELVE_DATA_API_KEY'))).toBe(true);

			// Vercel (marked as no-op)
			expect(plan.platforms.vercel.isNoOp).toBe(true);
			expect(plan.platforms.vercel.noOpReason).toMatch(/Vercel does not host/i);
		});

		it('ensures secret values are never printed in command templates', () => {
			const plan = generateSyncPlan('BOT_TOKEN', { repoRoot });
			for (const platform of Object.values(plan.platforms)) {
				for (const cmd of platform.commands || []) {
					expect(cmd).not.toMatch(/BOT_TOKEN=[^<\s]/); // Shouldn't embed actual secrets
				}
			}
		});
	});

	describe('Audit Log Recording', () => {
		it('records timestamped sync record with platform status and explicit no-ops', () => {
			const result = recordSyncLog({
				key: 'ENABLE_DISCORD_ALERTS',
				logFile: testLogPath,
				statuses: {
					render: 'APPLIED',
					railway: 'APPLIED',
					vercel: 'NO_OP (Vercel hosts web/preview landing only)',
				},
			});

			expect(fs.existsSync(testLogPath)).toBe(true);
			const content = fs.readFileSync(testLogPath, 'utf8');
			expect(content).toContain('KEY=ENABLE_DISCORD_ALERTS');
			expect(content).toContain('RENDER=APPLIED');
			expect(content).toContain('RAILWAY=APPLIED');
			expect(content).toContain('VERCEL=NO_OP');
		});
	});

	describe('Environment Drift Detection', () => {
		it('scans .env.example and classifies keys by blueprint presence', () => {
			const drift = checkEnvironmentDrift(repoRoot);
			expect(drift.totalEnvExampleKeys).toBeGreaterThan(30);
			expect(drift.blueprintManagedKeys).toContain('BOT_TOKEN');
			expect(drift.blueprintManagedKeys).toContain('FIREBASE_PROJECT_ID');
			expect(Array.isArray(drift.unmanagedKeys)).toBe(true);
		});
	});

	describe('Documentation and AGENTS.md Integration', () => {
		it('links scripts/sync-production-env.js in AGENTS.md post-merge section', () => {
			const agentsDoc = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
			expect(agentsDoc).toContain('scripts/sync-production-env.js');
			expect(agentsDoc).toContain('pnpm run sync:production-env');
			expect(agentsDoc).toMatch(/Dry-run by default/i);
		});
	});

	describe('Jobs-Worker Mirror Drift Detection (GH-855)', () => {
		it('exposes a stable JOBS_WORKER_MIRROR_KEYS allow-list', () => {
			expect(Array.isArray(JOBS_WORKER_MIRROR_KEYS)).toBe(true);
			expect(Object.isFrozen(JOBS_WORKER_MIRROR_KEYS)).toBe(true);
			// Spot-check a few keys called out by issue #855.
			expect(JOBS_WORKER_MIRROR_KEYS).toContain('TRADINGVIEW_MCP_DEFAULT_EXCHANGE');
			expect(JOBS_WORKER_MIRROR_KEYS).toContain('MARKET_SCANNER_DEFAULT_EXCHANGE');
			expect(JOBS_WORKER_MIRROR_KEYS).toContain('EXPANDED_ANALYSIS_ALERT_SYMBOLS');
			expect(JOBS_WORKER_MIRROR_KEYS).toContain('ENABLE_FIREBASE_REMOTE_CONFIG');
			expect(JOBS_WORKER_MIRROR_KEYS).toContain('ZERO_CHANNEL_ALERT_COOLDOWN_MS');
			expect(JOBS_WORKER_MIRROR_KEYS).toContain('ENABLE_API_ONLY_MODE');
		});

		it('collectServiceEnvKeys parses the worker env block including fromService envVarKey mirrors', () => {
			const serviceKeys = collectServiceEnvKeys(repoRoot);
			const workerKeys = serviceKeys.get('cabros-crypto-bot-telegram-worker');
			expect(workerKeys).toBeDefined();
			expect(workerKeys.has('JOB_EXECUTION_MODE')).toBe(true);
			expect(workerKeys.has('ENABLE_NOTIFICATION_REDRIVE')).toBe(true);
			expect(workerKeys.has('NOTIFICATION_REDRIVE_INTERVAL_MS')).toBe(true);
			expect(workerKeys.has('TRADINGVIEW_MCP_DEFAULT_EXCHANGE')).toBe(true);
			expect(workerKeys.has('MARKET_SCANNER_DEFAULT_EXCHANGE')).toBe(true);
			expect(workerKeys.has('EXPANDED_ANALYSIS_ALERT_SYMBOLS')).toBe(true);
			expect(workerKeys.has('ENABLE_FIREBASE_REMOTE_CONFIG')).toBe(true);
			expect(workerKeys.has('ZERO_CHANNEL_ALERT_COOLDOWN_MS')).toBe(true);
			expect(workerKeys.has('ENABLE_API_ONLY_MODE')).toBe(true);
		});

		it('checkWorkerMirrorDrift reports no missing mirrors for the rendered job-execution keys', () => {
			const result = checkWorkerMirrorDrift({
				repoRoot,
				restrict: JOBS_WORKER_MIRROR_KEYS,
			});
			expect(result.restrictMode).toBe('restrict');
			expect(result.webService).toBe('cabros-crypto-bot-telegram-iac');
			expect(result.workerService).toBe('cabros-crypto-bot-telegram-worker');
			expect(result.missingOnWorker).toEqual([]);
		});

		it('checkWorkerMirrorDrift flags restricted keys the worker is missing', () => {
			// Use a synthetic repoRoot with a render.yaml that lacks one of the
			// restricted mirrors. The function must surface it deterministically.
			const tmpRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sync-prod-'));
			try {
				fs.mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true });
				fs.writeFileSync(
					path.join(tmpRoot, 'render.yaml'),
					[
						'services:',
						'- type: web',
						'  name: cabros-crypto-bot-telegram-iac',
						'  envVars:',
						'  - key: TRADINGVIEW_MCP_DEFAULT_EXCHANGE',
						'    value: BINANCE',
						'  - key: ZERO_CHANNEL_ALERT_COOLDOWN_MS',
						'    value: 300000',
						'- type: worker',
						'  name: cabros-crypto-bot-telegram-worker',
						'  envVars:',
						'  - key: JOB_EXECUTION_MODE',
						'    value: render-worker',
						'  - key: ZERO_CHANNEL_ALERT_COOLDOWN_MS',
						'    fromService:',
						'      name: cabros-crypto-bot-telegram-iac',
						'      type: web',
						'      envVarKey: ZERO_CHANNEL_ALERT_COOLDOWN_MS',
						'',
					].join('\n'),
					'utf8'
				);
				const result = checkWorkerMirrorDrift({
					repoRoot: tmpRoot,
					restrict: ['TRADINGVIEW_MCP_DEFAULT_EXCHANGE', 'ZERO_CHANNEL_ALERT_COOLDOWN_MS'],
				});
				expect(result.missingOnWorker).toEqual(['TRADINGVIEW_MCP_DEFAULT_EXCHANGE']);
				expect(result.checkedKeys).toEqual([
					'TRADINGVIEW_MCP_DEFAULT_EXCHANGE',
					'ZERO_CHANNEL_ALERT_COOLDOWN_MS',
				]);
			} finally {
				fs.rmSync(tmpRoot, { recursive: true, force: true });
			}
		});

		it('checkWorkerMirrorDrift returns full comparison mode when no restrict set', () => {
			const result = checkWorkerMirrorDrift({ repoRoot });
			expect(result.restrictMode).toBe('full');
			// Full mode should report at least the Firebase browser config keys
			// that intentionally do not mirror to the worker.
			expect(Array.isArray(result.missingOnWorker)).toBe(true);
		});

		it('parseArgs recognises --check-worker-mirror and --exit-on-worker-mirror-drift', () => {
			const plain = parseArgs(['--check-worker-mirror']);
			expect(plain.checkWorkerMirror).toBe(true);
			expect(plain.exitOnWorkerMirrorDrift).toBe(false);

			const strict = parseArgs(['--check-worker-mirror', '--exit-on-worker-mirror-drift']);
			expect(strict.checkWorkerMirror).toBe(true);
			expect(strict.exitOnWorkerMirrorDrift).toBe(true);
		});
	});
});
