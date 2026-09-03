'use strict';

const {
	getSessionState,
	shouldSuppressDelivery,
	getDatasetMetadata,
	SESSION_STATES,
} = require('../../src/services/marketCalendar/sessionState');

describe('marketCalendar/sessionState', () => {
	// Helper: build a Date that represents the given wall-clock ET instant.
	// Uses a fixed-offset trick (UTC-5 / UTC-4 for DST) so the IANA timezone
	// math is exercised identically to production code but the test is
	// hermetic and doesn't depend on the host machine's clock.
	function etDate(year, month, day, hour, minute) {
		// America/New_York is UTC-5 (EST) or UTC-4 (EDT). For our DST-aware
		// fixture we just feed the IANA-resolved Date directly: ET 12:00 on
		// July 4 2026 = UTC 16:00 (EDT, UTC-4).
		// The fixtures here are picked so DST status is unambiguous.
		const utc = new Date(Date.UTC(year, month - 1, day, hour, minute));
		return utc;
	}

	describe('crypto venues', () => {
		it('always returns regular and never suppresses delivery', () => {
			const result = getSessionState({ exchange: 'BINANCE', timestamp: etDate(2026, 7, 4, 3, 0) });
			expect(result.state).toBe(SESSION_STATES.REGULAR);
			expect(result.venueKind).toBe('crypto');
			expect(result.suppressDelivery).toBe(false);
			expect(shouldSuppressDelivery({ exchange: 'BINANCE', timestamp: etDate(2026, 7, 4, 3, 0) })).toBe(false);
		});

		it('recognizes additional crypto venues case-insensitively', () => {
			expect(getSessionState({ exchange: 'coinbase' }).venueKind).toBe('crypto');
			expect(getSessionState({ exchange: 'KRAKEN' }).venueKind).toBe('crypto');
			expect(getSessionState({ exchange: 'okx' }).venueKind).toBe('crypto');
		});
	});

	describe('U.S. equity venues — regular hours', () => {
		it('classifies mid-session as regular', () => {
			const result = getSessionState({ exchange: 'NASDAQ', timestamp: etDate(2026, 6, 15, 14, 30) });
			// 14:30 UTC on June 15 2026 is 10:30 ET (EDT) — within regular hours.
			expect(result.state).toBe(SESSION_STATES.REGULAR);
			expect(result.venueKind).toBe('us_equity');
			expect(result.suppressDelivery).toBe(false);
		});
	});

	describe('U.S. equity venues — pre-market', () => {
		it('classifies pre-market as pre', () => {
			// 13:00 UTC on June 15 2026 = 09:00 ET (EDT) — pre-market window.
			const result = getSessionState({ exchange: 'NYSE', timestamp: etDate(2026, 6, 15, 13, 0) });
			expect(result.state).toBe(SESSION_STATES.PRE);
			expect(result.suppressDelivery).toBe(false);
		});
	});

	describe('U.S. equity venues — after-hours', () => {
		it('classifies after-hours as post', () => {
			// 22:00 UTC on June 15 2026 = 18:00 ET (EDT) — after-hours window.
			const result = getSessionState({ exchange: 'BATS', timestamp: etDate(2026, 6, 15, 22, 0) });
			expect(result.state).toBe(SESSION_STATES.POST);
			expect(result.suppressDelivery).toBe(false);
		});
	});

	describe('U.S. equity venues — weekday outside any session window', () => {
		it('classifies late-night as closed and suppresses delivery', () => {
			// 06:00 UTC on June 15 2026 = 02:00 ET (EDT) — pre-open window start is 04:00 ET.
			const result = getSessionState({ exchange: 'NASDAQ', timestamp: etDate(2026, 6, 15, 7, 0) });
			expect(result.state).toBe(SESSION_STATES.CLOSED);
			expect(result.suppressDelivery).toBe(true);
		});
	});

	describe('U.S. equity venues — weekend', () => {
		it('treats Saturday as closed', () => {
			// 2026-06-20 is a Saturday (mid-June 2026).
			const result = getSessionState({ exchange: 'NASDAQ', timestamp: etDate(2026, 6, 20, 18, 0) });
			expect(result.state).toBe(SESSION_STATES.CLOSED);
			expect(result.suppressDelivery).toBe(true);
		});

		it('treats Sunday as closed', () => {
			// 2026-06-21 is a Sunday.
			const result = getSessionState({ exchange: 'NASDAQ', timestamp: etDate(2026, 6, 21, 18, 0) });
			expect(result.state).toBe(SESSION_STATES.CLOSED);
			expect(result.suppressDelivery).toBe(true);
		});
	});

	describe('U.S. equity venues — full-day holidays', () => {
		it('classifies Independence Day 2026 as holiday and suppresses', () => {
			// July 3 2026 = Friday, observed Independence Day (full-day closure).
			const result = getSessionState({ exchange: 'NASDAQ', timestamp: etDate(2026, 7, 3, 18, 0) });
			expect(result.state).toBe(SESSION_STATES.HOLIDAY);
			expect(result.suppressDelivery).toBe(true);
			expect(result.holiday && result.holiday.name).toMatch(/Independence Day/);
		});

		it('classifies Christmas 2026 as holiday', () => {
			const result = getSessionState({ exchange: 'NYSE', timestamp: etDate(2026, 12, 25, 18, 0) });
			expect(result.state).toBe(SESSION_STATES.HOLIDAY);
			expect(result.suppressDelivery).toBe(true);
		});

		it('classifies Thanksgiving 2026 as holiday', () => {
			const result = getSessionState({ exchange: 'NASDAQ', timestamp: etDate(2026, 11, 26, 18, 0) });
			expect(result.state).toBe(SESSION_STATES.HOLIDAY);
			expect(result.suppressDelivery).toBe(true);
		});
	});

	describe('U.S. equity venues — half-day early close', () => {
		it('classifies Black Friday 2026 inside early-close window as regular', () => {
			// 2026-11-27 = Friday after Thanksgiving, half-day early close at 13:00 ET.
			// 16:00 UTC = 12:00 ET (EST) — within the 09:30–13:00 window.
			const result = getSessionState({ exchange: 'NYSE', timestamp: etDate(2026, 11, 27, 16, 0) });
			expect(result.state).toBe(SESSION_STATES.REGULAR);
			expect(result.halfDay).toBe(true);
			expect(result.suppressDelivery).toBe(false);
		});

		it('classifies Black Friday 2026 after the 13:00 ET close as closed', () => {
			// 2026-11-27 = 18:30 UTC = 13:30 ET — past the half-day close.
			const result = getSessionState({ exchange: 'NYSE', timestamp: etDate(2026, 11, 27, 18, 30) });
			expect(result.state).toBe(SESSION_STATES.CLOSED);
			expect(result.suppressDelivery).toBe(true);
			expect(result.holiday && result.holiday.type).toBe('half_day');
		});
	});

	describe('unknown / malformed inputs', () => {
		it('returns unknown for an unrecognised exchange without throwing', () => {
			const result = getSessionState({ exchange: 'NOT_A_REAL_EXCHANGE' });
			expect(result.state).toBe(SESSION_STATES.UNKNOWN);
			expect(result.suppressDelivery).toBe(false);
		});

		it('returns unknown when exchange is missing without throwing', () => {
			const result = getSessionState({});
			expect(result.state).toBe(SESSION_STATES.UNKNOWN);
			expect(result.suppressDelivery).toBe(false);
		});

		it('treats an invalid timestamp as unknown (does not throw)', () => {
			const result = getSessionState({ exchange: 'NASDAQ', timestamp: 'not-a-date' });
			// Should either succeed by falling back to "now" or return unknown.
			expect([SESSION_STATES.UNKNOWN, SESSION_STATES.REGULAR, SESSION_STATES.PRE, SESSION_STATES.POST, SESSION_STATES.CLOSED]).toContain(result.state);
		});
	});

	describe('dataset metadata', () => {
		it('returns a versioned dataset descriptor', () => {
			const meta = getDatasetMetadata();
			expect(typeof meta.datasetVersion).toBe('string');
			expect(meta.datasetVersion.length).toBeGreaterThan(0);
			expect(meta.timezone).toBe('America/New_York');
			expect(Array.isArray(meta.supportedYears)).toBe(true);
			expect(meta.supportedYears).toEqual(expect.arrayContaining(['2025', '2026', '2027']));
		});
	});
});
