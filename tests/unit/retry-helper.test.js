/**
 * tests/unit/retry-helper.test.js
 * Unit tests for retry helper with exponential backoff
 */

const { sendWithRetry, calculateBackoffDelay, sleep } = require('../../src/lib/retryHelper');

describe('retryHelper', () => {
	describe('calculateBackoffDelay', () => {
		it('should return ~1000ms for attempt 1 (with jitter)', () => {
			const delay = calculateBackoffDelay(1);
			expect(delay).toBeGreaterThanOrEqual(900); // -10% jitter
			expect(delay).toBeLessThanOrEqual(1100); // +10% jitter
		});

		it('should return ~2000ms for attempt 2 (with jitter)', () => {
			const delay = calculateBackoffDelay(2);
			expect(delay).toBeGreaterThanOrEqual(1800);
			expect(delay).toBeLessThanOrEqual(2200);
		});

		it('should return ~4000ms for attempt 3 (with jitter)', () => {
			const delay = calculateBackoffDelay(3);
			expect(delay).toBeGreaterThanOrEqual(3600);
			expect(delay).toBeLessThanOrEqual(4400);
		});
	});

	describe('sendWithRetry', () => {
		it('should succeed on first attempt', async () => {
			const mockSendFn = jest.fn().mockResolvedValue({
				success: true,
				channel: 'test',
				messageId: '123',
			});

			const result = await sendWithRetry(mockSendFn, 3);

			expect(result.success).toBe(true);
			expect(result.channel).toBe('test');
			expect(result.messageId).toBe('123');
			expect(result.attemptCount).toBe(1);
			expect(result.durationMs).toBeDefined();
			expect(mockSendFn).toHaveBeenCalledTimes(1);
		});

		it('should retry and succeed on second attempt', async () => {
			const mockSendFn = jest
				.fn()
				.mockResolvedValueOnce({
					success: false,
					channel: 'test',
					error: 'First attempt failed',
				})
				.mockResolvedValueOnce({
					success: true,
					channel: 'test',
					messageId: '456',
				});

			const result = await sendWithRetry(mockSendFn, 3);

			expect(result.success).toBe(true);
			expect(result.messageId).toBe('456');
			expect(result.attemptCount).toBe(2);
			expect(mockSendFn).toHaveBeenCalledTimes(2);
		});

		it('should exhaust all retries and return failure', async () => {
			const mockSendFn = jest.fn().mockResolvedValue({
				success: false,
				channel: 'test',
				error: 'Always fails',
			});

			const result = await sendWithRetry(mockSendFn, 3);

			expect(result.success).toBe(false);
			expect(result.channel).toBe('test');
			expect(result.error).toBeDefined();
			expect(result.attemptCount).toBe(3);
			expect(mockSendFn).toHaveBeenCalledTimes(3);
		});

		it('should handle thrown exceptions', async () => {
			const mockError = new Error('Network error');
			const mockSendFn = jest.fn().mockRejectedValue(mockError);

			const result = await sendWithRetry(mockSendFn, 3);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Network error');
			expect(result.attemptCount).toBe(3);
			expect(mockSendFn).toHaveBeenCalledTimes(3);
		});

		it('should respect logger if provided', async () => {
			const mockLogger = {
				warn: jest.fn(),
				error: jest.fn(),
				log: jest.fn(),
			};

			const mockSendFn = jest
				.fn()
				.mockResolvedValueOnce({ success: false, channel: 'test', error: 'Fail 1' })
				.mockResolvedValueOnce({ success: false, channel: 'test', error: 'Fail 2' })
				.mockResolvedValueOnce({ success: false, channel: 'test', error: 'Fail 3' });

			const result = await sendWithRetry(mockSendFn, 3, mockLogger);

			expect(result.success).toBe(false);
			expect(mockLogger.warn).toHaveBeenCalled();
			expect(mockLogger.error).toHaveBeenCalled();
		});

		it('should use default maxRetries of 3', async () => {
			const mockSendFn = jest.fn().mockResolvedValue({
				success: false,
				channel: 'test',
				error: 'Fail',
			});

			await sendWithRetry(mockSendFn); // No maxRetries arg

			expect(mockSendFn).toHaveBeenCalledTimes(3);
		});

		it('should measure duration correctly', async () => {
			const mockSendFn = jest.fn(async () => {
				await sleep(100);
				return { success: true, channel: 'test' };
			});

			const result = await sendWithRetry(mockSendFn, 3);

			expect(result.durationMs).toBeGreaterThanOrEqual(100);
		});
	});

	describe('sleep', () => {
		it('should sleep for specified milliseconds', async () => {
			const start = Date.now();
			await sleep(100);
			const elapsed = Date.now() - start;

			expect(elapsed).toBeGreaterThanOrEqual(90);
			expect(elapsed).toBeLessThan(200); // Allow some variance
		});
	});
});
