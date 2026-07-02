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

const { jobService } = require('../../src/services/jobs/JobService');
const { getNewsMonitor } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const {
	expandedAnalysisCmd,
	marketScannerCmd,
	newsMonitorCmd,
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
});
