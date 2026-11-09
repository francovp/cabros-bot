# Data Model: Request-level Trader Intent Outcomes

## TraderIntent

| Field | Type | Rules |
|---|---|---|
| `side` | string, optional | `BUY` or `SELL`; required when a barrier exists |
| `entry` | number | finite and greater than zero |
| `invalidation` | number, optional | finite, positive, directionally ordered |
| `target` | number, optional | finite, positive, directionally ordered |
| `horizon` | string | exactly `1h`, `4h`, `1D`, or `1W` |
| `notes` | string, optional | trimmed, 1-500 characters |

Unknown fields are rejected. Sanitization returns a new plain object and omits absent optional fields.

## TraderPlanOutcome

Stored only on the intent's matching outcome window and only for complete plans.

| Field | Type | Meaning |
|---|---|---|
| `status` | string | Existing window lifecycle (`pending`, `evaluated`, `unavailable`) |
| `targetHit` | boolean | Target barrier touched during the bounded window |
| `stopHit` | boolean | Stop barrier touched during the bounded window |
| `firstHit` | string/null | `target`, `stop`, or null using conservative same-bar precedence |
| `firstHitTime` | ISO timestamp/null | First decisive barrier timestamp |
| `return` | number | Side-aware percent return at evaluation close |
| `rMultiple` | number/null | Return divided by explicit entry-to-invalidation risk |

## Aggregate

`byTraderPlan` is always additive: `{ hitRatePercent, samples, averageRMultiple }`. `samples` counts evaluated complete plans only; zero samples produce `0` hit rate and `null` average R multiple.

## Relationships and lifecycle

- The same sanitized `TraderIntent` may be copied to an alert document and its corresponding signal-outcome document.
- Symbol-analysis storage may hold the annotation for auditability, but phase 1 does not create a signal outcome from that endpoint.
- Retention follows the containing document; no separate collection or TTL is introduced.
