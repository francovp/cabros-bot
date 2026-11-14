const DEFAULT_TIMEOUT_MS = 60000;
const COMPONENTS = ['telegramBot', 'notificationServices', 'newsMonitor'];

// Public surfaces (`GET /ready`) are unauthenticated, so bootstrap failures
// are exposed as stable machine codes only; raw provider error text (which
// can embed credentials or Telegram descriptions) stays server-side (#1296).
function toStableErrorCode(error) {
	const message = error instanceof Error ? error.message : String(error || 'Bootstrap failed');
	if (/getUpdates|terminated by other|\b409\b/.test(message)) {
		return 'TELEGRAM_POLLING_CONFLICT';
	}
	if (/did not complete within/i.test(message)) {
		return 'BOOTSTRAP_TIMEOUT';
	}
	if (/^\s*(telegram|telegraf|bot_token)/i.test(message)
		|| /failed to launch telegram/i.test(message)
		|| /_launch failed$/i.test(message)
		|| /launch failed$/i.test(message)) {
		return 'TELEGRAM_BOOTSTRAP_FAILED';
	}
	if (/polling/i.test(message) && /telegram|bot/i.test(message)) {
		return 'TELEGRAM_BOOTSTRAP_FAILED';
	}
	return 'BOOTSTRAP_FAILED';
}

let timeoutId;
let state = createState();

function createState() {
	return {
		status: 'pending',
		ready: false,
		startedAt: null,
		completedAt: null,
		failedAt: null,
		errorCode: null,
		components: Object.fromEntries(COMPONENTS.map((name) => [name, { status: 'pending' }])),
	};
}

function clearTimeoutIfSet() {
	if (timeoutId) {
		clearTimeout(timeoutId);
		timeoutId = undefined;
	}
}

function begin({ telegramRequired = false, newsMonitorRequired = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	clearTimeoutIfSet();
	state = createState();
	state.startedAt = new Date().toISOString();
	if (!telegramRequired) state.components.telegramBot.status = 'disabled';
	if (!newsMonitorRequired) state.components.newsMonitor.status = 'disabled';

	const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
	timeoutId = setTimeout(() => fail(new Error(`Bootstrap did not complete within ${effectiveTimeoutMs}ms`)), effectiveTimeoutMs);
	return getStatus();
}

function markReady(component) {
	return markComponent(component, 'ready');
}

function markDisabled(component) {
	return markComponent(component, 'disabled');
}

function markFailed(component, error) {
	if (state.components[component]) state.components[component] = { status: 'failed' };
	return fail(error);
}

function markComponent(component, status) {
	if (state.status === 'failed' || !state.components[component]) return getStatus();
	state.components[component] = { status };
	if (COMPONENTS.every((name) => ['ready', 'disabled'].includes(state.components[name].status))) {
		state.status = 'ready';
		state.ready = true;
		state.completedAt = new Date().toISOString();
		clearTimeoutIfSet();
	}
	return getStatus();
}

function fail(error) {
	if (state.status === 'failed') return getStatus();
	state.status = 'failed';
	state.ready = false;
	state.failedAt = new Date().toISOString();
	state.errorCode = toStableErrorCode(error);
	console.error('[bootstrap] failed:', error instanceof Error ? error.message : String(error || 'Bootstrap failed'));
	clearTimeoutIfSet();
	return getStatus();
}

function reset() {
	clearTimeoutIfSet();
	state = createState();
}

function getStatus() {
	return JSON.parse(JSON.stringify(state));
}

module.exports = {
	DEFAULT_TIMEOUT_MS,
	begin,
	markReady,
	markDisabled,
	markFailed,
	fail,
	reset,
	getStatus,
	toStableErrorCode,
};
