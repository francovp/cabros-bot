'use strict';

const {
	evaluateDeliveryGate,
	isDeliverySuppressed,
	resolveAlertExchange,
	isFeatureEnabled,
} = require('../../src/services/marketCalendar/notificationGate');

// Fix "now" to a known regular-hours weekday (Wed Jun 17 2026, 14:30 ET = 18:30 UTC).
const FIXED_NOW = new Date(Date.UTC(2026, 5, 17, 18, 30));
const FIXED_HOLIDAY = new Date(Date.UTC(2026, 6, 3, 18, 0)); // July 3 2026, 14:00 ET = observed Independence Day

describe('marketCalendar/notificationGate', () => {
	describe('isFeatureEnabled', () => {
		it('returns false when env is unset', () => {
			expect(isFeatureEnabled({})).toBe(false);
			expect(isFeatureEnabled({ ENABLE_MARKET_CALENDAR_GATING: undefined })).toBe(false);
			expect(isFeatureEnabled({ ENABLE_MARKET_CALENDAR_GATING: '' })).toBe(false);
		});

		it('returns true only when env equals "true"', () => {
			expect(isFeatureEnabled({ ENABLE_MARKET_CALENDAR_GATING: 'true' })).toBe(true);
			expect(isFeatureEnabled({ ENABLE_MARKET_CALENDAR_GATING: 'TRUE' })).toBe(true);
			expect(isFeatureEnabled({ ENABLE_MARKET_CALENDAR_GATING: '1' })).toBe(false);
			expect(isFeatureEnabled({ ENABLE_MARKET_CALENDAR_GATING: 'yes' })).toBe(false);
		});
	});

	describe('resolveAlertExchange', () => {
		it('returns null for null/undefined alerts', () => {
			expect(resolveAlertExchange(null)).toBeNull();
			expect(resolveAlertExchange(undefined)).toBeNull();
		});

		it('reads exchange from the alert root', () => {
			expect(resolveAlertExchange({ exchange: 'NASDAQ' })).toBe('NASDAQ');
		});

		it('reads exchange from enriched payload', () => {
			expect(resolveAlertExchange({ enriched: { exchange: 'BATS' } })).toBe('BATS');
		});

		it('reads exchange from enriched.signal.exchange', () => {
			expect(resolveAlertExchange({ enriched: { signal: { exchange: 'nasdaq' } } })).toBe('NASDAQ');
		});

		it('reads exchange from alert.signal.exchange', () => {
			expect(resolveAlertExchange({ signal: { exchange: 'NYSE' } })).toBe('NYSE');
		});

		it('reads exchange from a redrive-replay payload (enrichmentData shape)', () => {
			// NotificationRedriveService persists `enrichmentData` (full object) and
			// `enriched: true` (boolean). On replay, exchange must still resolve or
			// the market gate silently passes and suppressed alerts leak.
			expect(resolveAlertExchange({
				text: 'NASDAQ:NVDA BUY',
				enriched: true,
				enrichmentData: { exchange: 'NASDAQ' },
			})).toBe('NASDAQ');
		});

		it('reads exchange from _marketCalendarGate payload', () => {
			expect(resolveAlertExchange({
				_marketCalendarGate: { exchange: 'NYSE' },
			})).toBe('NYSE');
		});

		it('resolves exchange from alert.text when candidates are absent', () => {
			expect(resolveAlertExchange({ text: 'NASDAQ:AAPL BUY' })).toBe('NASDAQ');
		});

		it('returns null when no exchange candidate is present and text cannot be parsed', () => {
			expect(resolveAlertExchange({ text: 'no exchange here' })).toBeNull();
		});
	});

	describe('evaluateDeliveryGate — feature disabled', () => {
		it('never suppresses when the flag is unset', () => {
			const decision = evaluateDeliveryGate(
				{ exchange: 'NASDAQ' },
				{ env: {}, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(false);
			expect(decision.reason).toBeNull();
		});

		it('never suppresses crypto venues even when the flag is on', () => {
			const decision = evaluateDeliveryGate(
				{ exchange: 'BINANCE' },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(false);
		});
	});

	describe('evaluateDeliveryGate — feature enabled, regular hours', () => {
		it('does not suppress regular-hours NASDAQ alerts', () => {
			const decision = evaluateDeliveryGate(
				{ exchange: 'NASDAQ' },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_NOW },
			);
			expect(decision.suppress).toBe(false);
			expect(decision.exchange).toBe('NASDAQ');
			expect(decision.sessionState && decision.sessionState.state).toBe('regular');
		});
	});

	describe('evaluateDeliveryGate — feature enabled, full-day holiday', () => {
		it('suppresses NASDAQ alerts on observed Independence Day', () => {
			const decision = evaluateDeliveryGate(
				{ exchange: 'NASDAQ' },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(true);
			expect(decision.reason).toBe('market_holiday');
			expect(decision.sessionState.state).toBe('holiday');
		});

		it('suppresses plain text alerts whose exchange is resolved from text on a holiday', () => {
			const decision = evaluateDeliveryGate(
				{ text: 'NASDAQ:AAPL BUY' },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(true);
			expect(decision.reason).toBe('market_holiday');
			expect(decision.exchange).toBe('NASDAQ');
		});

		it('suppresses from the enriched.exchange path', () => {
			const decision = evaluateDeliveryGate(
				{ enriched: { exchange: 'BATS' } },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(true);
			expect(decision.exchange).toBe('BATS');
		});
	});

	describe('evaluateDeliveryGate — feature enabled, half-day early close', () => {
		// Black Friday 2026 (2026-11-27) is a half-day: regular session ends 13:00 ET.
		it('suppresses with the half-day reason outside the early-close window', () => {
			const decision = evaluateDeliveryGate(
				{ exchange: 'NASDAQ' },
				// 18:30 UTC = 13:30 ET — past the 13:00 ET close.
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: new Date(Date.UTC(2026, 10, 27, 18, 30)) },
			);
			expect(decision.suppress).toBe(true);
			expect(decision.reason).toBe('market_half_day_outside_window');
		});

		it('does not suppress regular hours inside the early-close window', () => {
			const decision = evaluateDeliveryGate(
				{ exchange: 'NASDAQ' },
				// 16:00 UTC = 12:00 ET — inside the 09:30–13:00 window.
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: new Date(Date.UTC(2026, 10, 27, 16, 0)) },
			);
			expect(decision.suppress).toBe(false);
		});
	});

	describe('evaluateDeliveryGate — redrive replay payload', () => {
		it('still suppresses a replayed holiday alert persisted with enrichmentData', () => {
			const decision = evaluateDeliveryGate(
				{
					text: 'NASDAQ:NVDA BUY',
					enriched: true,
					enrichmentData: { exchange: 'NASDAQ' },
				},
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(true);
			expect(decision.reason).toBe('market_holiday');
			expect(decision.exchange).toBe('NASDAQ');
		});
	});

	describe('evaluateDeliveryGate — fail-open', () => {
		it('never suppresses when exchange is unrecognised', () => {
			const decision = evaluateDeliveryGate(
				{ exchange: 'NOT_A_REAL_EXCHANGE' },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(false);
		});

		it('never suppresses when no exchange can be resolved', () => {
			const decision = evaluateDeliveryGate(
				{ text: 'no exchange here' },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			);
			expect(decision.suppress).toBe(false);
		});
	});

	describe('isDeliverySuppressed', () => {
		it('returns the boolean decision of evaluateDeliveryGate', () => {
			expect(isDeliverySuppressed(
				{ exchange: 'NASDAQ' },
				{ env: {}, timestamp: FIXED_HOLIDAY },
			)).toBe(false);
			expect(isDeliverySuppressed(
				{ exchange: 'NASDAQ' },
				{ env: { ENABLE_MARKET_CALENDAR_GATING: 'true' }, timestamp: FIXED_HOLIDAY },
			)).toBe(true);
		});
	});
});
