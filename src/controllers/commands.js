const { fetchSymbolPrice } = require('./commands/handlers/core/fetchPriceCryptoSymbol');
const { jobService } = require('../services/jobs/JobService');
const { getNewsMonitor } = require('./webhooks/handlers/newsMonitor/newsMonitor');
const sentryService = require('../services/monitoring/SentryService');

const getPrice = async (context) => {
	const chatId = context.update && context.update.message && context.update.message.chat && context.update.message.chat.id;
	const messageSplited = context.message.text.split(' ');
	const symbol = messageSplited[1] || '';
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.precio',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/precio',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
			'crypto.symbol': symbol || 'missing',
		},
	});

	try {
		const result = await fetchSymbolPrice(context, { parentSpan: commandSpan });
		await context.reply(`Precio de ${result.symbol} es ${result.price}`);
	} catch (error) {
		console.error(error);
		// Capture Telegram command errors to Sentry (T015)
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: {
				command: 'getPrice',
				chatId,
				symbol,
			},
		});
	} finally {
		sentryService.endSpan(commandSpan);
	}
};

const createTradingViewJobCommand = (type, command, buildPayload) => async (context) => {
	const chatId = getChatId(context);
	const args = parseCommandArgs(context);
	const commandSpan = sentryService.startInactiveSpan({
		name: `telegram.command.${command}`,
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': `/${command}`,
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
			'tradingview.job_type': type,
		},
	});

	try {
		const payload = buildPayload(args);
		const result = jobService.createJob(type, payload, buildBotFromContext(context));
		await context.reply(`Job ${result.jobId} creado para ${type}. Estado: ${result.status}.`);
	} catch (error) {
		await replyValidationError(context, error);
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: {
				command,
				chatId,
			},
		});
	} finally {
		sentryService.endSpan(commandSpan);
	}
};

const expandedAnalysisCmd = createTradingViewJobCommand(
	'expanded-analysis',
	'analisis',
	(args) => ({
		type: 'expanded-analysis',
		symbols: parseCsvOption(args, 'symbols', args.positionals),
		timeframe: args.options.timeframe,
		includeMultiTimeframe: parseBooleanOption(args.options.mtf ?? args.options.includeMultiTimeframe),
		timeoutMs: parseIntegerOption(args.options.timeoutMs),
	}),
);

const marketScannerCmd = createTradingViewJobCommand(
	'market-scanner',
	'scanner',
	(args) => ({
		type: 'market-scanner',
		scans: parseCsvOption(args, 'scans'),
		exchange: args.options.exchange,
		timeframe: args.options.timeframe,
		limit: parseIntegerOption(args.options.limit),
		bbw_threshold: parseNumberOption(args.options.bbw_threshold ?? args.options.bbwThreshold),
		timeoutMs: parseIntegerOption(args.options.timeoutMs),
	}),
);

const newsMonitorCmd = async (context) => {
	const chatId = getChatId(context);
	const args = parseCommandArgs(context);
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.noticias',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/noticias',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
		},
	});

	try {
		const req = {
			method: 'POST',
			body: {
				crypto: parseCsvOption(args, 'crypto', args.positionals),
				stocks: parseCsvOption(args, 'stocks'),
			},
		};
		const response = await invokeNewsMonitor(req);

		if (response.statusCode >= 400) {
			await context.reply(`No pude ejecutar noticias: ${response.body.error}`);
			return;
		}

		const summary = response.body.summary || {};
		await context.reply(
			`Noticias listas. Analizados: ${summary.analyzed || 0}, cache: ${summary.cached || 0}, alertas: ${summary.alerts_sent || 0}.`,
		);
	} catch (error) {
		await replyValidationError(context, error);
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: {
				command: 'noticias',
				chatId,
			},
		});
	} finally {
		sentryService.endSpan(commandSpan);
	}
};

const cryptoBotCmd = (context) => {
	const chatId = getChatId(context);
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.cryptobot',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/cryptobot',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
		},
	});

	try {
		const messageSplited = context.message.text.split(' ');
		const cmd = messageSplited[1];
		switch (cmd) {
		case 'id':
			context.reply(`Chat Id: ${chatId}`);
			break;
		default:
			// Nothing
		}
	} catch (error) {
		console.error(error);
		// Capture Telegram command errors to Sentry (T015)
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: {
				command: 'cryptoBotCmd',
				chatId,
			},
		});
	} finally {
		sentryService.endSpan(commandSpan);
	}
};

function getChatId(context) {
	return context.update && context.update.message && context.update.message.chat && context.update.message.chat.id;
}

function parseCommandArgs(context) {
	const text = context.message && context.message.text ? context.message.text : '';
	const [, ...tokens] = text.trim().split(/\s+/).filter(Boolean);
	const positionals = [];
	const options = {};

	tokens.forEach((token) => {
		const equalIndex = token.indexOf('=');
		if (equalIndex === -1) {
			positionals.push(token);
			return;
		}

		const key = token.slice(0, equalIndex).trim();
		const value = token.slice(equalIndex + 1).trim();
		if (key) {
			options[key] = value;
		}
	});

	return { positionals, options };
}

function parseCsvOption(args, optionName, fallback = []) {
	const rawValues = args.options[optionName] !== undefined ? [args.options[optionName]] : fallback;
	return rawValues
		.flatMap((value) => String(value).split(','))
		.map((value) => value.trim())
		.filter(Boolean);
}

function parseBooleanOption(value) {
	if (value === undefined) return undefined;
	if (value === 'true') return true;
	if (value === 'false') return false;
	return value;
}

function parseIntegerOption(value) {
	if (value === undefined) return undefined;
	return Number(value);
}

function parseNumberOption(value) {
	if (value === undefined) return undefined;
	return Number(value);
}

function buildBotFromContext(context) {
	return {
		telegram: context.telegram,
	};
}

async function invokeNewsMonitor(req) {
	const newsMonitor = getNewsMonitor();
	let statusCode = 200;
	let body;
	const res = {
		status(code) {
			statusCode = code;
			return this;
		},
		json(payload) {
			body = payload;
			return payload;
		},
	};

	await newsMonitor.handleRequest(req, res);
	return { statusCode, body };
}

async function replyValidationError(context, error) {
	const suffix = error && error.message ? error.message : 'Error desconocido';
	await context.reply(`Comando inválido: ${suffix}`);
}

module.exports = {
	getPrice,
	cryptoBotCmd,
	expandedAnalysisCmd,
	marketScannerCmd,
	newsMonitorCmd,
	parseCommandArgs,
};
