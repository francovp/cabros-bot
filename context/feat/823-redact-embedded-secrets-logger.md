# feat(logging): extend logger to redact bare-scalar, string-embedded, and URL-embedded secrets

## Summary

Extends `src/lib/logging.js` with comprehensive multi-layer secret redaction to prevent accidental token/key exposure in stdout. In addition to existing plain-object sensitive keys, the logger now redacts bare scalars preceded by sensitive key labels (e.g. `console.log('api-key:', apiKey)`), embedded string secrets (e.g. JSON strings `console.log('p=' + JSON.stringify({ token }))`), secrets in URL query parameters (e.g. `console.log('GET', urlWithApiKey)`), well-known credential patterns (Bearer tokens, Discord webhook URLs, Telegram bot tokens, OpenAI keys), and request-scoped registered secrets via `registerSecretValue` and `clearSecretValue`.

## Key Changes

- **Bare-Scalar Redaction**:
  - Detects sensitive key labels preceding argument values in `buildLogEntry` via `isSensitiveKeyLabel` (e.g. `api-key:`, `apiKey:`, `Token =`, `password:`, `secret:`, `authorization:`).
  - Replaces the argument value with `[REDACTED]` in both `message` and `parameters` arrays.
- **Pattern-Based String Redaction (`redactString`)**:
  - Masking secrets in URL query parameters: `([?&](?:api[-_]?key|token|password|secret|access[-_]?token)=)([^&\s#"']+)` -> `$1[REDACTED]`.
  - Masking JSON string properties: `"password"|"secret"|"token"|"api_key"|...` -> `"$1":"[REDACTED]"`.
  - Masking Authorization headers and Bearer tokens: `authorization: Bearer [REDACTED]`, `authorization: Basic [REDACTED]`, `Bearer [REDACTED]`.
  - Masking Discord webhook URLs: `https://discord.com/api/webhooks/<id>/[REDACTED]`.
  - Masking Telegram bot tokens: `[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}` -> `[REDACTED]`.
  - Masking OpenAI keys: `sk-[A-Za-z0-9]{16,}` -> `[REDACTED]`.
  - Masking key-value scalar string patterns: `api-key: [REDACTED]`, `token=[REDACTED]`.
- **Request-Scoped Secret Registry**:
  - Implements `registerSecretValue(value)`, `clearSecretValue(value)`, and `clearAllSecretValues()`.
  - Registered secrets are sanitized (trimmed, min length 4) and replaced in longest-first order to prevent partial substrings from breaking tokens.
  - Lifecycle cleanup integrated into `_resetLoggingForTests()`.
- **Object & Error Coverage**:
  - String values inside plain objects and arrays normalized through `normalizeValue` are passed through `redactString`.
  - Error messages and stack traces serialized through `serializeError` are passed through `redactString`.
- **Zero Overhead / Non-Breaking**:
  - Non-sensitive log lines remain byte-identical.
  - Benchmarked 5KB text redaction takes ~0.06ms on warm V8 (well under the 1.0ms performance budget).
- **Documentation Parity**:
  - Updated `AGENTS.md` (lines 61, 154) and `README.md` (line 221) documenting the multi-layer redaction and registry helpers.

## Technical Implementation

- `src/lib/logging.js`:
  - Added `registeredSecrets` Set and exported `registerSecretValue`, `clearSecretValue`, `clearAllSecretValues`, and `redactString`.
  - Added `isSensitiveKeyLabel` for preceding argument detection in `buildLogEntry`.
  - Applied `redactString` to raw message, string message parts, normalized string values, and serialized errors.
- `tests/unit/logging.test.js`:
  - Added test suite covering bare-scalar leaks, JSON string leaks, URL query parameter leaks, Bearer tokens, Discord webhooks, Telegram tokens, OpenAI keys, request-scoped secret registry lifecycle, 5KB performance benchmark (<1ms), and byte-identical output invariance for non-sensitive logs.
- `AGENTS.md`:
  - Updated `src/lib/logging.js` file entry and `Sensitive Key Redaction` section under Security Considerations.
- `README.md`:
  - Updated `LOG_LEVEL` environment variable description with multi-layer redaction details.

## Testing

- `pnpm test -- tests/unit/logging.test.js` (14 tests passing)
- `pnpm test -- tests/unit/docs-alignment.test.js` (9 tests passing)
- `pnpm test -- tests/unit/postman-collection.test.js` (15 tests passing)

## References

- Closes #823
- Linear: N/A (Linear issue creation skipped per user instructions)
