'use strict';

let pauseState = {
	paused: false,
	pausedAt: null,
	reason: null,
};

function isNewsMonitorPaused() {
	return pauseState.paused;
}

function getNewsMonitorPauseState() {
	return {
		paused: pauseState.paused,
		pausedAt: pauseState.pausedAt,
		reason: pauseState.reason,
	};
}

function pauseNewsMonitor(options = {}) {
	const reason = (typeof options.reason === 'string' && options.reason.trim().length > 0)
		? options.reason.trim()
		: null;

	pauseState = {
		paused: true,
		pausedAt: new Date().toISOString(),
		reason,
	};

	return getNewsMonitorPauseState();
}

function resumeNewsMonitor() {
	const previousState = { ...pauseState };
	pauseState = {
		paused: false,
		pausedAt: null,
		reason: null,
	};

	return {
		paused: false,
		resumedAt: new Date().toISOString(),
		wasPaused: previousState.paused,
		previouslyPausedAt: previousState.pausedAt,
	};
}

function resetNewsMonitorPauseStateForTest() {
	pauseState = {
		paused: false,
		pausedAt: null,
		reason: null,
	};
}

async function postPauseNewsMonitor(req, res) {
	const reason = req.body && typeof req.body === 'object' && typeof req.body.reason === 'string'
		? req.body.reason
		: undefined;

	const state = pauseNewsMonitor({ reason });

	return res.status(200).json({
		message: 'News monitor analysis paused',
		...state,
	});
}

async function postResumeNewsMonitor(req, res) {
	const result = resumeNewsMonitor();

	return res.status(200).json({
		message: 'News monitor analysis resumed',
		...result,
	});
}

async function getNewsMonitorStatus(req, res) {
	const state = getNewsMonitorPauseState();

	return res.status(200).json(state);
}

module.exports = {
	isNewsMonitorPaused,
	getNewsMonitorPauseState,
	pauseNewsMonitor,
	resumeNewsMonitor,
	resetNewsMonitorPauseStateForTest,
	postPauseNewsMonitor,
	postResumeNewsMonitor,
	getNewsMonitorStatus,
};
