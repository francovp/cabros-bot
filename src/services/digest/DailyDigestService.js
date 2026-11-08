'use strict';

const crypto = require('crypto');
const { smartEscapeMarkdownV2 } = require('../notification/formatters/markdownV2Formatter');
const { redactString } = require('../../lib/logging');
const sentryService = require('../monitoring/SentryService');

const RUNS_COLLECTION = 'digestRuns';
const LOCK_COLLECTION = 'digestLock';
const DEFAULT_DELIVERY_HOUR_UTC = 13;
const DEFAULT_MAX_SPEND_USD = 50;
const LEASE_TTL_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_SEND_TIMEOUT_MS = 10000;
const SCANNER_SOURCES = new Set(['market-scanner', 'scanner-preset']);

function parseHour(value) {
	const raw = value === undefined || value === null || value === '' ? DEFAULT_DELIVERY_HOUR_UTC : Number(value);
	if (!Number.isInteger(raw) || raw < 0 || raw > 23) return DEFAULT_DELIVERY_HOUR_UTC;
	return raw;
}

function parseSpend(value) {
	const raw = value === undefined || value === null || value === '' ? DEFAULT_MAX_SPEND_USD : Number(value);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_SPEND_USD;
	return raw;
}

function previousUtcDay(now = new Date()) {
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
	const from = new Date(d.getTime() - 24 * 60 * 60 * 1000);
	const to = d;
	const dateStr = from.toISOString().slice(0, 10);
	return { dateStr, from, to, fromISO: from.toISOString(), toISO: to.toISOString() };
}

function esc(value) {
	if (value === undefined || value === null) return 'N/D';
	return smartEscapeMarkdownV2(String(value));
}

function sanitizeTelegramError(err) {
	if (!err) return 'unknown-error';
	let msg = typeof err === 'string' ? err : (err.message || String(err));
	msg = msg.replace(/(\/bot)[^/\s?#]+/gi, '$1[REDACTED]');
	msg = redactString(msg);
	if (msg.length > 256) msg = msg.slice(0, 256);
	return msg;
}

function topByScore(items, n = 3, pickScore) {
	const scored = [];
	for (const item of items || []) {
		const s = pickScore(item);
		if (typeof s === 'number' && Number.isFinite(s)) scored.push({ item, s });
	}
	scored.sort((a, b) => b.s - a.s);
	return scored.slice(0, n).map((x) => x.item);
}

function outcomeRMultiple(outcome) {
	const win = outcome && outcome.outcomes && outcome.outcomes['1D'];
	if (!win || win.status !== 'evaluated') return null;
	// Only genuine risk multiples rank as R winners. `return` is a percentage
	// for stop-less signals and must never be ranked/labelled as R.
	if (typeof win.rMultiple === 'number' && Number.isFinite(win.rMultiple)) return win.rMultiple;
	return null;
}

class DailyDigestService {
	constructor(options = {}) {
		this.getAlertStorage = options.getAlertStorage || (() => require('../storage/AlertStorageService'));
		this.getOutcomeStorage = options.getOutcomeStorage || (() => require('../storage/SignalOutcomeService'));
		this.getFirestoreFn = options.getFirestoreFn || (() => {
			try { return this.getAlertStorage().getFirestore(); } catch { return null; }
		});
		this.sendTelegram = options.sendTelegram || null;
		this.botGetter = options.botGetter || null;
		this.workerId = options.workerId || `${process.pid}-${crypto.randomUUID()}`;
		this.running = false;
		this.timer = null;
		this.shutdownRequested = false;
		this.activeRunPromise = null;
		this.lastRunAt = null;
		this.lastRunStatus = 'never';
		this.lastRunDateStr = null;
		this.lastRunKey = null;
		this.lastRunDigestMessageId = null;
		this.lastRunError = null;
		this.dailyChats = [];
		this.leaseState = 'unheld';
	}

	isEnabled() { return process.env.ENABLE_DAILY_DIGEST === 'true'; }
	isFirestoreDigestRunsEnabled() { return process.env.ENABLE_FIRESTORE_DIGEST_RUNS === 'true'; }
	getDeliveryHourUtc() { return parseHour(process.env.DIGEST_DELIVERY_HOUR_UTC); }
	getMaxSpendUsd() { return parseSpend(process.env.DIGEST_MAX_PREVIOUS_DAY_SPEND_USD); }
	getDigestChatId() {
		const v = process.env.TELEGRAM_DIGEST_CHAT_ID;
		return v && String(v).trim() ? String(v).trim() : null;
	}

	getStatus() {
		const enabled = this.isEnabled();
		const durableEnabled = this.isFirestoreDigestRunsEnabled();
		const chatConfigured = Boolean(this.getDigestChatId());
		let status = 'disabled';
		if (enabled) {
			if (!durableEnabled || !chatConfigured) status = 'degraded';
			else if (this.lastRunStatus === 'failed' || this.lastRunStatus === 'ambiguous' || this.lastRunStatus === 'degraded' || this.lastRunStatus === 'rate-limited') status = 'degraded';
			else status = 'ready';
		}
		return {
			enabled,
			configured: chatConfigured && durableEnabled,
			ready: status === 'ready',
			status,
			backend: durableEnabled ? 'firestore' : 'memory',
			deliveryHourUtc: this.getDeliveryHourUtc(),
			maxSpendUsd: this.getMaxSpendUsd(),
			running: this.running,
			lastRunAt: this.lastRunAt ? new Date(this.lastRunAt).toISOString() : null,
			lastRunStatus: this.lastRunStatus,
			lastRunDateStr: this.lastRunDateStr,
			lastRunDigestMessageId: this.lastRunDigestMessageId,
			lastRunError: this.lastRunError,
			dailyChats: this.dailyChats,
			leaseState: this.leaseState,
		};
	}

	async aggregateForDay(day, options = {}) {
		const alertStorage = this.getAlertStorage();
		const outcomeStorage = this.getOutcomeStorage();
		const fromISO = day.fromISO || day.from.toISOString();
		const toISO = day.toISO || day.to.toISOString();

		let alertSummary = null;
		let alertSummaryFailed = false;
		let outcomeSummary = null;
		let outcomeSummaryFailed = false;
		let outcomes = [];

		try {
			if (typeof alertStorage.summarizeAlerts === 'function') {
				alertSummary = await alertStorage.summarizeAlerts({ from: fromISO, to: toISO, limit: 1000 });
			}
		} catch (err) {
			alertSummaryFailed = true;
			console.warn('[DailyDigest] summarizeAlerts failed:', err.message);
		}
		try {
			if (typeof outcomeStorage.summarizeOutcomes === 'function') {
				outcomeSummary = await outcomeStorage.summarizeOutcomes({ from: fromISO, to: toISO, window: '1D', limit: 1000 });
			}
		} catch (err) {
			outcomeSummaryFailed = true;
			console.warn('[DailyDigest] summarizeOutcomes failed:', err.message);
		}
		try {
			if (typeof outcomeStorage.listOutcomes === 'function') {
				// listOutcomes clamps to MAX_LIMIT 100 per page; page through the
				// whole previous-day cohort before ranking winners.
				let before;
				for (let page = 0; page < 10; page += 1) {
					const listed = await outcomeStorage.listOutcomes({ from: fromISO, to: toISO, window: '1D', limit: 100, ...(before ? { before } : {}) });
					const arr = Array.isArray(listed?.outcomes) ? listed.outcomes : (Array.isArray(listed) ? listed : []);
					outcomes.push(...arr);
					if (!listed?.hasMore || !listed?.nextBefore || arr.length === 0) break;
					before = listed.nextBefore;
				}
			}
		} catch (err) { console.warn('[DailyDigest] listOutcomes failed:', err.message); }
		// Scanner hits come from persisted outcome records, not alert docs.
		// Market-scanner alerts persist enrichmentData:null with no score; the
		// per-signal outcomes are what recordMarketScannerOutcomes actually writes.

		const alertsUnavailable = alertSummaryFailed || !alertSummary;
		const alertsTruncated = Boolean(alertSummary && alertSummary.totalAlerts >= 1000);
		const bySource = alertsUnavailable ? {} : (alertSummary?.bySource || {});
		const deliveryByChannel = alertsUnavailable ? {} : (alertSummary?.delivery?.byChannel || {});
		const totalSpend = alertsUnavailable ? null : (Number(alertSummary?.enrichment?.tokenUsage?.totalCost ?? alertSummary?.tokenUsage?.totalCost ?? 0) || 0);
		const maxSpend = this.getMaxSpendUsd();

		let hitRatePercent = null;
		let eligible = 0; let evaluated = 0; let pending = 0;
		if (outcomeSummary && typeof outcomeSummary === 'object') {
			eligible = outcomeSummary.totalSignalsEligible ?? outcomeSummary.eligible ?? eligible;
			evaluated = outcomeSummary.totalSignalsEvaluated ?? outcomeSummary.evaluated ?? evaluated;
			pending = outcomeSummary.totalSignalsPending ?? outcomeSummary.pending ?? pending;
			// summarizeOutcomes returns per-window metrics under windows['1D'].hitRatePercent.
			const win = outcomeSummary.windows && outcomeSummary.windows['1D'];
			if (win && typeof win.hitRatePercent === 'number' && Number.isFinite(win.hitRatePercent)) {
				hitRatePercent = win.hitRatePercent;
			} else if (outcomeSummary.hitRatePercent !== undefined && outcomeSummary.hitRatePercent !== null) {
				hitRatePercent = outcomeSummary.hitRatePercent;
			}
		}

		const scannerCandidates = outcomes.filter((o) => SCANNER_SOURCES.has(o.source));
		// Separate ranked candidates (which store conviction in [-1, 1] or confidenceScore)
		// from unranked preset scans that store raw RSI (0-100), changePercent, or volume_ratio.
		const rankedCandidates = scannerCandidates.filter(
			(o) => typeof o.score === 'number' && Number.isFinite(o.score) && (
				(typeof o.confidenceScore === 'number' && Number.isFinite(o.confidenceScore)) ||
				Math.abs(o.score) <= 1
			),
		);
		const scannerPool = rankedCandidates.length > 0 ? rankedCandidates : scannerCandidates;
		const topScannerHits = topByScore(
			scannerPool,
			3,
			(o) => {
				if (typeof o.score !== 'number' || !Number.isFinite(o.score)) return null;
				return Math.abs(o.score) <= 1 ? Math.abs(o.score) : Math.abs(o.score) / 100;
			},
		);
		const topWinners = topByScore(outcomes.filter((o) => outcomeRMultiple(o) !== null), 3, outcomeRMultiple);

		return {
			dateStr: day.dateStr,
			fromISO, toISO,
			alertsUnavailable,
			alertsTruncated,
			totalAlerts: alertsUnavailable ? null : (alertSummary?.totalAlerts ?? 0),
			bySource,
			byChannel: deliveryByChannel,
			totalSpend,
			maxSpend,
			spendExceeded: totalSpend !== null ? totalSpend > maxSpend : false,
			outcomes: { hitRatePercent, eligible, evaluated, pending },
			outcomesUnavailable: outcomeSummaryFailed,
			topScannerHits,
			topWinners,
		};
	}

	formatDigest(agg) {
		const lines = [];
		lines.push(`*📊 Daily Digest — ${esc(agg.dateStr)}*`);
		lines.push('');
		if (agg.alertsUnavailable) {
			lines.push('*Alertas:* N/D');
		} else if (agg.alertsTruncated) {
			lines.push(`*Alertas:* ${agg.totalAlerts}\\+ \\(límite 1000 alcanzado\\)`);
		} else {
			lines.push(`*Alertas:* ${agg.totalAlerts ?? 0}`);
		}
		const sources = Object.entries(agg.bySource || {});
		if (sources.length) lines.push(`*Por fuente:* ${sources.map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}`);
		const channels = Object.entries(agg.byChannel || {});
		if (channels.length) {
			lines.push(`*Por canal:* ${channels.map(([k, v]) => {
				const ok = v && typeof v.success === 'number' ? ` ${v.success}/${v.total ?? ''}` : '';
				return `${esc(k)}${esc(ok)}`;
			}).join(' · ')}`);
		}
		const o = agg.outcomes || {};
		if (agg.outcomesUnavailable) {
			lines.push('*Outcomes \\(maduros 1D\\):* N/D');
		} else {
			const hr = o.hitRatePercent === null || o.hitRatePercent === undefined ? 'N/D' : `${Number(o.hitRatePercent).toFixed(1)}%`;
			lines.push(`*Outcomes \\(maduros 1D\\):* hit\\-rate ${esc(hr)} \\| elegibles ${o.eligible || 0} / evaluados ${o.evaluated || 0} / pendientes ${o.pending || 0}`);
		}
		if ((agg.topScannerHits || []).length) {
			lines.push('');
			lines.push('*Top scanner hits:*');
			agg.topScannerHits.forEach((a, i) => {
				const sym = a.symbol || a.enrichmentData?.symbol || 'N/D';
				lines.push(`${i + 1}\\. ${esc(`${a.exchange ? `${a.exchange}:` : ''}${sym}`)}`);
			});
		}
		if ((agg.topWinners || []).length) {
			lines.push('');
			lines.push('*Top outcome winners:*');
			agg.topWinners.forEach((w, i) => {
				const sym = w.symbol || 'N/D';
				const r = outcomeRMultiple(w);
				lines.push(`${i + 1}\\. ${esc(`${w.exchange ? `${w.exchange}:` : ''}${sym} R=${r === null ? 'N/D' : r.toFixed(2)}`)}`);
			});
		}
		lines.push('');
		if (agg.alertsUnavailable) {
			lines.push('*Gasto LLM:* N/D');
		} else {
			const spendSuffix = agg.alertsTruncated ? '\\+ \\(parcial\\)' : '';
			lines.push(`*Gasto LLM:* \\$${esc(Number(agg.totalSpend || 0).toFixed(4))}${spendSuffix}`);
			if (agg.spendExceeded) {
				lines.push('⚠️ Ayer el gasto LLM superó el presupuesto\\.');
			} else if (agg.alertsTruncated) {
				lines.push('⚠️ Muestra limitada a 1000 alertas; no se puede descartar exceso de presupuesto\\.');
			}
		}
		return lines.join('\n');
	}

	_digestDocId(dateStr, chatId) {
		const h = crypto.createHash('sha256').update(String(chatId)).digest('hex').slice(0, 16);
		return `${dateStr}__${h}`;
	}

	async reserveDigest(dateStr, chatId) {
		if (!this.isFirestoreDigestRunsEnabled()) {
			return { ok: false, reason: 'digest-runs-disabled', degraded: true };
		}
		const firestore = this.getFirestoreFn();
		if (!firestore) return { ok: false, reason: 'firestore-unavailable', degraded: true };
		const docId = this._digestDocId(dateStr, chatId);
		const ref = firestore.collection(RUNS_COLLECTION).doc(docId);
		const token = crypto.randomUUID();
		try {
			const result = await firestore.runTransaction(async (tx) => {
				const snap = await tx.get(ref);
				if (snap.exists) {
					const data = snap.data() || {};
					if (data.status === 'sent') return { outcome: 'already-sent', data };
					if (data.status === 'ambiguous') return { outcome: 'ambiguous', data };
					if (data.status === 'sending') return { outcome: 'ambiguous', data };
					if (data.status === 'reserved') {
						const ts = data.reservedAt ? new Date(data.reservedAt).getTime() : 0;
						if (Date.now() - ts < LEASE_TTL_MS) return { outcome: 'reserved-elsewhere', data };
					}
					if (data.status === 'rate-limited') {
						const ts = data.updatedAt ? new Date(data.updatedAt).getTime() : (data.reservedAt ? new Date(data.reservedAt).getTime() : 0);
						const retryAfterMs = (data.retryAfterSeconds || 60) * 1000;
						if (Date.now() - ts < retryAfterMs) return { outcome: 'rate-limited', data };
					}
				}
				tx.set(ref, {
					status: 'reserved',
					dateStr,
					chatIdHash: crypto.createHash('sha256').update(String(chatId)).digest('hex').slice(0, 16),
					reservedAt: new Date().toISOString(),
					reservedBy: this.workerId,
					claimToken: token,
					updatedAt: new Date().toISOString(),
				});
				return { outcome: 'reserved', token };
			});
			this.leaseState = result.outcome;
			return { ok: result.outcome === 'reserved', reason: result.outcome, token: result.token, data: result.data };
		} catch (err) {
			console.warn('[DailyDigest] reserve failed:', err.message);
			return { ok: false, reason: 'firestore-unavailable', degraded: true, error: err.message };
		}
	}

	async markDigestDone(dateStr, chatId, token, status, extra = {}) {
		const firestore = this.getFirestoreFn();
		if (!firestore) return false;
		const ref = firestore.collection(RUNS_COLLECTION).doc(this._digestDocId(dateStr, chatId));
		try {
			const ok = await firestore.runTransaction(async (tx) => {
				const snap = await tx.get(ref);
				if (!snap.exists) return false;
				const data = snap.data() || {};
				if (token && data.claimToken !== token) return false;
				tx.set(ref, {
					status,
					updatedAt: new Date().toISOString(),
					...extra,
				}, { merge: true });
				return true;
			});
			return Boolean(ok);
		} catch (err) { console.warn('[DailyDigest] mark done failed:', err.message); return false; }
	}

	async _defaultSend(chatId, text, options = {}) {
		const timeoutMs = options.timeoutMs || DEFAULT_SEND_TIMEOUT_MS;
		const bot = this.botGetter ? this.botGetter() : null;
		if (!bot) {
			const { getNotificationManager } = require('../../controllers/webhooks/handlers/alert/alert');
			const mgr = getNotificationManager();
			if (mgr) {
				const results = await mgr.sendToChannels({ text, source: 'daily-digest' }, ['telegram'], { telegramChatId: chatId });
				const r = Array.isArray(results) ? results.find((x) => x.channel === 'telegram') : null;
				return { success: Boolean(r && r.success), messageId: r?.messageId || r?.messageIds || null, error: r?.error || null };
			}
			throw new Error('Bot instance not available');
		}
		if (typeof bot.telegram?.sendMessage === 'function') {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new Error('Telegram send timeout')), timeoutMs);
			if (timer.unref) timer.unref();
			try {
				const msg = await Promise.race([
					bot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', signal: controller.signal }),
					new Promise((_, reject) => {
						controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new Error('Telegram send timeout')), { once: true });
					}),
				]);
				return { success: true, messageId: msg?.message_id ? String(msg.message_id) : null };
			} finally {
				clearTimeout(timer);
			}
		}
		throw new Error('Bot telegram not available');
	}

	async runDigestForDay(day, options = {}) {
		const dryRun = Boolean(options.dryRun);
		const chatId = options.chatId || this.getDigestChatId();
		const agg = await this.aggregateForDay(day, options);
		const text = this.formatDigest(agg);
		if (dryRun) {
			return { dryRun: true, dateStr: day.dateStr, text, aggregation: agg };
		}
		if (agg.alertsUnavailable) {
			this.lastRunStatus = 'degraded';
			this.lastRunError = 'alert-summary-unavailable';
			return { dryRun: false, skipped: true, reason: 'alert-summary-unavailable', dateStr: day.dateStr, text };
		}
		if (!chatId) {
			this.lastRunStatus = 'degraded';
			this.lastRunError = 'digest-chat-not-configured';
			return { dryRun: false, skipped: true, reason: 'digest-chat-not-configured', dateStr: day.dateStr, text };
		}
		// Decision: durable reservation is mandatory for a real send.
		const reservation = await this.reserveDigest(day.dateStr, chatId);
		if (!reservation.ok) {
			if (reservation.degraded) {
				this.lastRunStatus = 'degraded';
				this.lastRunError = sanitizeTelegramError(reservation.reason);
			} else if (reservation.reason === 'already-sent') {
				console.log('[DailyDigest] digest already sent, skipping');
				this.lastRunStatus = 'already-sent';
			} else if (reservation.reason === 'ambiguous') {
				console.log('[DailyDigest] digest ambiguous, not retrying automatically');
				this.lastRunStatus = 'ambiguous';
			} else if (reservation.reason === 'reserved-elsewhere') {
				this.lastRunStatus = 'lease-held';
			} else if (reservation.reason === 'rate-limited') {
				console.log('[DailyDigest] digest destination rate-limited, cooling down');
				this.lastRunStatus = 'rate-limited';
			}
			this.lastRunDateStr = day.dateStr;
			this.lastRunAt = new Date();
			return { dryRun: false, skipped: true, reason: reservation.reason, dateStr: day.dateStr, text };
		}
		const token = reservation.token;
		// Persist the send-attempt checkpoint BEFORE sending so a failed
		// terminal mark cannot leave a reclaimable 'reserved' doc.
		await this.markDigestDone(day.dateStr, chatId, token, 'sending', { sendingAt: new Date().toISOString() });
		try {
			const sendFn = this.sendTelegram || ((c, t) => this._defaultSend(c, t, options));
			const sent = await sendFn(chatId, text);
			if (sent && sent.success) {
				await this.markDigestDone(day.dateStr, chatId, token, 'sent', { sentAt: new Date().toISOString(), messageId: sent.messageId || null });
				this.lastRunStatus = 'sent';
				this.lastRunDigestMessageId = sent.messageId || null;
				this.dailyChats = [crypto.createHash('sha256').update(String(chatId)).digest('hex').slice(0, 12)];
				this.lastRunKey = `${day.dateStr}|${chatId}`;
				return { dryRun: false, sent: true, dateStr: day.dateStr, text, messageId: sent.messageId || null };
			}
			// Ambiguous: provider accepted but we cannot prove it. Per decision, do not auto-retry.
			const sendErr = sanitizeTelegramError((sent && sent.error) || 'unknown-send-outcome');
			await this.markDigestDone(day.dateStr, chatId, token, 'ambiguous', { error: sendErr });
			this.lastRunStatus = 'ambiguous';
			this.lastRunError = sendErr;
			return { dryRun: false, sent: false, ambiguous: true, dateStr: day.dateStr, text, error: this.lastRunError };
		} catch (err) {
			const sanitizedError = sanitizeTelegramError(err);
			const code = err?.response?.error_code ?? err?.statusCode;
			const is429 = code === 429 || /429|too many requests/i.test(err?.message || '');
			const isDefinitiveFailure = (code === 400 && /bad request/i.test(err?.message || '')) || /chat not found/i.test(err?.message || '');

			if (is429) {
				const retryAfterSeconds = err?.response?.parameters?.retry_after ?? err?.retry_after ?? 60;
				await this.markDigestDone(day.dateStr, chatId, token, 'rate-limited', {
					error: sanitizedError,
					retryAfterSeconds: typeof retryAfterSeconds === 'number' ? retryAfterSeconds : 60,
				});
				this.lastRunStatus = 'rate-limited';
				this.lastRunError = sanitizedError;
				sentryService.captureRuntimeError?.({ channel: 'telegram', error: err, extra: { feature: 'daily-digest', status: 'rate-limited' } });
				throw err;
			}

			// A thrown transport error does not prove non-delivery.
			const terminal = isDefinitiveFailure ? 'failed' : 'ambiguous';
			await this.markDigestDone(day.dateStr, chatId, token, terminal, { error: sanitizedError });
			this.lastRunStatus = terminal;
			this.lastRunError = sanitizedError;
			sentryService.captureRuntimeError?.({ channel: 'telegram', error: err, extra: { feature: 'daily-digest' } });
			throw err;
		} finally {
			this.lastRunAt = new Date();
			this.lastRunDateStr = day.dateStr;
		}
	}

	async runScheduledCheck(now = new Date()) {
		if (!this.isEnabled()) return { skipped: true, reason: 'disabled' };
		const hour = this.getDeliveryHourUtc();
		if (now.getUTCHours() < hour) return { skipped: true, reason: 'before-delivery-hour' };
		const day = previousUtcDay(now);
		const destChatId = this.getDigestChatId();
		const key = `${day.dateStr}|${destChatId}`;
		if (this.lastRunKey === key && this.lastRunStatus === 'sent') return { skipped: true, reason: 'already-sent' };
		this.activeRunPromise = this.runDigestForDay(day);
		try {
			return await this.activeRunPromise;
		} finally {
			this.activeRunPromise = null;
		}
	}

	startWorker() {
		if (!this.isEnabled() || this.running) return false;
		this.running = true;
		this.shutdownRequested = false;
		const tick = async () => {
			if (!this.running || this.shutdownRequested) return;
			try { await this.runScheduledCheck(); } catch (err) { console.error('[DailyDigest] scheduled run failed:', err.message); }
			if (this.running && !this.shutdownRequested) {
				this.timer = setTimeout(tick, CHECK_INTERVAL_MS);
				if (this.timer.unref) this.timer.unref();
			}
		};
		this.timer = setTimeout(tick, CHECK_INTERVAL_MS);
		if (this.timer.unref) this.timer.unref();
		return true;
	}

	async stopWorker(options = {}) {
		const { drain = true, timeoutMs = 10000 } = options;
		this.running = false;
		this.shutdownRequested = true;
		if (this.timer) { clearTimeout(this.timer); this.timer = null; }
		if (drain && this.activeRunPromise) {
			await Promise.race([this.activeRunPromise, new Promise((r) => setTimeout(r, timeoutMs))]);
		}
	}

	getBotGetter() { return this.botGetter; }
	setBotGetter(fn) { this.botGetter = fn; }
}

const dailyDigestService = new DailyDigestService();

module.exports = {
	DailyDigestService,
	dailyDigestService,
	previousUtcDay,
	RUNS_COLLECTION,
	LOCK_COLLECTION,
};
