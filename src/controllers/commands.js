const { fetchSymbolPrice } = require('./commands/handlers/core/fetchPriceCryptoSymbol');
const { jobService } = require('../services/jobs/JobService');
const { getNewsMonitor } = require('./webhooks/handlers/newsMonitor/newsMonitor');
const signalOutcomeService = require('../services/storage/SignalOutcomeService');
const sentryService = require('../services/monitoring/SentryService');
const { getTelegramCommandMenu } = require('../lib/telegramCommandMenu');
const { chatPreferenceService } = require('../services/preferences/ChatPreferenceService');
const { smartEscapeMarkdownV2 } = require('../services/notification/formatters/MarkdownV2Formatter');

const DEFAULT_TELEGRAM_COMMAND_RATE_LIMITS = Object.freeze({
	precio: { max: 10, windowMs: 60_000 },
	analisis: { max: 3, windowMs: 3_600_000 },
	scanner: { max: 3, windowMs: 3_600_000 },
	noticias: { max: 3, windowMs: 3_600_000 },
	preferencias: { max: 20, windowMs: 60_000 },
	filtro: { max: 20, windowMs: 60_000 },
	silencio: { max: 20, windowMs: 60_000 },
	umbral: { max: 20, windowMs: 60_000 },
	categorias: { max: 20, windowMs: 60_000 },
});
const MAX_TELEGRAM_COMMAND_RATE_LIMIT = 1_000;
const MAX_TELEGRAM_COMMAND_WINDOW_MS = 86_400_000;
const telegramCommandRateLimitBuckets = new Map();

function getTelegramCommandRateLimits() {
	const raw = process.env.TELEGRAM_COMMAND_RATE_LIMITS_JSON;
	if (!raw) return DEFAULT_TELEGRAM_COMMAND_RATE_LIMITS;
	try {
		const configured = JSON.parse(raw);
		return Object.fromEntries(Object.entries(DEFAULT_TELEGRAM_COMMAND_RATE_LIMITS).map(([command, fallback]) => {
			const candidate = configured && configured[command];
			const max = candidate && typeof candidate.max === 'number' ? candidate.max : NaN;
			const windowMs = candidate && typeof candidate.windowMs === 'number' ? candidate.windowMs : NaN;
			return [command, Number.isSafeInteger(max) && max > 0 && max <= MAX_TELEGRAM_COMMAND_RATE_LIMIT
				&& Number.isSafeInteger(windowMs) && windowMs > 0 && windowMs <= MAX_TELEGRAM_COMMAND_WINDOW_MS
				? { max, windowMs }
				: fallback];
		}));
	} catch {
		return DEFAULT_TELEGRAM_COMMAND_RATE_LIMITS;
	}
}

async function telegramCommandRateLimiter(context, next) {
	if (process.env.ENABLE_TELEGRAM_COMMAND_RATE_LIMITING === 'false') return next();
	const message = context.message || {};
	const text = String(message.text || '');
	const commandEntity = Array.isArray(message.entities)
		&& message.entities.find((entity) => entity.type === 'bot_command'
			&& entity.offset === 0);
	if (!commandEntity) return next();
	const commandToken = text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length);
	if (!commandToken.startsWith('/')) return next();
	const [rawCommand, recipient] = commandToken.slice(1).split('@', 2);
	if (recipient !== undefined
		&& (!context.me || recipient.toLowerCase() !== String(context.me).replace(/^@/, '').toLowerCase())) return next();
	const command = { analysis: 'analisis', news: 'noticias' }[rawCommand] || rawCommand;
	const rule = getTelegramCommandRateLimits()[command];
	const chatId = getChatId(context);
	if (!rule || chatId === undefined || chatId === null) return next();

	const now = Date.now();
	const key = `${chatId}:${command}`;
	const timestamps = (telegramCommandRateLimitBuckets.get(key) || []).filter((timestamp) => now - timestamp < rule.windowMs);
	if (timestamps.length >= rule.max) {
		const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + rule.windowMs - now) / 1000));
		try {
			await context.reply(`demasiadas solicitudes para /${command}. Intenta nuevamente en ${retryAfterSeconds} s.`);
		} catch (error) {
			console.error('[commands] Failed to send Telegram rate-limit reply:', error.message);
		}
		return;
	}

	if (telegramCommandRateLimitBuckets.size >= 10_000 && !telegramCommandRateLimitBuckets.has(key)) {
		const configuredLimits = getTelegramCommandRateLimits();
		for (const [bucketKey, bucket] of telegramCommandRateLimitBuckets) {
			const bucketCommand = bucketKey.slice(bucketKey.lastIndexOf(':') + 1);
			const bucketRule = configuredLimits[bucketCommand];
			if (!bucketRule || bucket.every((timestamp) => now - timestamp >= bucketRule.windowMs)) {
				telegramCommandRateLimitBuckets.delete(bucketKey);
			}
		}
		// ponytail: reject new buckets at the cap; use an overflow/LRU bucket if this ceiling matters.
		if (telegramCommandRateLimitBuckets.size >= 10_000) {
			try {
				await context.reply(`demasiadas solicitudes para /${command}. Intenta nuevamente más tarde.`);
			} catch (error) {
				console.error('[commands] Failed to send Telegram rate-limit reply:', error.message);
			}
			return;
		}
	}
	timestamps.push(now);
	telegramCommandRateLimitBuckets.set(key, timestamps);
	return next();
}

telegramCommandRateLimiter.reset = () => telegramCommandRateLimitBuckets.clear();

const getPrice = async (context) => {
	const chatId = getChatId(context);
	const text = (context.message && context.message.text) || '';
	const messageSplited = text.trim().split(/\s+/);
	const symbol = messageSplited[1] || '';
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.precio',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/precio',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
			'query.symbol': symbol || 'missing',
		},
	});

	try {
		const result = await fetchSymbolPrice(context, { parentSpan: commandSpan });
		if (result && result.message) {
			await context.reply(result.message);
		} else if (result && result.symbol && result.price !== undefined) {
			await context.reply(`Precio de ${result.symbol} es ${result.price}`);
		}
	} catch (error) {
		console.error(error);
		if (!error.isUserFriendly) {
			sentryService.captureRuntimeError({
				channel: 'telegram',
				error,
				extra: {
					command: 'getPrice',
					chatId,
					symbol,
				},
			});
		}
		try {
			const replyText = error.userMessage || (symbol
				? `No pude obtener el precio de ${symbol}. Verifica el símbolo e intenta de nuevo.`
				: 'Por favor indica un símbolo. Ejemplo: /precio BTCUSDT o /precio NVDA');
			await context.reply(replyText);
		} catch (replyError) {
			console.error('Failed to send error reply:', replyError);
		}
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
		const payload = {
			...buildPayload(args),
			...(chatId !== undefined && chatId !== null ? { telegramChatId: String(chatId) } : {}),
		};
		const result = await jobService.createJob(type, payload, buildBotFromContext(context));
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

const JOBS_COMMAND_LIMIT = 5;
const JOBS_COMMAND_TIMEOUT_MS = 8000;
const JOB_STATUS_LABELS = {
	pending: 'pendiente',
	processing: 'procesando',
	completed: 'completado',
	failed: 'fallido',
	cancelled: 'cancelado',
	timed_out: 'expirado',
};

function formatJobStatus(job) {
	const status = JOB_STATUS_LABELS[job.status] || job.status || 'desconocido';
	const progress = job.progress && Number.isFinite(job.progress.current) && Number.isFinite(job.progress.total)
		? ` (${job.progress.current}/${job.progress.total})`
		: '';
	return `${status}${progress}`;
}

function formatJobResult(job) {
	const summary = job.summary || {};
	if (job.type === 'market-scanner') {
		return `${summary.success || 0}/${summary.totalScans || 0} escaneos OK, ${summary.totalItems || 0} items, ${summary.delivered || 0} entregas`;
	}
	return `${summary.analyzed || 0}/${summary.total || 0} símbolos analizados, ${summary.error || 0} errores, ${summary.delivered || 0} entregas`;
}

function formatJobDelivery(job) {
	if (!Array.isArray(job.deliveryResults) || job.deliveryResults.length === 0) return ' Entrega: no registrada.';
	const delivered = job.deliveryResults.filter((result) => result.success).length;
	if (delivered === job.deliveryResults.length) return ' Entrega: OK.';
	if (delivered > 0) return ' Entrega: parcial.';
	return ' Entrega: fallida.';
}

function formatJobList(jobs) {
	return [
		'Jobs recientes:',
		...jobs.slice(0, JOBS_COMMAND_LIMIT).map((job) => `• ${job.jobId} — ${formatJobStatus(job)}`),
	].join('\n');
}

function formatJobDetail(job) {
	const lines = [
		`Job ${job.jobId}`,
		`Tipo: ${job.type}`,
		`Estado: ${formatJobStatus(job)}`,
	];
	if (job.status === 'completed') {
		lines.push(`Resultado: ${formatJobResult(job)}.${formatJobDelivery(job)}`);
	} else if (job.status === 'failed' || job.status === 'timed_out') {
		lines.push(`Error: ${job.error || 'el procesamiento no terminó correctamente'}.`);
	}
	return lines.join('\n');
}

const jobsCommand = async (context) => {
	const chatId = getChatId(context);
	const args = parseCommandArgs(context);
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.jobs',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/jobs',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
		},
	});

	try {
		if (chatId === undefined || chatId === null) {
			await context.reply('No pude identificar el chat para consultar sus jobs.');
			return;
		}

		const jobId = args.positionals[0];
		if (jobId) {
			const job = await withTimeout(
				(signal) => jobService.getJob(jobId, { telegramChatId: String(chatId), signal }),
				JOBS_COMMAND_TIMEOUT_MS,
				'job store read timed out',
			);
			await context.reply(job ? formatJobDetail(job) : `No encontré el job ${jobId}. Puede haber expirado.`);
		} else {
			const jobs = await withTimeout(
				(signal) => jobService.listJobs({
					limit: JOBS_COMMAND_LIMIT,
					telegramChatId: String(chatId),
					signal,
				}),
				JOBS_COMMAND_TIMEOUT_MS,
				'job store read timed out',
			);
			await context.reply(jobs.length ? formatJobList(jobs) : 'No hay jobs recientes.');
		}
	} catch (error) {
		console.error('[commands] /jobs failed:', error.message);
		if (error.name !== 'AbortError' && error.name !== 'TimeoutError' && error.code !== 'TIMEOUT') {
			sentryService.captureRuntimeError({
				channel: 'telegram',
				error,
				extra: { command: 'jobs', chatId },
			});
		}
		try {
			await context.reply('No pude consultar los jobs ahora mismo. Intenta nuevamente más tarde.');
		} catch (replyError) {
			console.error('Failed to send error reply:', replyError);
		}
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

const cryptoBotCmd = async (context) => {
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
		const messageText = (context.message && context.message.text) || '';
		const messageSplited = messageText.trim().split(/\s+/);
		const cmd = messageSplited[1];
		switch (cmd) {
		case 'id':
			await context.reply(`Chat Id: ${chatId}`);
			break;
		default:
			await context.reply('Subcomando no reconocido. Uso: /cryptobot id');
			break;
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

const OUTCOMES_COMMAND_LIMIT = 5;
const OUTCOMES_COMMAND_MAX_SCAN_DOCS = 300;
const OUTCOME_WINDOW_KEYS = ['1h', '4h', '1D', '1W'];
const OUTCOME_WINDOW_LABELS = { '1h': '1h', '4h': '4h', '1D': '1D', '1W': '1S' };
const OUTCOME_EXCHANGE_PATTERN = /^[A-Z0-9_]{1,30}$/;
const OUTCOME_SYMBOL_PATTERN = /^[A-Z0-9._-]{1,30}$/;
// Bounded deadline for the outcome store read so a chat command can never hold
// the handler open indefinitely behind a large Firestore scan.
const OUTCOMES_COMMAND_TIMEOUT_MS = 8000;

function escapeOutcomeText(value) {
	return String(value).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

const outcomesCommand = async (context) => {
	const chatId = getChatId(context);
	const args = parseCommandArgs(context);
	const rawSymbol = (args.positionals[0] || '').trim();
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.outcomes',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/outcomes',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
			'query.symbol': rawSymbol || 'missing',
		},
	});

	try {
		if (!signalOutcomeService.isEnabled()) {
			await context.reply(
				'El seguimiento de resultados de señales está desactivado — pide a un operador que active ENABLE_SIGNAL_OUTCOME_TRACKING',
			);
			return;
		}

		const parsed = parseOutcomeSymbol(rawSymbol);
		if (!parsed) {
			await context.reply(
				'Uso: `/outcomes simbolo` — por ejemplo `/outcomes BTCUSDT` o `/outcomes BINANCE:BTCUSDT`',
				{ parse_mode: 'MarkdownV2' },
			);
			return;
		}

		const result = await withTimeout(
			(signal) => signalOutcomeService.listOutcomes({
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				limit: OUTCOMES_COMMAND_LIMIT,
				maxScanDocs: OUTCOMES_COMMAND_MAX_SCAN_DOCS,
				status: 'evaluated',
				signal,
			}),
			OUTCOMES_COMMAND_TIMEOUT_MS,
			'outcome store read timed out',
		);

		const outcomes = Array.isArray(result && result.outcomes) ? result.outcomes : [];
		if (outcomes.length === 0) {
			await context.reply(
				`Sin resultados evaluados para ${escapeOutcomeText(parsed.symbol)} todavía — vuelve a intentarlo cuando se evalúen más señales`,
				{ parse_mode: 'MarkdownV2' },
			);
			return;
		}
		await context.reply(formatOutcomesMessage(parsed.symbol, outcomes), { parse_mode: 'MarkdownV2' });
	} catch (error) {
		console.error('[commands] /outcomes failed:', error.message);
		const isExpectedError = Boolean(
			error.isUserFriendly ||
			error.name === 'AbortError' ||
			error.name === 'TimeoutError' ||
			error.code === 'TIMEOUT' ||
			(error.code && error.code === signalOutcomeService.STORAGE_UNAVAILABLE_CODE),
		);
		if (!isExpectedError) {
			sentryService.captureRuntimeError({
				channel: 'telegram',
				error,
				extra: {
					command: 'outcomes',
					chatId,
					symbol: rawSymbol,
				},
			});
		}
		try {
			await context.reply('No pude consultar los resultados ahora mismo. Intenta nuevamente más tarde.');
		} catch (replyError) {
			console.error('Failed to send error reply:', replyError);
		}
	} finally {
		sentryService.endSpan(commandSpan);
	}
};

function parseOutcomeSymbol(rawSymbol) {
	const value = String(rawSymbol || '').trim().toUpperCase();
	if (!value) return null;
	let symbolPart = value;
	let exchange;
	if (value.includes(':')) {
		const parts = value.split(':');
		if (parts.length !== 2) {
			return null;
		}
		exchange = parts[0];
		symbolPart = parts[1];
		if (!OUTCOME_EXCHANGE_PATTERN.test(exchange) || !OUTCOME_SYMBOL_PATTERN.test(symbolPart)) {
			return null;
		}
		return { symbol: symbolPart, exchange };
	}
	if (!OUTCOME_SYMBOL_PATTERN.test(symbolPart)) {
		return null;
	}
	return { symbol: symbolPart, exchange: undefined };
}

async function withTimeout(asyncFn, timeoutMs, message) {
	const ac = new AbortController();
	let timer;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => {
			ac.abort();
			const error = new Error(message);
			error.name = 'TimeoutError';
			error.code = 'TIMEOUT';
			error.isUserFriendly = true;
			reject(error);
		}, timeoutMs);
	});
	try {
		const promise = typeof asyncFn === 'function' ? asyncFn(ac.signal) : asyncFn;
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

function formatOutcomesMessage(symbol, outcomes) {
	const lines = [
		`*📊 Rendimiento reciente — ${escapeOutcomeText(symbol)}*`,
		'',
	];
	outcomes.slice(0, OUTCOMES_COMMAND_LIMIT).forEach((outcome) => {
		const sideLabel = outcome.side === 'SELL' ? 'Venta' : 'Compra';
		const entry = Number.isFinite(outcome.price) ? escapeOutcomeText(outcome.price) : null;
		const receivedAt = outcome.receivedAt ? String(outcome.receivedAt).slice(0, 10) : '';
		lines.push(`• ${sideLabel}${entry !== null ? ` @ ${entry}` : ''}${receivedAt ? ` \\(${escapeOutcomeText(receivedAt)}\\)` : ''}`);

		OUTCOME_WINDOW_KEYS.forEach((winKey) => {
			const win = outcome.outcomes && outcome.outcomes[winKey];
			if (!win || win.status !== 'evaluated') return;
			const label = OUTCOME_WINDOW_LABELS[winKey] || winKey;
			const returnPct = Number.isFinite(win.return)
				? `${escapeOutcomeText(`${win.return >= 0 ? '+' : ''}${win.return.toFixed(2)}%`)}`
				: 'n/d';
			let detail = returnPct;
			if (win.targetHit) detail += ' ✅ TP';
			else if (win.stopHit) detail += ' 🛑 SL';
			else if (win.firstHit === 'target') detail += ' ✅ TP';
			else if (win.firstHit === 'stop') detail += ' 🛑 SL';
			lines.push(`  ${label}: ${detail}`);
		});
	});
	lines.push('');
	lines.push(`_Últimas ${Math.min(outcomes.length, OUTCOMES_COMMAND_LIMIT)} señales evaluadas_`);
	return lines.join('\n');
}

function formatPreferencesMessage(prefs) {
	const symFilter = prefs.symbolFilter && prefs.symbolFilter.length > 0
		? prefs.symbolFilter.map((s) => `\`${smartEscapeMarkdownV2(s)}\``).join(', ')
		: '_Todos los símbolos_';
	const symExclude = prefs.symbolExclude && prefs.symbolExclude.length > 0
		? prefs.symbolExclude.map((s) => `\`${smartEscapeMarkdownV2(s)}\``).join(', ')
		: '_Ninguno_';
	const cats = prefs.categories && prefs.categories.length > 0
		? prefs.categories.map((c) => `\`${smartEscapeMarkdownV2(c)}\``).join(', ')
		: '_Todas_ \\(scanner, news, expanded, core, volume\\)';
	const conf = typeof prefs.minConfidence === 'number' && prefs.minConfidence > 0
		? `${Math.round(prefs.minConfidence * 100)}\\%`
		: '_Sin filtro_';
	const quiet = prefs.quietHoursStart !== null && prefs.quietHoursEnd !== null
		? `${String(prefs.quietHoursStart).padStart(2, '0')}:00 \\- ${String(prefs.quietHoursEnd).padStart(2, '0')}:00 \\(${smartEscapeMarkdownV2(prefs.timezone || 'America/Santiago')}\\)`
		: '_Desactivado_';

	return [
		'*⚙️ Preferencias para este chat*',
		'',
		`• *Símbolos permitidos*: ${symFilter}`,
		`• *Símbolos excluidos*: ${symExclude}`,
		`• *Categorías activas*: ${cats}`,
		`• *Confianza mínima*: ${conf}`,
		`• *Horas de silencio*: ${quiet}`,
		'',
		'*Comandos de configuración:*',
		'• `/filtro <simbolos>` \\(ej: `/filtro BTC,ETH` o `/filtro clear`\\)',
		'• `/filtro excluir <simbolos>` \\(ej: `/filtro excluir DOGEUSDT`\\)',
		'• `/silencio <inicio>,<fin>` \\(ej: `/silencio 23,7` o `/silencio off`\\)',
		'• `/umbral <min>` \\(ej: `/umbral 0.8` o `/umbral 80` o `/umbral off`\\)',
		'• `/categorias <lista>` \\(ej: `/categorias scanner,news` o `/categorias all`\\)',
	].join('\n');
}

const preferenciasCmd = async (context) => {
	const chatId = getChatId(context);
	if (!chatId) return;
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.preferencias',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/preferencias',
			'telegram.chat_id': String(chatId),
		},
	});

	try {
		const prefs = await chatPreferenceService.getPreferences(chatId, 'telegram');
		const message = formatPreferencesMessage(prefs);
		await context.reply(message, { parse_mode: 'MarkdownV2' });
	} catch (error) {
		console.error(error);
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: { command: 'preferenciasCmd', chatId },
		});
		await context.reply('Error al obtener preferencias.');
	} finally {
		sentryService.endSpan(commandSpan);
	}
};

const filtroCmd = async (context) => {
	const chatId = getChatId(context);
	if (!chatId) return;
	const { positionals } = parseCommandArgs(context);

	try {
		if (positionals.length === 0) {
			const prefs = await chatPreferenceService.getPreferences(chatId, 'telegram');
			const symList = prefs.symbolFilter.length > 0 ? prefs.symbolFilter.join(', ') : 'Todos';
			const excList = prefs.symbolExclude.length > 0 ? prefs.symbolExclude.join(', ') : 'Ninguno';
			return await context.reply(
				`*Filtro actual:*\n• Permitidos: \`${smartEscapeMarkdownV2(symList)}\`\n• Excluidos: \`${smartEscapeMarkdownV2(excList)}\`\n\nUso: \`/filtro BTC,ETH\` o \`/filtro clear\` o \`/filtro excluir DOGE\``,
				{ parse_mode: 'MarkdownV2' },
			);
		}

		const firstArg = positionals[0].toLowerCase();
		if (firstArg === 'excluir' || firstArg === 'exclude') {
			if (positionals.length === 1 || ['clear', 'off', 'none', 'ninguno'].includes(positionals[1]?.toLowerCase())) {
				await chatPreferenceService.setPreferences(chatId, 'telegram', { symbolExclude: [] });
				return await context.reply('*Filtro de exclusión desactivado*', { parse_mode: 'MarkdownV2' });
			}
			const rawSymbols = positionals.slice(1).join(' ').replace(/,/g, ' ');
			const symbols = rawSymbols.split(/\s+/).map((s) => s.trim()).filter(Boolean);
			const updated = await chatPreferenceService.setPreferences(chatId, 'telegram', { symbolExclude: symbols });
			const list = updated.symbolExclude.join(', ');
			return await context.reply(
				`*Símbolos excluidos actualizados:*\n\`${smartEscapeMarkdownV2(list)}\``,
				{ parse_mode: 'MarkdownV2' },
			);
		}

		if (['clear', 'off', 'none', 'todos', 'all'].includes(firstArg)) {
			await chatPreferenceService.setPreferences(chatId, 'telegram', { symbolFilter: [] });
			return await context.reply('*Filtro de símbolos desactivado*: recibirás todos los símbolos', { parse_mode: 'MarkdownV2' });
		}

		const rawSymbols = positionals.join(' ').replace(/,/g, ' ');
		const symbols = rawSymbols.split(/\s+/).map((s) => s.trim()).filter(Boolean);
		const updated = await chatPreferenceService.setPreferences(chatId, 'telegram', { symbolFilter: symbols });
		const list = updated.symbolFilter.join(', ');
		return await context.reply(
			`*Filtro de símbolos actualizado:*\n\`${smartEscapeMarkdownV2(list)}\``,
			{ parse_mode: 'MarkdownV2' },
		);
	} catch (error) {
		console.error(error);
		await context.reply(`Error en filtro: ${error.message}`);
	}
};

const silencioCmd = async (context) => {
	const chatId = getChatId(context);
	if (!chatId) return;
	const { positionals, options } = parseCommandArgs(context);

	try {
		if (positionals.length === 0) {
			const prefs = await chatPreferenceService.getPreferences(chatId, 'telegram');
			const current = prefs.quietHoursStart !== null && prefs.quietHoursEnd !== null
				? `${prefs.quietHoursStart}:00 - ${prefs.quietHoursEnd}:00 (${prefs.timezone})`
				: 'Desactivado';
			return await context.reply(
				`*Horas de silencio actuales:* ${smartEscapeMarkdownV2(current)}\n\nUso: \`/silencio 23,7\` o \`/silencio off\``,
				{ parse_mode: 'MarkdownV2' },
			);
		}

		const firstArg = positionals[0].toLowerCase();
		if (['off', 'clear', 'disable', 'ninguno'].includes(firstArg)) {
			await chatPreferenceService.setPreferences(chatId, 'telegram', {
				quietHoursStart: null,
				quietHoursEnd: null,
			});
			return await context.reply('*Horas de silencio desactivadas*', { parse_mode: 'MarkdownV2' });
		}

		// Support '23,7', '23-7', '23 7', '23:00,7:00'
		const rawTime = positionals.join(' ').replace(/[:]/g, '');
		const parts = rawTime.split(/[,-/\s]+/).filter(Boolean).map((p) => {
			const num = parseInt(p, 10);
			return num > 24 ? Math.floor(num / 100) : num;
		});

		if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1]) || parts[0] < 0 || parts[0] > 23 || parts[1] < 0 || parts[1] > 23) {
			return await context.reply('Formato inválido. Usa: `/silencio <inicio>,<fin>` (ej: `/silencio 23,7` o `/silencio off`)');
		}

		const tz = options.tz || options.timezone;
		const update = {
			quietHoursStart: parts[0],
			quietHoursEnd: parts[1],
			...(tz ? { timezone: tz } : {}),
		};
		const updated = await chatPreferenceService.setPreferences(chatId, 'telegram', update);
		return await context.reply(
			`*Horas de silencio configuradas:* ${updated.quietHoursStart}:00 \\- ${updated.quietHoursEnd}:00 \\(${smartEscapeMarkdownV2(updated.timezone)}\\)`,
			{ parse_mode: 'MarkdownV2' },
		);
	} catch (error) {
		console.error(error);
		await context.reply(`Error en silencio: ${error.message}`);
	}
};

const umbralCmd = async (context) => {
	const chatId = getChatId(context);
	if (!chatId) return;
	const { positionals } = parseCommandArgs(context);

	try {
		if (positionals.length === 0) {
			const prefs = await chatPreferenceService.getPreferences(chatId, 'telegram');
			const current = prefs.minConfidence > 0 ? `${Math.round(prefs.minConfidence * 100)}%` : 'Sin umbral';
			return await context.reply(
				`*Umbral de confianza actual:* ${smartEscapeMarkdownV2(current)}\n\nUso: \`/umbral 0.8\` o \`/umbral 80\` o \`/umbral off\``,
				{ parse_mode: 'MarkdownV2' },
			);
		}

		const firstArg = positionals[0].toLowerCase();
		if (['off', 'clear', '0', 'none'].includes(firstArg)) {
			await chatPreferenceService.setPreferences(chatId, 'telegram', { minConfidence: 0 });
			return await context.reply('*Umbral de confianza desactivado*: recibirás todas las señales', { parse_mode: 'MarkdownV2' });
		}

		const rawVal = parseFloat(firstArg.replace('%', ''));
		if (isNaN(rawVal) || rawVal < 0) {
			return await context.reply('Valor inválido. Usa: `/umbral 0.8` o `/umbral 80` o `/umbral off`');
		}

		const updated = await chatPreferenceService.setPreferences(chatId, 'telegram', { minConfidence: rawVal });
		return await context.reply(
			`*Umbral de confianza actualizado:* ${Math.round(updated.minConfidence * 100)}\\%`,
			{ parse_mode: 'MarkdownV2' },
		);
	} catch (error) {
		console.error(error);
		await context.reply(`Error en umbral: ${error.message}`);
	}
};

const categoriasCmd = async (context) => {
	const chatId = getChatId(context);
	if (!chatId) return;
	const { positionals } = parseCommandArgs(context);

	try {
		if (positionals.length === 0) {
			const prefs = await chatPreferenceService.getPreferences(chatId, 'telegram');
			const current = prefs.categories.length > 0 ? prefs.categories.join(', ') : 'Todas';
			return await context.reply(
				`*Categorías actuales:* \`${smartEscapeMarkdownV2(current)}\`\n\nCategorías válidas: \`scanner\`, \`news\`, \`expanded\`, \`core\`, \`volume\`\nUso: \`/categorias scanner,news\` o \`/categorias all\``,
				{ parse_mode: 'MarkdownV2' },
			);
		}

		const firstArg = positionals[0].toLowerCase();
		if (['all', 'clear', 'todas', 'off'].includes(firstArg)) {
			await chatPreferenceService.setPreferences(chatId, 'telegram', { categories: [] });
			return await context.reply('*Categorías actualizadas*: recibirás todas las alertas', { parse_mode: 'MarkdownV2' });
		}

		const rawCats = positionals.join(' ').replace(/,/g, ' ');
		const cats = rawCats.split(/\s+/).map((c) => c.trim()).filter(Boolean);
		const updated = await chatPreferenceService.setPreferences(chatId, 'telegram', { categories: cats });
		const list = updated.categories.length > 0 ? updated.categories.join(', ') : 'Todas';
		return await context.reply(
			`*Categorías actualizadas:*\n\`${smartEscapeMarkdownV2(list)}\``,
			{ parse_mode: 'MarkdownV2' },
		);
	} catch (error) {
		console.error(error);
		await context.reply(`Error en categorías: ${error.message}`);
	}
};

function buildHelpMessage() {
	return [
		'*🤖 Comandos disponibles en Cabros Bot*',
		'',
		'• `/precio <simbolo>` — Consulta el precio en Binance o Twelve Data \\(ej: `/precio BTCUSDT`, `/precio NVDA`\\)',
		'• `/cryptobot id` — Muestra el Chat ID actual de Telegram',
		'• `/analisis <simbolos>` — Crea un análisis técnico en TradingView \\(alias: `/analysis`\\)',
		'  _Opciones: `timeframe=1D`, `mtf=true`, `timeoutMs=300000`_',
		'• `/scanner` — Escaneo de mercado en TradingView \\(top gainers, losers, breakouts\\)',
		'  _Opciones: `scans=top_gainers,top_losers`, `exchange=BINANCE`, `timeframe=4h`, `limit=10`_',
		'• `/noticias` — Monitor y análisis de noticias con IA \\(alias: `/news`\\)',
		'  _Opciones: `crypto=BTCUSDT,ETHUSDT`, `stocks=NVDA`_',
		'• `/outcomes <simbolo>` — Rendimiento reciente de señales evaluadas \\(alias: `/rendimiento`\\)',
		'  _Ej: `/outcomes BINANCE:BTCUSDT`_',
		'• `/preferencias` — Preferencias de alertas para este chat \\(símbolos, silencio, umbral, categorías\\)',
		'  _Comandos rápidos: `/filtro`, `/silencio`, `/umbral`, `/categorias`_',
		'• `/jobs [jobId]` — Lista jobs recientes o muestra su estado \\(alias: `/trabajos`\\)',
		'• `/help` / `/start` — Muestra este mensaje de ayuda',
	].join('\n');
}

const helpCmd = async (context) => {
	const chatId = getChatId(context);
	const commandSpan = sentryService.startInactiveSpan({
		name: 'telegram.command.help',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/help',
			'telegram.chat_id': chatId ? String(chatId) : 'unknown',
		},
	});

	try {
		const message = buildHelpMessage();
		await context.reply(message, { parse_mode: 'MarkdownV2' });
	} catch (error) {
		console.error(error);
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: {
				command: 'helpCmd',
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
	jobsCommand,
	newsMonitorCmd,
	helpCmd,
	outcomesCommand,
	preferenciasCmd,
	filtroCmd,
	silencioCmd,
	umbralCmd,
	categoriasCmd,
	formatPreferencesMessage,
	buildHelpMessage,
	getTelegramCommandMenu,
	parseCommandArgs,
	telegramCommandRateLimiter,
};
