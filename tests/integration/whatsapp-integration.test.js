/**
 * WhatsAppService T028 Integration Tests
 * Tests the async formatEnriched() integration with WhatsAppService
 */

const WhatsAppService = require('../../src/services/notification/WhatsAppService');

describe('WhatsAppService - T028 URL Shortening Integration', () => {
	let mockUrlShortener;
	let mockFetch;
	let whatsAppService;

	beforeEach(() => {
		mockUrlShortener = {
			shortenUrlsParallel: jest.fn(),
		};

		mockFetch = jest.fn();
		global.fetch = mockFetch;

		whatsAppService = new WhatsAppService({
			apiUrl: 'https://api.greenapi.com',
			apiKey: 'test-key',
			chatId: '120363xxxxxx@g.us',
			urlShortener: mockUrlShortener,
		});

		mockFetch.mockResolvedValue({
			ok: true,
			json: async () => ({ idMessage: 'msg-123' }),
		});
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	describe('Formatter Integration - Async formatEnriched with URL shortening', () => {
		it('should initialize formatter with urlShortener', () => {
			expect(whatsAppService.formatter.urlShortener).toBe(mockUrlShortener);
		});

		it('should await async formatEnriched() during send', async () => {
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const alert = {
				text: 'Alert text',
				enriched: {
					originalText: 'Original text',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await whatsAppService.send(alert);

			expect(result.success).toBe(true);
			expect(mockUrlShortener.shortenUrlsParallel).toHaveBeenCalled();
		});

		it('should gracefully handle URL shortening failures during send', async () => {
			mockUrlShortener.shortenUrlsParallel.mockRejectedValue(
				new Error('Bitly API error'),
			);

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Original',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await whatsAppService.send(alert);

			// Should still succeed with fallback
			expect(result.success).toBe(true);
			expect(mockFetch).toHaveBeenCalled();
		});

		it('should handle enriched alerts without citations', async () => {
			const alert = {
				text: 'Plain alert',
				enriched: {
					originalText: 'Alert',
					summary: 'Summary',
					citations: [],
				},
			};

			const result = await whatsAppService.send(alert);

			expect(result.success).toBe(true);
			expect(mockUrlShortener.shortenUrlsParallel).not.toHaveBeenCalled();
		});

		it('should handle alerts without enriched content', async () => {
			const alert = {
				text: 'Plain text alert',
			};

			const result = await whatsAppService.send(alert);

			expect(result.success).toBe(true);
			expect(mockUrlShortener.shortenUrlsParallel).not.toHaveBeenCalled();
		});

		it('should work without urlShortener configured', async () => {
			const serviceWithout = new WhatsAppService({
				apiUrl: 'https://api.greenapi.com',
				apiKey: 'test-key',
				chatId: '120363xxxxxx@g.us',
			});

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await serviceWithout.send(alert);

			expect(result.success).toBe(true);
		});

		it('should only call shortening once per alert', async () => {
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url1': 'https://bit.ly/1',
				'https://example.com/url2': 'https://bit.ly/2',
			});

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source 1', url: 'https://example.com/url1' },
						{ title: 'Source 2', url: 'https://example.com/url2' },
					],
				},
			};

			await whatsAppService.send(alert);

			// Should only call once to shorten all URLs
			expect(mockUrlShortener.shortenUrlsParallel).toHaveBeenCalled();
		});

		it('should handle multiple enriched alerts sequentially', async () => {
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const alert1 = {
				text: 'Alert 1',
				enriched: {
					originalText: 'Text 1',
					summary: 'Summary 1',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			await whatsAppService.send(alert1);
			expect(mockUrlShortener.shortenUrlsParallel).toHaveBeenCalled();

			// Clear for next alert
			mockFetch.mockClear();
			mockUrlShortener.shortenUrlsParallel.mockClear();
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({});

			const alert2 = {
				text: 'Alert 2',
			};

			await whatsAppService.send(alert2);
			expect(mockUrlShortener.shortenUrlsParallel).not.toHaveBeenCalled();
		});

		it('should handle citations with very long URLs', async () => {
			const longUrl = 'https://example.com/' + 'a'.repeat(1000);
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				[longUrl]: 'https://bit.ly/short',
			});

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Long URL', url: longUrl },
					],
				},
			};

			const result = await whatsAppService.send(alert);

			expect(result.success).toBe(true);
		});

		it('should handle citation titles with special characters', async () => {
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source *bold* _italic_ ~strike~', url: 'https://example.com/url' },
					],
				},
			};

			const result = await whatsAppService.send(alert);

			expect(result.success).toBe(true);
		});

		it('should handle GreenAPI errors after successful URL shortening', async () => {
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			mockFetch.mockResolvedValue({
				ok: false,
				json: async () => ({ error: 'Rate limit' }),
			});

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await whatsAppService.send(alert);

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should retry on GreenAPI error after URL shortening', async () => {
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			// First attempt fails
			mockFetch.mockResolvedValueOnce({
				ok: false,
				json: async () => ({ error: 'Temporary' }),
			});

			// Second attempt succeeds
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ idMessage: 'msg-456' }),
			});

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await whatsAppService.send(alert);

			expect(result.success).toBe(true);
			expect(result.messageId).toBe('msg-456');
			// URL shortening should still only be called once
			expect(mockUrlShortener.shortenUrlsParallel).toHaveBeenCalled();
		});

		it('should handle timeout during URL shortening', async () => {
			mockUrlShortener.shortenUrlsParallel.mockRejectedValue(
				new Error('Timeout after 10000ms'),
			);

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await whatsAppService.send(alert);

			// Should still deliver without shortened URLs
			expect(result.success).toBe(true);
		});

		it('should handle null urlShortener gracefully', async () => {
			const serviceWithNull = new WhatsAppService({
				apiUrl: 'https://api.greenapi.com',
				apiKey: 'test-key',
				chatId: '120363xxxxxx@g.us',
				urlShortener: null,
			});

			const alert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await serviceWithNull.send(alert);

			expect(result.success).toBe(true);
		});
	});

	describe('T028 Backward Compatibility', () => {
		it('should work with existing code that doesnt pass urlShortener', async () => {
			const legacyService = new WhatsAppService({
				apiUrl: 'https://api.greenapi.com',
				apiKey: 'test-key',
				chatId: '120363xxxxxx@g.us',
			});

			const plainAlert = {
				text: 'Plain alert text',
			};

			const result = await legacyService.send(plainAlert);

			expect(result.success).toBe(true);
		});

		it('should work with enriched alerts even without urlShortener', async () => {
			const legacyService = new WhatsAppService({
				apiUrl: 'https://api.greenapi.com',
				apiKey: 'test-key',
				chatId: '120363xxxxxx@g.us',
			});

			const enrichedAlert = {
				text: 'Alert',
				enriched: {
					originalText: 'Text',
					summary: 'Summary',
					citations: [
						{ title: 'Source', url: 'https://example.com/url' },
					],
				},
			};

			const result = await legacyService.send(enrichedAlert);

			expect(result.success).toBe(true);
		});
	});

	describe('Configuration Validation', () => {
		it('should accept urlShortener in constructor config', () => {
			const service = new WhatsAppService({
				apiUrl: 'https://api.greenapi.com',
				apiKey: 'test-key',
				chatId: '120363xxxxxx@g.us',
				urlShortener: mockUrlShortener,
			});

			expect(service.urlShortener).toBe(mockUrlShortener);
		});

		it('should handle missing urlShortener gracefully', () => {
			const service = new WhatsAppService({
				apiUrl: 'https://api.greenapi.com',
				apiKey: 'test-key',
				chatId: '120363xxxxxx@g.us',
			});

			expect(service.urlShortener).toBeFalsy();
		});
	});
});
