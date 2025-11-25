/* global jest, describe, it, expect, beforeEach */

const { enrichAlert } = require('../../src/controllers/webhooks/handlers/alert/grounding');
const { groundAlert } = require('../../src/services/grounding/grounding');
const { validateAlert } = require('../../src/lib/validation');

jest.mock('../../src/services/grounding/grounding');
jest.mock('../../src/lib/validation');

describe('Alert Handler', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		// Return the text directly, not wrapped in an object
		validateAlert.mockImplementation(text => text);
	});

	it('should enrich alert with grounded content', async () => {
		const alert = { text: 'Bitcoin breaks $50,000 mark' };
		const groundedContent = {
			sentiment: 'BULLISH',
			sentiment_score: 0.9,
			insights: ['Market update: BTC reaches 50k milestone'],
			technical_levels: { supports: [], resistances: [] },
			sources: [
				{
					title: 'Test Source',
					snippet: 'Test snippet',
					url: 'https://test.com',
					sourceDomain: 'test.com',
				},
			],
			truncated: false,
		};

		groundAlert.mockResolvedValue(groundedContent);

		const result = await enrichAlert(alert);

		expect(result.original_text).toBe(alert.text);
		expect(result.insights).toEqual(groundedContent.insights);
		expect(result.sources).toEqual(groundedContent.sources);
		expect(result.truncated).toBe(false);

		expect(groundAlert).toHaveBeenCalledWith({
			text: alert.text,
			options: expect.objectContaining({
				preserveLanguage: true,
			}),
		});
	});

	it('should handle empty text', async () => {
		validateAlert.mockImplementation(() => {
			throw new Error('Alert text is required');
		});

		await expect(enrichAlert({ text: '' }))
			.rejects.toThrow('Alert text is required');
	});

	it('should handle grounding failures', async () => {
		const alert = { text: 'Test alert' };
		groundAlert.mockRejectedValue(new Error('Grounding failed'));

		await expect(enrichAlert(alert))
			.rejects.toThrow('Alert enrichment failed: Grounding failed');
	});

	it('should handle grounding timeouts', async () => {
		const alert = { text: 'Test alert' };
		groundAlert.mockRejectedValue(new Error('Grounding timeout'));

		await expect(enrichAlert(alert))
			.rejects.toThrow('Alert enrichment failed: Grounding timeout');
	});

	it('should preserve truncation status', async () => {
		const alert = { text: 'A'.repeat(5000) };
		const groundedContent = {
			sentiment: 'NEUTRAL',
			sentiment_score: 0,
			insights: ['Summary of long text'],
			technical_levels: { supports: [], resistances: [] },
			sources: [],
			truncated: true,
		};

		groundAlert.mockResolvedValue(groundedContent);

		const result = await enrichAlert(alert);
		expect(result.truncated).toBe(true);
	});
});