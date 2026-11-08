'use strict';

const crypto = require('crypto');
const { smartEscapeMarkdownV2 } = require('../notification/formatters/markdownV2Formatter');
const sentryService = require('../monitoring/SentryService');

const RUNS_COLLECTION = 'digestRuns';
const LOCK_COLLECTION = 'digestLock';
const DEFAULT_DELIVERY_HOUR_UTC = 13;
const DEFAULT_MAX_SPEND_USD = 50;
const LEASE_TTL_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;
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
	if (typeof win.rMultiple === 'number' && Number.isFinite(win.rMultiple)) return win.rMultiple;
	if (typeof win.return === 'number' && Number.isFinite(win.return)) return win.return;
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
			else if (this.lastRunStatus === 'failed' || this.lastRunStatus === 'ambiguous' || this.lastRunStatus === 'degraded') status = 'degraded';
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
		let outcomeSummary = null;
		let outcomes = [];
		let scannerAlerts = [];

		try {
			if (typeof alertStorage.summarizeAlerts === 'function') {
				alertSummary = await alertStorage.summarizeAlerts({ from: fromISO, to: toISO, limit: 1000 });
			}
		} catch (err) { console.warn('[DailyDigest] summarizeAlerts failed:', err.message); }
		try {
			if (typeof outcomeStorage.summarizeOutcomes === 'function') {
				outcomeSummary = await outcomeStorage.summarizeOutcomes({ from: fromISO, to: toISO, window: '1D', limit: 1000 });
			}
		} catch (err) { console.warn('[DailyDigest] summarizeOutcomes failed:', err.message); }
		try {
			if (typeof outcomeStorage.listOutcomes === 'function') {
				const listed = await outcomeStorage.listOutcomes({ from: fromISO, to: toISO, window: '1D', limit: 500 });
				outcomes = Array.isArray(listed?.outcomes) ? listed.outcomes : (Array.isArray(listed) ? listed : []);
			}
		} catch (err) { console.warn('[DailyDigest] listOutcomes failed:', err.message); }
		try {
			if (typeof alertStorage.listAlerts === 'function') {
				const listed = await alertStorage.listAlerts({ limit: 1000 });
				const arr = Array.isArray(listed?.alerts) ? listed.alerts : (Array.isArray(listed) ? listed : []);
				scannerAlerts = arr.filter((a) => {
					const t = a && a.receivedAt ? new Date(a.receivedAt).getTime() : NaN;
					const inWindow = Number.isFinite(t) && t >= day.from.getTime() && t < day.to.getTime();
					return inWindow && SCANNER_SOURCES.has(a.source);
				});
			}
		} catch (err) { console.warn('[DailyDigest] listAlerts failed:', err.message); }

		const bySource = alertSummary?.bySource || {};
		const deliveryByChannel = alertSummary?.delivery?.byChannel || {};
		const totalSpend = Number(alertSummary?.enrichment?.tokenUsage?.totalCost ?? alertSummary?.tokenUsage?.totalCost ?? 0) || 0;
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

		const topScannerHits = topByScore(scannerAlerts, 3, (a) => {
			const s = a?.enrichmentData?.score ?? a?.score ?? a?.confidence;
			const n = Number(s);
			return Number.isFinite(n) ? n : null;
		});
		const topWinners = topByScore(outcomes.filter((o) => outcomeRMultiple(o) !== null), 3, outcomeRMultiple);

		return {
			dateStr: day.dateStr,
			fromISO, toISO,
			totalAlerts: alertSummary?.totalAlerts ?? 0,
			bySource,
			byChannel: deliveryByChannel,
			totalSpend,
			maxSpend,
			spendExceeded: totalSpend > maxSpend,
			outcomes: { hitRatePercent, eligible, evaluated, pending },
			topScannerHits,
			topWinners,
		};
	}

	formatDigest(agg) {
		const lines = [];
		lines.push(`*📊 Daily Digest — ${esc(agg.dateStr)}*`);
		lines.push('');
		lines.push(`*Alertas:* ${agg.totalAlerts}`);
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
		const hr = o.hitRatePercent === null || o.hitRatePercent === undefined ? 'N/D' : `${Number(o.hitRatePercent).toFixed(1)}%`;
		lines.push(`*Outcomes \\(maduros 1D\\):* hit\\-rate ${esc(hr)} \\| elegibles ${o.eligible || 0} / evaluados ${o.evaluated || 0} / pendientes ${o.pending || 0}`);
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
		lines.push(`*Gasto LLM:* \\$${esc(Number(agg.totalSpend || 0).toFixed(4))}`);
		if (agg.spendExceeded) {
			lines.push('⚠️ Ayer el gasto LLM superó el presupuesto\\.');
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

	async _defaultSend(chatId, text) {
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
			const msg = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
			return { success: true, messageId: msg?.message_id ? String(msg.message_id) : null };
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
				this.lastRunError = reservation.reason;
			} else if (reservation.reason === 'already-sent') {
				console.log('[DailyDigest] digest already sent, skipping');
				this.lastRunStatus = 'already-sent';
			} else if (reservation.reason === 'ambiguous') {
				console.log('[DailyDigest] digest ambiguous, not retrying automatically');
				this.lastRunStatus = 'ambiguous';
			} else if (reservation.reason === 'reserved-elsewhere') {
				this.lastRunStatus = 'lease-held';
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
			const sendFn = this.sendTelegram || ((c, t) => this._defaultSend(c, t));
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
			await this.markDigestDone(day.dateStr, chatId, token, 'ambiguous', { error: (sent && sent.error) || 'unknown-send-outcome' });
			this.lastRunStatus = 'ambiguous';
			this.lastRunError = (sent && sent.error) || 'unknown-send-outcome';
			return { dryRun: false, sent: false, ambiguous: true, dateStr: day.dateStr, text, error: this.lastRunError };
		} catch (err) {
			// A thrown transport error does not prove non-delivery.
			const code = err?.response?.error_code ?? err?.statusCode;
			const definitive = (code === 400 && /bad request/i.test(err.message || '')) || /chat not found/i.test(err.message || '');
			const terminal = definitive ? 'failed' : 'ambiguous';
			await this.markDigestDone(day.dateStr, chatId, token, terminal, { error: err.message });
			this.lastRunStatus = terminal;
			this.lastRunError = err.message;
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
