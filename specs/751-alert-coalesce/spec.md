# Alert-only coalescing (#751)

Opt-in ENABLE_ALERT_COALESCE=false suppresses identical body/query requests on POST /api/webhook/alert for ALERT_COALESCE_WINDOW_MS=5000 (integer 1–60000). Fingerprints include effective channels and destinations, retain only hashes, and use a process-local LRU of at most 10000 entries. No shared boundedCache helper exists in this checkout; use a bounded Map without dependencies.

Wait for pending originals before acknowledging duplicates; suppress only fully successful, nonempty channel delivery. Exceptions, partial failures, empty deliveries and expired reservations remain retryable. Return HTTP 200 with coalesced=true, originalRequestId and the duplicate requestId. Avoid duplicate enrichment, persistence and outcome side effects. Pending claims expire after 180 seconds; bounded waits fail open.

Dry-run, auto-trade, symbol/destination fanout, watchlist routing and asynchronous subscriber delivery bypass coalescing. Keep expanded analysis and Telegram throttle defaults unchanged. Both non-secret settings are Remote Config eligible; auth, destinations and startup gates remain environment-only. Document process-local limits and partial-delivery retries.
