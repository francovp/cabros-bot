const DEFAULT_TIMEOUT_MS = 60000;
const COMPONENTS = ['telegramBot', 'notificationServices', 'newsMonitor'];

let timeoutId;
let state = createState();

function createState() {
	return {
		status: 'pending',
		ready: false,
		startedAt: null,
		completedAt: null,
		failedAt: null,
		error: null,
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
	if (state.status !== 'pending' || !state.components[component]) return getStatus();
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
	if (state.status !== 'pending') return getStatus();
	state.status = 'failed';
	state.ready = false;
	state.failedAt = new Date().toISOString();
	state.error = error instanceof Error ? error.message : String(error || 'Bootstrap failed');
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
};
