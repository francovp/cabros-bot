---
name: async-integration-review
description: Use when changing workers, polling loops, native fetch calls, provider retries, rate-limit handling, notification delivery, shutdown, or telemetry around asynchronous external work.
---

# Async Integration Review

Bound every external operation and prove that retries, deadlines, fairness, and shutdown behave under failure.

## Checklist

1. **One deadline.** Derive remaining time once per operation, pass it to the request via `AbortController`/native timeout, and keep response-body reads inside the same deadline. A wrapper timeout must not leave a zombie request running.
2. **Recheck after waits.** After cooldown, backoff, or queue waits, recompute the remaining budget and re-read shared state. A concurrent 429 can extend a cooldown while another caller sleeps.
3. **Retry only safe failures.** Retry transient transport/429 failures with the provider's full `Retry-After` value and bounded total delay. Do not retry or relabel definitive provider rejections as transient.
4. **Preserve accounting.** Every attempted request, failed chunk, status code, and retry delay must survive error paths so Sentry/admin notifications report reality.
5. **Prevent starvation.** Paginate or rotate worker batches; advance cursors only past documents actually processed. Keep sweeps single-flight and check the deadline between items and sub-requests.
6. **Validate scheduling inputs.** Reject malformed, fractional, exponent-form, zero, negative, or unbounded intervals/durations before passing them to timers. Use one fallback value for runtime behavior and status reporting.
7. **Drain cleanly.** On SIGTERM/SIGINT, stop new work, drain in-flight work within a bound, flush monitoring, then exit. Do not force-exit before the final flush.

## Required tests

For each changed path, test the smallest failing case:

- provider headers arrive but the body stalls;
- timeout/cooldown expires while another caller extends it;
- `Retry-After` exceeds one retry or total budget;
- transport failure versus definitive provider rejection;
- partial batch timeout and cursor fairness across the next sweep;
- malformed timer input and shutdown with in-flight work;
- telemetry retains attempt count, status, and sanitized failure context.

Use focused Jest tests, then `pnpm test` once as the final repository check. Keep optional notification/provider failures fail-open when the route contract requires delivery to continue.

## Evidence from recent reviews

The last 100 repository PRs contained repeated unresolved findings in PRs #348, #346, #343, #315, #274, #265, #263, #262, #247, and #246 covering cooldown races, stale deadlines, open response bodies, worker starvation, invalid timer parsing, shutdown flushes, Discord retry delays, and attempt-count telemetry.
