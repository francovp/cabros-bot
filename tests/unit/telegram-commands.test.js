jest.mock('../../src/services/jobs/JobService', () => ({
	jobService: {
		createJob: jest.fn(),
	},
}));

jest.mock('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor', () => ({
	getNewsMonitor: jest.fn(),
}));

jest.mock('../../src/services/monitoring/SentryService', () => ({
	startInactiveSpan: jest.fn(() => ({ span: true })),
	endSpan: jest.fn(),
	captureRuntimeError: jest.fn(),
}));

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	listOutcomes: jest.fn(),
}));

const { jobService } = require('../../src/services/jobs/JobService');
const { getNewsMonitor } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const {
	cryptoBotCmd,
	expandedAnalysisCmd,
	marketScannerCmd,
	newsMonitorCmd,
	helpCmd,
	outcomesCommand,
	buildHelpMessage,
	parseCommandArgs,
} = require('../../src/controllers/commands');

function buildContext(text) {
	return {
		message: { text },
		update: {
			message: {
				chat: { id: 123 },
			},
		},
		telegram: { sendMessage: jest.fn() },
		reply: jest.fn().mockResolvedValue(undefined),
	};
}

describe('Telegram TradingView commands', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('parses command args into positionals and key/value options', () => {
		expect(parseCommandArgs(buildContext('/analisis BINANCE:BTCUSDT,NASDAQ:NVDA timeframe=1D mtf=true'))).toEqual({
			positionals: ['BINANCE:BTCUSDT,NASDAQ:NVDA'],
			options: {
				timeframe: '1D',
				mtf: 'true',
			},
		});
	});

	it('creates an expanded analysis job from Telegram args', async () => {
		jobService.createJob.mockResolvedValue({
			success: true,
			jobId: 'job-1',
			status: 'pending',
		});
		const context = buildContext('/analisis BINANCE:BTCUSDT,NASDAQ:NVDA timeframe=1D mtf=true timeoutMs=300000');

		await expandedAnalysisCmd(context);

		expect(jobService.createJob).toHaveBeenCalledWith(
			'expanded-analysis',
			{
				type: 'expanded-analysis',
				symbols: ['BINANCE:BTCUSDT', 'NASDAQ:NVDA'],
				timeframe: '1D',
				includeMultiTimeframe: true,
				timeoutMs: 300000,
			},
			{ telegram: context.telegram },
		);
		expect(context.reply).toHaveBeenCalledWith('Job job-1 creado para expanded-analysis. Estado: pending.');
	});

	it('creates a market scanner job from Telegram args', async () => {
		jobService.createJob.mockResolvedValue({
			success: true,
			jobId: 'job-2',
			status: 'pending',
		});
		const context = buildContext('/scanner scans=top_gainers,top_losers exchange=BINANCE timeframe=4h limit=7');

		await marketScannerCmd(context);

		expect(jobService.createJob).toHaveBeenCalledWith(
			'market-scanner',
			{
				type: 'market-scanner',
				scans: ['top_gainers', 'top_losers'],
				exchange: 'BINANCE',
				timeframe: '4h',
				limit: 7,
				bbw_threshold: undefined,
				timeoutMs: undefined,
			},
			{ telegram: context.telegram },
		);
		expect(context.reply).toHaveBeenCalledWith('Job job-2 creado para market-scanner. Estado: pending.');
	});

	it('returns clear validation errors from job commands', async () => {
		const error = new Error('Market scanner is not enabled');
		error.code = 'FEATURE_DISABLED';
		jobService.createJob.mockRejectedValue(error);
		const context = buildContext('/scanner');

		await marketScannerCmd(context);

		expect(context.reply).toHaveBeenCalledWith('Comando inválido: Market scanner is not enabled');
	});

	it('runs the news monitor through its existing handler', async () => {
		const handleRequest = jest.fn(async (req, res) => res.status(200).json({
			success: true,
			summary: {
				analyzed: 2,
				cached: 1,
				alerts_sent: 1,
			},
		}));
		getNewsMonitor.mockReturnValue({ handleRequest });
		const context = buildContext('/noticias crypto=BTCUSDT,ETHUSDT stocks=NVDA');

		await newsMonitorCmd(context);

		expect(handleRequest).toHaveBeenCalledWith(
			{
				method: 'POST',
				body: {
					crypto: ['BTCUSDT', 'ETHUSDT'],
					stocks: ['NVDA'],
				},
			},
			expect.any(Object),
		);
		expect(context.reply).toHaveBeenCalledWith('Noticias listas. Analizados: 2, cache: 1, alertas: 1.');
	});

	describe('helpCmd and buildHelpMessage', () => {
		it('buildHelpMessage returns MarkdownV2 formatted message with all commands and aliases', () => {
			const message = buildHelpMessage();
			expect(message).toContain('*🤖 Comandos disponibles en Cabros Bot*');
			expect(message).toContain('/precio <simbolo>');
			expect(message).toContain('/cryptobot id');
			expect(message).toContain('/analisis <simbolos>');
			expect(message).toContain('/analysis');
			expect(message).toContain('/scanner');
			expect(message).toContain('/noticias');
			expect(message).toContain('/news');
			expect(message).toContain('/outcomes');
			expect(message).toContain('/rendimiento');
			expect(message).toContain('/help');
			expect(message).toContain('/start');

			// MarkdownV2 escaping checks: ensure unescaped parentheses outside backticks are not present
			const lines = message.split('\n');
			lines.forEach((line) => {
				// Remove inline code blocks `...` to check plain text formatting
				const withoutCode = line.replace(/`[^`]+`/g, '');
				// Should not have unescaped ( or ) in plain text
				expect(withoutCode).not.toMatch(/(?<!\\)[()]/);
			});
		});

		it('sends MarkdownV2 formatted help message via context.reply', async () => {
			const context = buildContext('/help');
			await helpCmd(context);

			expect(context.reply).toHaveBeenCalledWith(
				buildHelpMessage(),
				{ parse_mode: 'MarkdownV2' },
			);
		});

		it('sends help message when called via /start', async () => {
			const context = buildContext('/start');
			await helpCmd(context);

			expect(context.reply).toHaveBeenCalledWith(
				buildHelpMessage(),
				{ parse_mode: 'MarkdownV2' },
			);
		});

		it('captures runtime error safely if context.reply fails', async () => {
			const context = buildContext('/help');
			const error = new Error('Telegram API connection error');
			context.reply.mockRejectedValueOnce(error);

			const { captureRuntimeError } = require('../../src/services/monitoring/SentryService');

			await expect(helpCmd(context)).resolves.not.toThrow();
			expect(captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					error,
					extra: expect.objectContaining({
						command: 'helpCmd',
						chatId: 123,
					}),
				}),
			);
		});
	});

	describe('cryptoBotCmd', () => {
		it('replies with chat id for /cryptobot id', async () => {
			const context = buildContext('/cryptobot id');
			await cryptoBotCmd(context);

			expect(context.reply).toHaveBeenCalledWith('Chat Id: 123');
		});

		it('replies with usage hint for unknown subcommand /cryptobot foo', async () => {
			const context = buildContext('/cryptobot foo');
			await cryptoBotCmd(context);

			expect(context.reply).toHaveBeenCalledWith('Subcomando no reconocido. Uso: /cryptobot id');
		});

		it('replies with usage hint when no subcommand is provided', async () => {
			const context = buildContext('/cryptobot');
			await cryptoBotCmd(context);

			expect(context.reply).toHaveBeenCalledWith('Subcomando no reconocido. Uso: /cryptobot id');
		});

		it('captures runtime error safely if context.reply fails', async () => {
			const context = buildContext('/cryptobot id');
			const error = new Error('Telegram API failure');
			context.reply.mockRejectedValueOnce(error);

			const { captureRuntimeError } = require('../../src/services/monitoring/SentryService');

			await expect(cryptoBotCmd(context)).resolves.not.toThrow();
			expect(captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					error,
					extra: expect.objectContaining({
						command: 'cryptoBotCmd',
						chatId: 123,
					}),
				}),
			);
		});
	});

	describe('outcomesCommand', () => {
		const evaluatedOutcome = {
			id: 'outcome-1',
			receivedAt: '2026-08-25T10:00:00.000Z',
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			side: 'BUY',
			price: 50000,
			stop: 48000,
			target: 55000,
			outcomeEvaluated: true,
			outcomes: {
				'1h': { status: 'evaluated', return: 1.25, targetHit: false, stopHit: false },
				'4h': { status: 'evaluated', return: 2.5, targetHit: true, stopHit: false, firstHit: 'target' },
				'1D': { status: 'pending' },
			},
		};

		beforeEach(() => {
			jest.clearAllMocks();
		});

		it('replies with a formatted summary of recent evaluated outcomes for the requested symbol', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.listOutcomes.mockResolvedValue({
				outcomes: [evaluatedOutcome],
				hasMore: false,
				nextBefore: null,
			});
			const context = buildContext('/outcomes BINANCE:BTCUSDT');

			await outcomesCommand(context);

			expect(signalOutcomeService.listOutcomes).toHaveBeenCalledWith(
				expect.objectContaining({ symbol: 'BTCUSDT', exchange: 'BINANCE', limit: expect.any(Number), status: 'evaluated' }),
			);
			expect(context.reply).toHaveBeenCalledTimes(1);
			const reply = context.reply.mock.calls[0][0];
			expect(reply).toContain('BTCUSDT');
			expect(reply).toContain('Compra');
			expect(reply).toContain('50000');
			expect(reply).toContain('4h');
			expect(reply).toContain('+2\\.50%');
		});

		it('reports when no evaluated outcomes exist for the symbol', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.listOutcomes.mockResolvedValue({ outcomes: [], hasMore: false, nextBefore: null });
			const context = buildContext('/outcomes NYSE:BRK.B');

			await outcomesCommand(context);

			expect(context.reply.mock.calls[0][0]).toContain('Sin resultados evaluados para BRK\\.B todavía');
			expect(context.reply.mock.calls[0][1]).toEqual({ parse_mode: 'MarkdownV2' });
		});

		it('replies with an explicit message when signal outcome tracking is disabled', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(false);
			const context = buildContext('/outcomes BINANCE:BTCUSDT');

			await outcomesCommand(context);

			expect(signalOutcomeService.listOutcomes).not.toHaveBeenCalled();
			expect(context.reply.mock.calls[0][0]).toContain('seguimiento de resultados');
		});

		it('asks for a symbol when the argument is missing', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const context = buildContext('/outcomes');

			await outcomesCommand(context);

			expect(signalOutcomeService.listOutcomes).not.toHaveBeenCalled();
			expect(context.reply.mock.calls[0][0]).toContain('Uso');
		});

		it('rejects malformed symbols with a validation reply', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const context = buildContext('/outcomes not@@valid!');

			await outcomesCommand(context);

			expect(signalOutcomeService.listOutcomes).not.toHaveBeenCalled();
			expect(context.reply.mock.calls[0][0]).toContain('Uso');
		});

		it('replies with a friendly fail-open message when the outcome store is unavailable', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const error = new Error('Firestore unavailable');
			error.code = 'STORAGE_UNAVAILABLE';
			signalOutcomeService.listOutcomes.mockRejectedValue(error);
			const context = buildContext('/outcomes BTCUSDT');

			await outcomesCommand(context);

			expect(context.reply.mock.calls[0][0]).toContain('No pude consultar los resultados');
			expect(context.reply).toHaveBeenCalledTimes(1);
		});

		it('captures unexpected runtime errors and still replies safely', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const error = new Error('boom');
			signalOutcomeService.listOutcomes.mockRejectedValue(error);
			const context = buildContext('/outcomes BTCUSDT');

			await outcomesCommand(context);

			const { captureRuntimeError } = require('../../src/services/monitoring/SentryService');
			expect(captureRuntimeError).toHaveBeenCalledWith(
				expect.objectContaining({
					channel: 'telegram',
					error,
					extra: expect.objectContaining({ command: 'outcomes' }),
				}),
			);
			expect(context.reply.mock.calls[0][0]).toContain('No pude consultar los resultados');
		});

		it('escapes MarkdownV2 special characters in generated outcome values', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.listOutcomes.mockResolvedValue({
				outcomes: [{
					id: 'outcome-2',
					receivedAt: '2026-08-25T10:00:00.000Z',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'SELL',
					price: 12345.67,
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'evaluated', return: 3.5, targetHit: false, stopHit: false },
					},
				}],
				hasMore: false,
				nextBefore: null,
			});
			const context = buildContext('/outcomes BINANCE:BTCUSDT');

			await outcomesCommand(context);

			expect(context.reply).toHaveBeenCalledTimes(1);
			const reply = context.reply.mock.calls[0][0];
			// Dots and the plus sign in generated numbers must be escaped for MarkdownV2
			expect(reply).toContain('+3\\.50%');
			expect(reply).toContain('12345\\.67');
			// No unescaped dot may remain in generated numeric fields
			expect(reply).not.toContain('+3.50%');
		});

		it('accepts supported exchange and symbol separators (FX_IDC:USDCLP, NYSE_ARCA:SPY, NYSE:BRK.B)', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			signalOutcomeService.listOutcomes.mockResolvedValue({ outcomes: [], hasMore: false, nextBefore: null });

			const context1 = buildContext('/outcomes FX_IDC:USDCLP');
			await outcomesCommand(context1);
			expect(signalOutcomeService.listOutcomes).toHaveBeenCalledWith(
				expect.objectContaining({ symbol: 'USDCLP', exchange: 'FX_IDC' }),
			);

			const context2 = buildContext('/outcomes NYSE_ARCA:SPY');
			await outcomesCommand(context2);
			expect(signalOutcomeService.listOutcomes).toHaveBeenCalledWith(
				expect.objectContaining({ symbol: 'SPY', exchange: 'NYSE_ARCA' }),
			);

			const context3 = buildContext('/outcomes NYSE:BRK.B');
			await outcomesCommand(context3);
			expect(signalOutcomeService.listOutcomes).toHaveBeenCalledWith(
				expect.objectContaining({ symbol: 'BRK.B', exchange: 'NYSE' }),
			);
			expect(context3.reply).toHaveBeenCalledWith(
				expect.stringContaining('BRK\\.B'),
				{ parse_mode: 'MarkdownV2' },
			);

			const context4 = buildContext('/outcomes BRK.B');
			await outcomesCommand(context4);
			expect(signalOutcomeService.listOutcomes).toHaveBeenCalledWith(
				expect.objectContaining({ symbol: 'BRK.B', exchange: undefined }),
			);
			expect(context4.reply).toHaveBeenCalledWith(
				expect.stringContaining('BRK\\.B'),
				{ parse_mode: 'MarkdownV2' },
			);
		});

		it('rejects arguments with extra colon separators (e.g. BINANCE:ETHUSDT:PERP)', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			const context = buildContext('/outcomes BINANCE:ETHUSDT:PERP');

			await outcomesCommand(context);

			expect(signalOutcomeService.listOutcomes).not.toHaveBeenCalled();
			expect(context.reply.mock.calls[0][0]).toContain('Uso');
		});

		it('bounds the outcome store read with a command-level deadline and propagates cancellation signal', async () => {
			signalOutcomeService.isEnabled.mockReturnValue(true);
			let receivedSignal;
			signalOutcomeService.listOutcomes.mockImplementation(({ signal }) => {
				receivedSignal = signal;
				return new Promise(() => {}); // never settles
			});
			const context = buildContext('/outcomes BTCUSDT');

			await outcomesCommand(context);

			expect(context.reply).toHaveBeenCalledWith(expect.stringContaining('No pude consultar los resultados'));
			expect(signalOutcomeService.listOutcomes).toHaveBeenCalled();
			expect(receivedSignal).toBeDefined();
			expect(receivedSignal.aborted).toBe(true);
		}, 12000);
	});
});

