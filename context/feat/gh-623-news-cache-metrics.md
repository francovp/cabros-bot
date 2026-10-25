# News Monitor Cache Metrics

## Summary

Expose operational hit, miss, eviction, and memory-estimate metrics for the news-monitor cache through `/api/status`.

## Key Changes

- Add cache metrics and a readiness projection at `dependencies.newsMonitorCache` while the news monitor is enabled.
- Document the additive status contract in OpenAPI, the API reference, and the Postman collection.
- Keep durable deduplication readiness on the existing `dependencies.newsMonitorDedup` block.

## Technical Implementation

Metrics are process-local and reset on restart. Estimated memory includes serialized entry data, the key, and fixed per-entry overhead; it is an estimate rather than a heap measurement. Expiry, capacity eviction, and abandoned-claim replacement contribute to the eviction count.

## Testing

- Focused verification: 7 Jest suites, 389 tests passed.
- Full `pnpm test`: 299 suites passed; one unrelated `public-status-endpoint` rate-limit test hit a socket hang-up. The isolated suite passed 5/5 on rerun.
- ESLint passed for the cache implementation, status controller, and cache unit tests.

## References

- Closes #623: https://github.com/francovp/cabros-bot/issues/623
