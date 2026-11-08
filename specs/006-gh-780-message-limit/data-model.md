# Data Model: Configurable generic message limit

No user or persistent data entity is added. The feature adds one runtime setting:

| Setting | Type | Default | Valid range | Lifetime |
|---|---|---:|---:|---|
| `GENERIC_MESSAGE_MAX_LENGTH` | Integer | 4000 characters | 1..20000 inclusive | Environment fallback or fresh Remote Config value |

The effective value is read for each request. A malformed or out-of-range environment value uses the safe default. An invalid Remote Config value is ignored, leaving a valid environment value or the default effective. No message content, destination, credential, or per-request override is stored as part of this setting.
