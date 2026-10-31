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
	THROTTLED: 'throttled',
};

const ALLOWED_EVENT_CATEGORIES = [
	EventCategory.PRICE_SURGE,
	EventCategory.PRICE_DECLINE,
	EventCategory.PUBLIC_FIGURE,
	EventCategory.REGULATORY,
];

module.exports = {
	EventCategory,
	AnalysisStatus,
	ALLOWED_EVENT_CATEGORIES,
};
