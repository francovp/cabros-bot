/**
 * retryHelper - Utility for sending with exponential backoff retry logic
 * Implements exponential backoff (1s → 2s → 4s) with ±10% jitter
 */

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate backoff delay with jitter
 * Exponential backoff: attempt 1 → 1s, attempt 2 → 2s, attempt 3 → 4s
 * Jitter: ±10% of base delay
 * @param {number} attempt - Attempt number (1-indexed)
 * @returns {number} Delay in milliseconds
 */
function calculateBackoffDelay(attempt) {
  const baseDelay = Math.pow(2, attempt - 1) * 1000; // 1000ms, 2000ms, 4000ms
  const jitterPercent = Math.random() * 0.2 - 0.1; // -10% to +10%
  const jitter = baseDelay * jitterPercent;
  return Math.round(baseDelay + jitter);
}

/**
 * Send with exponential backoff retry logic
 * @param {Function} sendFn - Async function that returns SendResult or throws
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @param {Object} logger - Logger object with warn() and error() methods (optional)
 * @returns {Promise<Object>} SendResult object after success or max retries exhausted
 */
async function sendWithRetry(sendFn, maxRetries = 3, logger = null) {
  let lastResult = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const startTime = Date.now();
      const result = await sendFn();
      const durationMs = Date.now() - startTime;

      if (result.success) {
        if (logger && attempt > 1) {
          logger.log?.(`Send succeeded on attempt ${attempt}/${maxRetries}`);
        }
        return { ...result, attemptCount: attempt, durationMs };
      }

      // Failure; retry if attempts remain
      lastResult = result;
      if (attempt < maxRetries) {
        const delayMs = calculateBackoffDelay(attempt);
        if (logger) {
          logger.warn?.(
            `Retry ${attempt}/${maxRetries}: send failed for ${result.channel}. Retrying in ${delayMs}ms`,
            { error: result.error }
          );
        }

        await sleep(delayMs);
      }
    } catch (error) {
      lastResult = {
        success: false,
        channel: 'unknown',
        error: error.message,
      };

      if (logger) {
        logger.error?.(`Attempt ${attempt}/${maxRetries} threw exception`, { error: error.message });
      }

      if (attempt < maxRetries) {
        const delayMs = calculateBackoffDelay(attempt);
        await sleep(delayMs);
      }
    }
  }

  // All retries exhausted
  if (logger) {
    logger.error?.(`All ${maxRetries} retries exhausted`, { lastResult });
  }

  return {
    ...lastResult,
    success: false,
    error: lastResult?.error || `Max retries (${maxRetries}) exhausted`,
    attemptCount: maxRetries,
  };
}

module.exports = {
  sendWithRetry,
  calculateBackoffDelay,
  sleep,
};
