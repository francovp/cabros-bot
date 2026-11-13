'use strict';

/**
 * Post-submit bookkeeping for live auto-trade orders (#1494).
 *
 * Mirrors what the manual order controller does (trade ledger, order audit)
 * and adds an operator notification (Telegram admin chat + admin SSE event).
 *
 * Fail-open by contract: every step is isolated, never throws, and never
 * touches the durable reservation state owned by the caller.
 */

const { binanceOrderAuditService } = require('./BinanceOrderAuditService');
const { tradeLedgerService } = require('./TradeLedgerService');
const { adminSseService } = require('../sse/AdminSseService');

const ORIGIN = 'auto_trade';

async function safely(label, fn) {
	try {
		return await fn();
	} catch (error) {
		console.warn(`[AutoTradeOutcomeRecorder] ${label} failed (fail-open):`, error?.message || error);
		return undefined;
	}
}

function formatOutcomeMessage(outcome) {
	const { status, symbol, side, reservationId, errorCode, order, environment } = outcome;
	const env = environment ? ` (${environment})` : '';
	if (status === 'submitted') {
		return [
			`✅ Auto-trade order filled${env}`,
			`${side || ''} ${symbol}`.trim(),
			`Executed qty: ${order?.executedQty ?? 'n/a'}`,
			`Quote spent: ${order?.cummulativeQuoteQty ?? 'n/a'}`,
			`Avg price: ${outcome.avgPrice ?? 'n/a'}`,
			...(order?.orderId !== undefined && order?.orderId !== null ? [`Order ID: ${order.orderId}`] : []),
		].join('\n');
	}
	if (status === 'unknown') {
		return [
			`⚠️ Auto-trade order status UNKNOWN${env}`,
			`${side || ''} ${symbol}`.trim(),
			`Reconcile: GET /api/trading/binance/reconciliation/${reservationId || '<reservationId>'}`,
		].join('\n');
	}
	return [
		`❌ Auto-trade order failed${env}`,
		`${side || ''} ${symbol}`.trim(),
		`Error code: ${errorCode || 'UNKNOWN'}`,
	].join('\n');
}

function computeAvgPrice(order) {
	const qty = Number(order?.executedQty);
	const quote = Number(order?.cummulativeQuoteQty);
	if (!Number.isFinite(qty) || !Number.isFinite(quote) || qty <= 0) return null;
	return String(quote / qty);
}

async function notifyOperator(message) {
	const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	if (!adminChatId) return false;
	// Lazy require: the alert controller imports the router, so a top-level
	// import would be circular.
	const { getNotificationManager } = require('../../controllers/webhooks/handlers/alert/alert');
	const manager = typeof getNotificationManager === 'function' ? getNotificationManager() : null;
	const telegram = manager?.channels?.get?.('telegram');
	if (!telegram || typeof telegram.send !== 'function' || !telegram.isEnabled()) return false;
	// TelegramService formats with MarkdownV2 escaping.
	const res = await telegram.send({ text: message, telegramChatId: adminChatId });
	return Boolean(res && res.success);
}

/**
 * @param {Object} params
 * @param {'submitted'|'failed'|'unknown'} params.status
 * @param {Object} params.order - normalized auto-trade order intent
 * @param {Object} [params.result] - placeOrder result (submitted)
 * @param {Object} [params.error] - placeOrder error (failed/unknown)
 * @param {Object} [params.reservation]
 * @param {string} [params.signalId]
 * @param {string} [params.alertId]
 * @param {string} [params.idempotencyKey]
 * @param {number} [params.processingMs]
 */
async function recordAutoTradeOutcome({
	status, order, result, error, reservation, signalId, alertId, idempotencyKey, processingMs,
}) {
	try {
		const placed = result?.order || null;
		const environment = result?.environment || error?.environment;
		const provenanceAlertId = alertId || signalId || null;
		const reservationId = reservation?.id || reservation?.docRef?.id || null;
		const errorCode = error?.code || 'AUTO_TRADE_ORDER_FAILED';

		if (status === 'submitted' && placed && !result?.dryRun) {
			await safely('trade ledger fill recording', () => tradeLedgerService.recordOrderFills({
				environment,
				order: placed,
				origin: ORIGIN,
				alertId: provenanceAlertId,
				setupType: result?.setupType,
			}));
		}

		await safely('order audit', () => binanceOrderAuditService.recordMutation({
			operator: ORIGIN,
			idempotencyKey,
			request: order,
			action: 'PLACE',
			symbol: placed?.symbol || order?.symbol,
			side: placed?.side || order?.side || null,
			type: placed?.type || order?.type || null,
			quantity: placed?.origQty ?? null,
			quoteOrderQty: placed?.quoteOrderQty ?? order?.quoteOrderQty ?? null,
			price: placed?.price ?? null,
			timeInForce: placed?.timeInForce ?? null,
			status: status === 'submitted'
				? (placed?.status || 'SUBMITTED')
				: (status === 'unknown' ? 'ambiguous' : 'rejected'),
			...(status === 'submitted' ? {} : { errorCode }),
			dryRun: false,
			environment,
			binanceOrderId: placed?.orderId ?? null,
			clientOrderId: placed?.clientOrderId ?? error?.clientOrderId ?? null,
			origin: ORIGIN,
			alertId: provenanceAlertId,
			response: status === 'submitted' ? result : { error: error?.message, code: errorCode },
			processingMs,
		}));

		const outcome = {
			status,
			symbol: placed?.symbol || order?.symbol,
			side: placed?.side || order?.side,
			reservationId,
			errorCode: status === 'submitted' ? undefined : errorCode,
			order: placed,
			avgPrice: computeAvgPrice(placed),
			environment,
		};

		await safely('operator notification', () => notifyOperator(formatOutcomeMessage(outcome)));

		await safely('admin SSE event', () => {
			adminSseService.broadcast('auto-trade-outcome', {
				status,
				symbol: outcome.symbol,
				side: outcome.side,
				environment: environment || null,
				orderId: placed?.orderId ?? null,
				executedQty: placed?.executedQty ?? null,
				quoteSpent: placed?.cummulativeQuoteQty ?? null,
				avgPrice: outcome.avgPrice,
				errorCode: outcome.errorCode || null,
				reservationId,
				timestamp: new Date().toISOString(),
			});
		});
	} catch (err) {
		console.warn('[AutoTradeOutcomeRecorder] unexpected failure (fail-open):', err?.message || err);
	}
}

module.exports = { recordAutoTradeOutcome, formatOutcomeMessage };
