'use strict';

const {
	chatSubscriptionService,
	ChatSubscriptionValidationError,
	MAX_LIST_ENTRIES,
} = require('../../../../services/chatSubscriptions/ChatSubscriptionService');
const sentryService = require('../../../../services/monitoring/SentryService');

function getChatId(context) {
	if (!context || !context.chat) return null;
	return context.chat.id;
}

function formatListEntry(entry) {
	const intervalHours = (entry.intervalMs / 3600000).toFixed(2);
	const typeLabel = entry.type === 'scanner' ? 'scanner' : 'analysis';
	const paramsSummary = entry.type === 'scanner'
		? `${entry.params.scans ? entry.params.scans.join(',') : ''} ${entry.params.exchange || ''} ${entry.params.timeframe || ''}`.trim()
		: `${(entry.params.symbols || []).join(',')} ${entry.params.exchange || ''} ${entry.params.timeframe || ''}`.trim();
	const next = entry.nextRunAt ? new Date(entry.nextRunAt).toLocaleString('es-CL') : 'pendiente';
	const shortId = entry.subscriptionId.split('-')[0];
	return [
		`/${shortId} ${typeLabel} cada ${intervalHours}h`,
		`  params: ${paramsSummary || '(default)'}`,
		`  próximo: ${next}`,
		entry.lastResultSummary ? `  último: ${entry.lastResultSummary}` : null,
	].filter(Boolean).join('\n');
}

async function handleSubscribeCommand(context) {
	const chatId = getChatId(context);
	if (!chatId) {
		await context.reply('No pude identificar el chat para esta suscripción.');
		return;
	}
	const text = (context.message && context.message.text) || '';
	const args = text.replace(/^\/subscribe\b/i, '').trim();
	if (!args) {
		await context.reply(
			'Uso: /subscribe <scanner|analysis> key=value ...\n' +
			'Ejemplos:\n' +
			'  /subscribe scanner scans=top_gainers,top_losers exchange=BINANCE timeframe=4h interval=4h\n' +
			'  /subscribe analysis symbols=BTCUSDT,ETHUSDT exchange=BINANCE timeframe=1D interval=24h',
		);
		return;
	}
	const tokens = args.split(/\s+/);
	const type = tokens.shift();
	if (!type || !['scanner', 'analysis'].includes(type.toLowerCase())) {
		await context.reply('Tipo inválido. Usa `scanner` o `analysis`.');
		return;
	}
	const params = {};
	let interval;
	for (const tok of tokens) {
		const eq = tok.indexOf('=');
		if (eq === -1) continue;
		const key = tok.slice(0, eq).trim().toLowerCase();
		const value = tok.slice(eq + 1).trim();
		if (key === 'interval') {
			interval = value;
		} else if (key === 'scans' || key === 'symbols') {
			params[key] = value.split(',').map((s) => s.trim()).filter(Boolean);
		} else {
			params[key] = value;
		}
	}
	const span = sentryService.startInactiveSpan({
		name: 'telegram.command.subscribe',
		op: 'bot.command',
		forceTransaction: true,
		attributes: {
			'telegram.command': '/subscribe',
			'telegram.chat_id': String(chatId),
			'chat_subscription.type': type.toLowerCase(),
		},
	});
	try {
		const result = await chatSubscriptionService.createSubscription({
			chatId: String(chatId),
			type: type.toLowerCase(),
			params,
			intervalMs: interval,
		});
		const message = result.created
			? `Suscripción creada: ${result.subscription.subscriptionId.split('-')[0]} (${result.subscription.type} cada ${(result.subscription.intervalMs / 3600000).toFixed(2)}h).${result.clamped ? ' Intervalo elevado al mínimo permitido.' : ''}`
			: `Ya tenías esa suscripción activa: ${result.subscription.subscriptionId.split('-')[0]}.`;
		await context.reply(message);
	} catch (error) {
		if (error instanceof ChatSubscriptionValidationError) {
			await context.reply(`Error: ${error.message}`);
		} else {
			sentryService.captureRuntimeError({
				channel: 'telegram',
				error,
				extra: { command: '/subscribe', chatId, type },
			});
			await context.reply('No pude crear la suscripción. Intenta nuevamente.');
		}
	} finally {
		sentryService.endSpan(span);
	}
}

async function handleListSubscriptionsCommand(context) {
	const chatId = getChatId(context);
	if (!chatId) {
		await context.reply('No pude identificar el chat.');
		return;
	}
	try {
		const list = await chatSubscriptionService.listSubscriptions({ chatId: String(chatId), limit: MAX_LIST_ENTRIES });
		if (!list || list.length === 0) {
			await context.reply('No tienes suscripciones activas. Usa `/subscribe scanner ...` o `/subscribe analysis ...` para empezar.');
			return;
		}
		const header = `Tienes ${list.length} suscripción(es) activa(s):`;
		const body = list.map(formatListEntry).join('\n\n');
		await context.reply(`${header}\n\n${body}`);
	} catch (error) {
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: { command: '/subscriptions', chatId },
		});
		await context.reply('No pude listar las suscripciones. Intenta nuevamente.');
	}
}

async function handleUnsubscribeCommand(context) {
	const chatId = getChatId(context);
	if (!chatId) {
		await context.reply('No pude identificar el chat.');
		return;
	}
	const text = (context.message && context.message.text) || '';
	const args = text.replace(/^\/unsubscribe\b/i, '').trim();
	const all = args === '--all' || args === 'all' || args === '';
	let subscriptionId = null;
	if (!all) {
		subscriptionId = args.split(/\s+/)[0];
	}
	try {
		const result = await chatSubscriptionService.deleteSubscription({
			chatId: String(chatId),
			subscriptionId,
			all,
		});
		if (result.deleted === 0) {
			await context.reply('No se encontró ninguna suscripción para cancelar.');
		} else {
			await context.reply(`Canceladas ${result.deleted} suscripción(es).`);
		}
	} catch (error) {
		sentryService.captureRuntimeError({
			channel: 'telegram',
			error,
			extra: { command: '/unsubscribe', chatId, subscriptionId, all },
		});
		await context.reply('No pude cancelar la suscripción.');
	}
}

module.exports = {
	handleSubscribeCommand,
	handleListSubscriptionsCommand,
	handleUnsubscribeCommand,
	formatListEntry,
};
