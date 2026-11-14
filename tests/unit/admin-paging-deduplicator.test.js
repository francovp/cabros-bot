'use strict';

const {
	AdminPagingDeduplicator,
	adminPagingDeduplicator,
	computePagingFingerprint,
	DEFAULT_ADMIN_PAGE_DEDUP_TTL_MS,
	DEFAULT_MAX_ENTRIES,
} = require('../../src/services/notification/adminPagingDeduplicator');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('AdminPagingDeduplicator', () => {
	let originalEnvTtl;

	beforeEach(() => {
		originalEnvTtl = process.env.ADMIN_PAGE_DEDUP_TTL_MS;
		delete process.env.ADMIN_PAGE_DEDUP_TTL_MS;
		adminPagingDeduplicator.reset();
		remoteConfigService._resetForTesting();
	});

	afterEach(() => {
		if (originalEnvTtl !== undefined) {
			process.env.ADMIN_PAGE_DEDUP_TTL_MS = originalEnvTtl;
		} else {
			delete process.env.ADMIN_PAGE_DEDUP_TTL_MS;
		}
		adminPagingDeduplicator.reset();
		remoteConfigService._resetForTesting();
	});

	describe('computePagingFingerprint', () => {
		it('computes a stable tuple fingerprint from category, channel, requestId, and errorCode', () => {
			const fp = computePagingFingerprint({
				category: 'RATE_LIMITED',
				channel: 'telegram',
				requestId: 'req-123',
				errorCode: 429,
			});
			expect(fp).toBe('rate_limited:telegram:req-123:429');
		});

		it('normalizes whitespace and casing', () => {
			const fp = computePagingFingerprint({
				category: '  PROVIDER_ERROR  ',
				channel: '  WHATSAPP  ',
				requestId: '  req-456  ',
				errorCode: '  ECONNRESET  ',
			});
			expect(fp).toBe('provider_error:whatsapp:req-456:econnreset');
		});

		it('provides safe fallbacks for missing or null properties', () => {
			const fp = computePagingFingerprint({});
			expect(fp).toBe('unknown:unknown:none:none');
		});

		it('supports channel arrays by sorting and joining', () => {
			const fp = computePagingFingerprint({
				category: 'delivery_failure',
				channels: ['whatsapp', 'telegram'],
				requestId: 'req-789',
				errorCode: 500,
			});
			expect(fp).toBe('delivery_failure:telegram,whatsapp:req-789:500');
		});
	});

	describe('burst suppression', () => {
		it('suppresses identical failures during a burst, yielding 1 send and 9 dedupHits', () => {
			const deduplicator = new AdminPagingDeduplicator({ ttlMs: 300000 });
			const fingerprint = computePagingFingerprint({
				category: 'rate_limited',
				channel: 'telegram',
				requestId: 'req-burst-1',
				errorCode: 429,
			});

			const startTime = 1000000;
			// 10 simulated attempts over 60 seconds (every 6 seconds)
			const results = [];
			for (let i = 0; i < 10; i++) {
				const now = startTime + i * 6000;
				results.push(deduplicator.shouldSuppress(fingerprint, now));
			}

			// First should not be suppressed (yields 1 admin page)
			expect(results[0]).toBe(false);
			// Remaining 9 should be suppressed
			for (let i = 1; i < 10; i++) {
				expect(results[i]).toBe(true);
			}

			const status = deduplicator.getStatus();
			expect(status.dedupHits).toBe(9);
			expect(status.enabled).toBe(true);
			expect(status.dedupWindowMs).toBe(300000);
			expect(status.lastDedupAt).toBe(new Date(startTime + 9 * 6000).toISOString());
		});

		it('does not suppress a second distinct failure with a different channel', () => {
			const deduplicator = new AdminPagingDeduplicator({ ttlMs: 300000 });
			const fp1 = computePagingFingerprint({
				category: 'rate_limited',
				channel: 'telegram',
				requestId: 'req-1',
				errorCode: 429,
			});
			const fp2 = computePagingFingerprint({
				category: 'rate_limited',
				channel: 'whatsapp',
				requestId: 'req-1',
				errorCode: 429,
			});

			expect(deduplicator.shouldSuppress(fp1, 1000)).toBe(false);
			expect(deduplicator.shouldSuppress(fp2, 2000)).toBe(false);
			expect(deduplicator.getStatus().dedupHits).toBe(0);
		});

		it('does not suppress a second distinct failure with a different requestId', () => {
			const deduplicator = new AdminPagingDeduplicator({ ttlMs: 300000 });
			const fp1 = computePagingFingerprint({
				category: 'rate_limited',
				channel: 'telegram',
				requestId: 'req-1',
				errorCode: 429,
			});
			const fp2 = computePagingFingerprint({
				category: 'rate_limited',
				channel: 'telegram',
				requestId: 'req-2',
				errorCode: 429,
			});

			expect(deduplicator.shouldSuppress(fp1, 1000)).toBe(false);
			expect(deduplicator.shouldSuppress(fp2, 2000)).toBe(false);
			expect(deduplicator.getStatus().dedupHits).toBe(0);
		});

		it('does not suppress when errorCode or category differs', () => {
			const deduplicator = new AdminPagingDeduplicator({ ttlMs: 300000 });
			const fp1 = computePagingFingerprint({
				category: 'rate_limited',
				channel: 'telegram',
				requestId: 'req-1',
				errorCode: 429,
			});
			const fp2 = computePagingFingerprint({
				category: 'provider_error',
				channel: 'telegram',
				requestId: 'req-1',
				errorCode: 500,
			});

			expect(deduplicator.shouldSuppress(fp1, 1000)).toBe(false);
			expect(deduplicator.shouldSuppress(fp2, 2000)).toBe(false);
			expect(deduplicator.getStatus().dedupHits).toBe(0);
		});
	});

	describe('TTL window expiration', () => {
		it('allows a page after TTL window expires and resets the timer', () => {
			const ttlMs = 300000;
			const deduplicator = new AdminPagingDeduplicator({ ttlMs });
			const fp = 'rate_limited:telegram:req-1:429';

			const t0 = 1000000;
			expect(deduplicator.shouldSuppress(fp, t0)).toBe(false);
			expect(deduplicator.shouldSuppress(fp, t0 + 10000)).toBe(true);
			expect(deduplicator.getStatus().dedupHits).toBe(1);

			// After TTL + 1ms
			const tExpired = t0 + ttlMs + 1;
			expect(deduplicator.shouldSuppress(fp, tExpired)).toBe(false);
			// Within new TTL window, suppresses again
			expect(deduplicator.shouldSuppress(fp, tExpired + 1000)).toBe(true);
			expect(deduplicator.getStatus().dedupHits).toBe(2);
		});
	});

	describe('LRU capacity bounding', () => {
		it('bounds cache size to maxEntries and evicts the oldest entry first', () => {
			const maxEntries = 5;
			const deduplicator = new AdminPagingDeduplicator({ ttlMs: 300000, maxEntries });

			// Insert entries 1 to 5
			for (let i = 1; i <= 5; i++) {
				expect(deduplicator.shouldSuppress(`fp-${i}`, 1000 + i)).toBe(false);
			}

			// Entry 1 should be suppressed if queried now
			expect(deduplicator.shouldSuppress('fp-1', 1010)).toBe(true);

			// Insert entry 6, which should evict entry 2 (since fp-1 was refreshed on access)
			expect(deduplicator.shouldSuppress('fp-6', 1020)).toBe(false);

			// fp-2 was evicted, so querying it treats it as a brand new entry (shouldSuppress = false)
			expect(deduplicator.shouldSuppress('fp-2', 1030)).toBe(false);

			// fp-1 is still in cache, so querying it suppresses it
			expect(deduplicator.shouldSuppress('fp-1', 1040)).toBe(true);
		});
	});

	describe('disabled mode (ADMIN_PAGE_DEDUP_TTL_MS=0)', () => {
		it('disables deduplication and never suppresses when ttlMs is 0', () => {
			const deduplicator = new AdminPagingDeduplicator({ ttlMs: 0 });
			const fp = 'rate_limited:telegram:req-1:429';

			expect(deduplicator.isEnabled()).toBe(false);
			expect(deduplicator.shouldSuppress(fp, 1000)).toBe(false);
			expect(deduplicator.shouldSuppress(fp, 2000)).toBe(false);
			expect(deduplicator.shouldSuppress(fp, 3000)).toBe(false);

			const status = deduplicator.getStatus();
			expect(status.enabled).toBe(false);
			expect(status.dedupHits).toBe(0);
			expect(status.dedupWindowMs).toBe(0);
			expect(status.lastDedupAt).toBeNull();
		});

		it('respects process.env.ADMIN_PAGE_DEDUP_TTL_MS=0', () => {
			process.env.ADMIN_PAGE_DEDUP_TTL_MS = '0';
			const deduplicator = new AdminPagingDeduplicator();
			expect(deduplicator.isEnabled()).toBe(false);
			expect(deduplicator.getDedupWindowMs()).toBe(0);
			expect(deduplicator.shouldSuppress('any-fp', 1000)).toBe(false);
		});
	});

	describe('Remote Config integration', () => {
		it('prefers Remote Config ADMIN_PAGE_DEDUP_TTL_MS when available', () => {
			jest.spyOn(remoteConfigService, 'getRuntimeConfig').mockReturnValue({
				ADMIN_PAGE_DEDUP_TTL_MS: 120000,
			});

			const deduplicator = new AdminPagingDeduplicator();
			expect(deduplicator.getDedupWindowMs()).toBe(120000);
			expect(deduplicator.isEnabled()).toBe(true);
		});
	});
});
