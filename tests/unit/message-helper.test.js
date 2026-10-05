/* global describe, it, expect */

const {
	truncateMessage,
	splitMessageIntoChunks,
	estimateMessageChunks,
	CHANNEL_CHUNK_LIMITS,
} = require('../../src/lib/messageHelper');

describe('messageHelper', () => {
	describe('truncateMessage', () => {
		it('returns empty string for non-string input', () => {
			expect(truncateMessage(null)).toBe('');
			expect(truncateMessage(undefined)).toBe('');
			expect(truncateMessage(123)).toBe('');
		});

		it('returns text as is when under or equal to maxChars', () => {
			expect(truncateMessage('hello', 10)).toBe('hello');
			expect(truncateMessage('hello', 5)).toBe('hello');
		});

		it('truncates and appends ellipsis when exceeding maxChars', () => {
			expect(truncateMessage('hello world', 5)).toBe('hello…');
		});
	});

	describe('splitMessageIntoChunks', () => {
		it('returns single empty string chunk for invalid input', () => {
			expect(splitMessageIntoChunks(null)).toEqual(['']);
			expect(splitMessageIntoChunks(undefined)).toEqual(['']);
		});

		it('returns single chunk when under limit', () => {
			const text = 'Short message';
			expect(splitMessageIntoChunks(text, 100)).toEqual([text]);
		});

		it('splits by paragraphs when possible', () => {
			const text = 'Paragraph 1\n\nParagraph 2\n\nParagraph 3';
			const chunks = splitMessageIntoChunks(text, 25);
			expect(chunks.length).toBeGreaterThan(1);
			expect(chunks.join('\n\n')).toContain('Paragraph 1');
		});
	});

	describe('estimateMessageChunks', () => {
		it('returns 1 chunk for all channels on empty or non-string input', () => {
			expect(estimateMessageChunks(null)).toEqual({
				telegram: 1,
				whatsapp: 1,
				discord: 1,
			});
			expect(estimateMessageChunks(undefined)).toEqual({
				telegram: 1,
				whatsapp: 1,
				discord: 1,
			});
			expect(estimateMessageChunks('')).toEqual({
				telegram: 1,
				whatsapp: 1,
				discord: 1,
			});
		});

		it('returns 1 chunk for all channels for short messages under all limits', () => {
			const shortText = 'Deployment completed successfully';
			expect(estimateMessageChunks(shortText)).toEqual({
				telegram: 1,
				whatsapp: 1,
				discord: 1,
			});
		});

		it('estimates discord as > 1 when message exceeds 2,000 characters but under 20,000', () => {
			const text3k = 'a'.repeat(3000);
			const estimates = estimateMessageChunks(text3k);
			expect(estimates.telegram).toBe(1);
			expect(estimates.whatsapp).toBe(1);
			expect(estimates.discord).toBe(2);
		});

		it('estimates whatsapp as > 1 when message exceeds 20,000 characters', () => {
			const text25k = 'a'.repeat(25000);
			const estimates = estimateMessageChunks(text25k);
			expect(estimates.telegram).toBe(1);
			expect(estimates.whatsapp).toBe(2);
			expect(estimates.discord).toBe(13);
		});

		it('accurately estimates chunks for a 50,000 character payload matching specification', () => {
			const text50k = 'a'.repeat(50000);
			const estimates = estimateMessageChunks(text50k);
			expect(estimates).toEqual({
				telegram: 1,
				whatsapp: 3,
				discord: 25,
			});
		});

		it('exposes CHANNEL_CHUNK_LIMITS constants', () => {
			expect(CHANNEL_CHUNK_LIMITS).toEqual({
				telegram: 1,
				whatsapp: 20000,
				discord: 2000,
			});
		});
	});
});
