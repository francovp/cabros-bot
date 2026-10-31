'use strict';

const {
	SIGNAL_CLASS_MARKERS,
	formatSignalClassMarker,
	isSignalClassMarkerEnabled,
} = require('../../src/services/notification/formatters/signalClassMarker');
const MarkdownV2Formatter = require('../../src/services/notification/formatters/markdownV2Formatter');
const WhatsAppMarkdownFormatter = require('../../src/services/notification/formatters/whatsappMarkdownFormatter');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('Signal Class Notification Marker', () => {
	const originalEnv = process.env.ENABLE_SIGNAL_CLASS_MARKER;

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.ENABLE_SIGNAL_CLASS_MARKER = originalEnv;
		} else {
			delete process.env.ENABLE_SIGNAL_CLASS_MARKER;
		}
		remoteConfigService.resetForTest?.();
	});

	describe('formatSignalClassMarker()', () => {
		it('formats all 7 recognized signal classes in plain mode', () => {
			expect(formatSignalClassMarker('breakout')).toBe('🎯 breakout');
			expect(formatSignalClassMarker('mean_reversion')).toBe('🔄 mean_reversion');
			expect(formatSignalClassMarker('trend_continuation')).toBe('📈 trend_continuation');
			expect(formatSignalClassMarker('reversal')).toBe('↩️ reversal');
			expect(formatSignalClassMarker('volume_spike')).toBe('⚡ volume_spike');
			expect(formatSignalClassMarker('news_event')).toBe('📰 news_event');
			expect(formatSignalClassMarker('manual')).toBe('✍️ manual');
		});

		it('escapes underscores in MarkdownV2 mode', () => {
			expect(formatSignalClassMarker('breakout', { markdownV2: true })).toBe('🎯 breakout');
			expect(formatSignalClassMarker('mean_reversion', { markdownV2: true })).toBe('🔄 mean\\_reversion');
			expect(formatSignalClassMarker('trend_continuation', { markdownV2: true })).toBe('📈 trend\\_continuation');
			expect(formatSignalClassMarker('reversal', { markdownV2: true })).toBe('↩️ reversal');
			expect(formatSignalClassMarker('volume_spike', { markdownV2: true })).toBe('⚡ volume\\_spike');
			expect(formatSignalClassMarker('news_event', { markdownV2: true })).toBe('📰 news\\_event');
			expect(formatSignalClassMarker('manual', { markdownV2: true })).toBe('✍️ manual');
		});

		it('normalizes uppercase and leading/trailing whitespace', () => {
			expect(formatSignalClassMarker('  BREAKOUT  ')).toBe('🎯 breakout');
			expect(formatSignalClassMarker('  MEAN_REVERSION  ', { markdownV2: true })).toBe('🔄 mean\\_reversion');
		});

		it('returns null for unknown signal class', () => {
			expect(formatSignalClassMarker('unknown')).toBeNull();
			expect(formatSignalClassMarker('UNKNOWN')).toBeNull();
		});

		it('returns null for invalid or empty inputs', () => {
			expect(formatSignalClassMarker(null)).toBeNull();
			expect(formatSignalClassMarker(undefined)).toBeNull();
			expect(formatSignalClassMarker('')).toBeNull();
			expect(formatSignalClassMarker('   ')).toBeNull();
			expect(formatSignalClassMarker('invalid_class')).toBeNull();
			expect(formatSignalClassMarker(123)).toBeNull();
			expect(formatSignalClassMarker({})).toBeNull();
		});

		it('returns null when disabled via process.env.ENABLE_SIGNAL_CLASS_MARKER=false', () => {
			process.env.ENABLE_SIGNAL_CLASS_MARKER = 'false';
			expect(isSignalClassMarkerEnabled()).toBe(false);
			expect(formatSignalClassMarker('breakout')).toBeNull();
		});

		it('returns null when disabled via Remote Config', () => {
			jest.spyOn(remoteConfigService, 'getRuntimeConfig').mockReturnValue({
				ENABLE_SIGNAL_CLASS_MARKER: false,
			});
			expect(isSignalClassMarkerEnabled()).toBe(false);
			expect(formatSignalClassMarker('breakout')).toBeNull();
			remoteConfigService.getRuntimeConfig.mockRestore();
		});
	});

	describe('MarkdownV2Formatter integration', () => {
		const formatter = new MarkdownV2Formatter();

		it('prepends marker to plain text alert when signalClass is provided', () => {
			const formatted = formatter.format('BTCUSDT breakout confirmed', { signalClass: 'breakout' });
			expect(formatted).toBe('🎯 breakout\n\nBTCUSDT breakout confirmed');
		});

		it('prepends escaped marker for mean_reversion in format()', () => {
			const formatted = formatter.format('ETH oversold', { signalClass: 'mean_reversion' });
			expect(formatted).toBe('🔄 mean\\_reversion\n\nETH oversold');
		});

		it('omits marker when signalClass is unknown or omitted in format()', () => {
			expect(formatter.format('BTCUSDT alert')).toBe('BTCUSDT alert');
			expect(formatter.format('BTCUSDT alert', { signalClass: 'unknown' })).toBe('BTCUSDT alert');
		});

		it('prepends marker to formatEnriched webhook alert', () => {
			const enriched = {
				original_text: 'SOL breakout 200',
				sentiment: 'BULLISH',
				signalClass: 'breakout',
			};
			const formatted = formatter.formatEnriched(enriched);
			expect(formatted).toContain('🎯 breakout\n\n*SOL breakout 200*');
		});

		it('prepends marker to formatEnriched news alert', () => {
			const enriched = {
				originalText: 'Fed cuts rates',
				summary: 'Rates reduced by 50 bps',
				signalClass: 'news_event',
			};
			const formatted = formatter.formatEnriched(enriched);
			expect(formatted).toContain('📰 news\\_event\n\n*Fed cuts rates*');
		});
	});

	describe('WhatsAppMarkdownFormatter integration', () => {
		const formatter = new WhatsAppMarkdownFormatter();

		it('prepends unescaped marker to plain text alert when signalClass is provided', () => {
			const formatted = formatter.format('BTCUSDT breakout confirmed', { signalClass: 'mean_reversion' });
			expect(formatted).toBe('🔄 mean_reversion\n\nBTCUSDT breakout confirmed');
		});

		it('omits marker when signalClass is unknown or omitted in format()', () => {
			expect(formatter.format('BTCUSDT alert')).toBe('BTCUSDT alert');
			expect(formatter.format('BTCUSDT alert', { signalClass: 'unknown' })).toBe('BTCUSDT alert');
		});

		it('prepends marker to formatEnriched webhook alert', async () => {
			const enriched = {
				original_text: 'SOL breakout 200',
				sentiment: 'BULLISH',
				signalClass: 'breakout',
			};
			const formatted = await formatter.formatEnriched(enriched);
			expect(formatted).toContain('🎯 breakout\n\n*SOL breakout 200*');
		});

		it('prepends marker to formatEnriched news alert', async () => {
			const enriched = {
				originalText: 'Fed cuts rates',
				summary: 'Rates reduced by 50 bps',
				signalClass: 'news_event',
			};
			const formatted = await formatter.formatEnriched(enriched);
			expect(formatted).toContain('📰 news_event\n\n*Fed cuts rates*');
		});
	});
});
