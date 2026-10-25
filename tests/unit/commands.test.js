'use strict';

jest.mock('../../src/services/jobs/JobService', () => ({
	jobService: {
		createJob: jest.fn(),
		listJobs: jest.fn(),
		getJob: jest.fn(),
		validateJobRequest: jest.fn(),
	},
}));

jest.mock('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor', () => ({
	getNewsMonitor: jest.fn(),
}));

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		getStatus: jest.fn(() => ({ status: 'ready', lastCheckedAt: null })),
		syncDurableStatus: jest.fn().mockResolvedValue(null),
		getScannerErrorCategoryCounts: jest.fn(() => ({})),
		getToolMetrics: jest.fn(() => ({})),
		getVolumeConfirmationStatus: jest.fn(() => ({ status: 'ready' })),
	},
}));

jest.mock('../../src/services/monitoring/SentryService', () => ({
	startInactiveSpan: jest.fn(() => ({ span: true })),
	endSpan: jest.fn(),
	captureRuntimeError: jest.fn(),
	isProfilingEnabled: jest.fn(() => false),
}));

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(() => false),
	listOutcomes: jest.fn(),
	getWorkerStatus: jest.fn(() => ({ enabled: false })),
	getStatus: jest.fn(() => ({ enabled: false })),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
}));

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	listAlerts: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
}));

const sentryService = require('../../src/services/monitoring/SentryService');
const {
	versionCmd,
	buildHelpMessage,
} = require('../../src/controllers/commands');
const { getTelegramCommandMenu } = require('../../src/lib/telegramCommandMenu');
const { getBuildInfo, formatVersionMessage } = require('../../src/lib/deploymentEnvironment');
const { getStatus } = require('../../src/controllers/status');

describe('Telegram /version command (issue #754)', () => {
	let originalEnv;
	let consoleInfoSpy;

	beforeEach(() => {
		originalEnv = { ...process.env };
		consoleInfoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
	});

	afterEach(() => {
		process.env = originalEnv;
		consoleInfoSpy.mockRestore();
		jest.clearAllMocks();
	});

	function createMockContext(chatId = 123456789) {
		return {
			update: {
				message: {
					chat: { id: chatId },
				},
			},
			message: {
				text: '/version',
			},
			reply: jest.fn().mockResolvedValue(true),
		};
	}

	describe('Environment state coverage', () => {
		it('handles Render environment state correctly', async () => {
			const env = {
				RENDER: 'true',
				RENDER_GIT_COMMIT: 'abcdef1234567890abcdef1234567890abcdef12',
				SERVICE_NAME: 'cabros-bot',
			};

			const ctx = createMockContext(987654);
			await versionCmd(ctx, env);

			expect(consoleInfoSpy).toHaveBeenCalledWith(
				expect.stringContaining('command=version chatId=987654')
			);

			expect(ctx.reply).toHaveBeenCalledTimes(1);
			const [replyText, replyOptions] = ctx.reply.mock.calls[0];

			expect(replyOptions).toEqual({ parse_mode: 'MarkdownV2' });
			expect(replyText).toContain('cabros\\-bot abcdef1');
			expect(replyText).toContain('render');
			expect(replyText).toContain('uptime');
			expect(replyText).toContain('Build details: /api/capabilities');
		});

		it('handles Vercel environment state correctly', async () => {
			const env = {
				VERCEL: '1',
				VERCEL_GIT_COMMIT_SHA: '9988776655443322110099887766554433221100',
				SERVICE_NAME: 'cabros-bot',
			};

			const ctx = createMockContext(112233);
			await versionCmd(ctx, env);

			expect(consoleInfoSpy).toHaveBeenCalledWith(
				expect.stringContaining('command=version chatId=112233')
			);

			expect(ctx.reply).toHaveBeenCalledTimes(1);
			const [replyText, replyOptions] = ctx.reply.mock.calls[0];

			expect(replyOptions).toEqual({ parse_mode: 'MarkdownV2' });
			expect(replyText).toContain('cabros\\-bot 9988776');
			expect(replyText).toContain('vercel');
			expect(replyText).toContain('uptime');
			expect(replyText).toContain('Build details: /api/capabilities');
		});

		it('handles Railway environment state correctly', async () => {
			const env = {
				RAILWAY_ENVIRONMENT_NAME: 'production',
				RAILWAY_GIT_COMMIT_SHA: '1122334455667788990011223344556677889900',
				SERVICE_NAME: 'cabros-bot',
			};

			const ctx = createMockContext(445566);
			await versionCmd(ctx, env);

			expect(consoleInfoSpy).toHaveBeenCalledWith(
				expect.stringContaining('command=version chatId=445566')
			);

			expect(ctx.reply).toHaveBeenCalledTimes(1);
			const [replyText, replyOptions] = ctx.reply.mock.calls[0];

			expect(replyOptions).toEqual({ parse_mode: 'MarkdownV2' });
			expect(replyText).toContain('cabros\\-bot 1122334');
			expect(replyText).toContain('railway');
			expect(replyText).toContain('uptime');
			expect(replyText).toContain('Build details: /api/capabilities');
		});

		it('handles unknown / local environment state without throwing', async () => {
			const env = {};

			const ctx = createMockContext(778899);
			await versionCmd(ctx, env);

			expect(consoleInfoSpy).toHaveBeenCalledWith(
				expect.stringContaining('command=version chatId=778899')
			);

			expect(ctx.reply).toHaveBeenCalledTimes(1);
			const [replyText, replyOptions] = ctx.reply.mock.calls[0];

			expect(replyOptions).toEqual({ parse_mode: 'MarkdownV2' });
			expect(replyText).toContain('cabros\\-bot');
			expect(replyText).toContain('unknown');
			expect(replyText).toContain('uptime');
			expect(replyText).toContain('Build details: /api/capabilities');
		});
	});

	describe('Build parity with /api/capabilities', () => {
		it('uses the same build object surfaced in getStatus()', () => {
			const build = getBuildInfo();
			const status = getStatus({ skipTelemetrySync: true });

			expect(status).toHaveProperty('build');
			expect(status.build).toMatchObject({
				commit: build.commit,
				full: build.full,
				platform: build.platform,
				environment: build.environment,
			});
		});

		it('formats uptime correctly with hours and minutes', () => {
			const build = {
				commit: '1234567',
				platform: 'render',
				environment: 'render',
				uptimeSeconds: 3665, // 1h 1m 5s
			};
			const formatted = formatVersionMessage(build);
			expect(formatted).toContain('1h 1m');
		});

		it('handles missing or non-object build payloads defensively in formatVersionMessage', () => {
			expect(formatVersionMessage(null)).toContain('cabros\\-bot unknown');
			expect(formatVersionMessage(undefined)).toContain('cabros\\-bot unknown');
			expect(formatVersionMessage('invalid')).toContain('cabros\\-bot unknown');
			expect(formatVersionMessage({})).toContain('cabros\\-bot unknown');
		});

		it('resolves commit slice when commit is unknown but full commit is provided', () => {
			const formatted = formatVersionMessage({
				commit: 'unknown',
				full: 'fedcba987654321',
				environment: 'render',
				uptimeSeconds: 120,
			});
			expect(formatted).toContain('cabros\\-bot fedcba9');
		});

		it('identifies preview environment when deployment is a PR preview', () => {
			const previewEnv = {
				RENDER: 'true',
				IS_PULL_REQUEST: 'true',
				RENDER_GIT_COMMIT: '1234567890abcdef',
			};
			const build = getBuildInfo(previewEnv);
			expect(build.environment).toBe('preview');
			expect(build.platform).toBe('render');
		});
	});

	describe('Fail-safe error handling', () => {
		it('captures error in Sentry and attempts plain text reply if MarkdownV2 fails', async () => {
			const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
			const ctx = createMockContext(123);
			ctx.reply.mockRejectedValueOnce(new Error('Bad Telegram MarkdownV2 entity'));

			await versionCmd(ctx);

			expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					extra: expect.objectContaining({ command: 'versionCmd', chatId: 123 }),
				})
			);
			expect(ctx.reply).toHaveBeenCalledTimes(2);
			expect(ctx.reply).toHaveBeenLastCalledWith('cabros-bot (version unavailable)');
			consoleErrorSpy.mockRestore();
		});
	});

	describe('Command discovery and documentation', () => {
		it('includes /version in buildHelpMessage()', () => {
			const help = buildHelpMessage();
			expect(help).toContain('/version');
		});

		it('includes version in getTelegramCommandMenu()', () => {
			const menu = getTelegramCommandMenu();
			const entry = menu.find((cmd) => cmd.command === 'version');
			expect(entry).toBeDefined();
			expect(entry.description).toBeTruthy();
		});
	});
});
