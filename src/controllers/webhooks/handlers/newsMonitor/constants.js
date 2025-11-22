/**
 * Event category constants for News Monitor
 * 003-news-monitor
 */

const EventCategory = {
	PRICE_SURGE: 'price_surge',
	PRICE_DECLINE: 'price_decline',
	PUBLIC_FIGURE: 'public_figure',
	REGULATORY: 'regulatory',
	NONE: 'none',
};

const AnalysisStatus = {
	ANALYZED: 'analyzed',
	CACHED: 'cached',
	TIMEOUT: 'timeout',
	ERROR: 'error',
};

module.exports = {
	EventCategory,
	AnalysisStatus,
};
