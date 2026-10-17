'use strict';

const fs = require('fs');
const path = require('path');
const {
	parseArgs,
	generateSyncPlan,
	detectRenderServices,
	recordSyncLog,
	checkEnvironmentDrift,
	checkJobWorkerParity,
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

	describe('Job Worker Blueprint Parity (#855)', () => {
		it('detects missing job worker mirrors when web declares job execution env keys', () => {
			// Mock blueprint where web declares MARKET_SCANNER_DEFAULT_EXCHANGE but worker does not mirror it
			const mockBlueprint = `
services:
- type: web
  name: cabros-crypto-bot-telegram-iac
  envVars:
  - key: MARKET_SCANNER_DEFAULT_EXCHANGE
    value: BINANCE
- type: worker
  name: cabros-crypto-bot-telegram-worker
  envVars:
  - key: JOB_EXECUTION_MODE
    value: render-worker
`;
			const tempDir = path.join(__dirname, '../fixtures/temp-blueprint-test');
			fs.mkdirSync(tempDir, { recursive: true });
			fs.writeFileSync(path.join(tempDir, 'render.yaml'), mockBlueprint, 'utf8');

			try {
				const result = checkJobWorkerParity(tempDir);
				expect(result.valid).toBe(false);
				expect(result.missingKeys).toContain('MARKET_SCANNER_DEFAULT_EXCHANGE');
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('validates that all declared job execution keys on web are mirrored on worker', () => {
			const mockBlueprint = `
services:
- type: web
  name: cabros-crypto-bot-telegram-iac
  envVars:
  - key: MARKET_SCANNER_DEFAULT_EXCHANGE
    value: BINANCE
- type: worker
  name: cabros-crypto-bot-telegram-worker
  envVars:
  - key: MARKET_SCANNER_DEFAULT_EXCHANGE
    fromService:
      name: cabros-crypto-bot-telegram-iac
      type: web
      envVarKey: MARKET_SCANNER_DEFAULT_EXCHANGE
`;
			const tempDir = path.join(__dirname, '../fixtures/temp-blueprint-test-valid');
			fs.mkdirSync(tempDir, { recursive: true });
			fs.writeFileSync(path.join(tempDir, 'render.yaml'), mockBlueprint, 'utf8');

			try {
				const result = checkJobWorkerParity(tempDir);
				expect(result.valid).toBe(true);
				expect(result.mirroredKeys).toContain('MARKET_SCANNER_DEFAULT_EXCHANGE');
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('passes parity check for repository render.yaml blueprint', () => {
			const result = checkJobWorkerParity(repoRoot);
			expect(result.valid).toBe(true);
			expect(result.missingKeys).toHaveLength(0);
			expect(result.mirroredKeys.length).toBeGreaterThan(0);
		});
	});
});
