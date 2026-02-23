# feat(auth): add support for API key in query params

## Summary

Adds support for API key authentication via query parameters (`api-key`) in webhook endpoints, while preserving existing `x-api-key` header validation and timing-safe comparison.

## Key Changes

### 🔐 Extended webhook API key input

- Updated `validateApiKey` middleware to accept API keys from either:
  - `x-api-key` header (recommended)
  - `api-key` query parameter (fallback compatibility path)
- Maintains existing secure validation with `crypto.timingSafeEqual`.
- Preserves current HTTP behavior:
  - `401` for missing API key
  - `403` for invalid API key

### 🛡️ Security behavior preserved

- Kept fixed-length comparison guard before timing-safe equality check.
- Preserved warning + pass-through behavior when `WEBHOOK_API_KEY` is unset.
- Added inline guidance clarifying that headers remain the recommended transport over query params.

## Technical Implementation

### Architecture changes

#### `src/lib/auth.js`

- API key extraction changed from header-only to header-or-query strategy:
  - Previous: `req.headers['x-api-key']`
  - New: `req.headers['x-api-key'] || req.query['api-key']`
- Existing array normalization and secure buffer comparisons remain unchanged.

## Testing infraestructure

### Test Suite

- **29 Test Suites**
- **365 Tests**

### Test Coverage

- Full existing test suite executed successfully to validate no regressions in auth-sensitive and webhook flows.

## Examples

Use either method for protected webhook endpoints:

- Header-based (recommended): `x-api-key: <WEBHOOK_API_KEY>`
- Query-based: `?api-key=<WEBHOOK_API_KEY>`

## Security

- Continues to use timing-safe comparison to reduce timing attack risk.
- Query param support improves client compatibility, but headers remain preferred to reduce accidental key exposure in logs/proxies.

## Testing

### Pre-merge Verification

- [ ] Validate header-based API key requests still return expected responses
- [ ] Validate query param API key requests are accepted when key is correct
- [ ] Validate invalid/missing keys continue returning `401/403` correctly

### Post-merge Verification

- [ ] Confirm webhook clients using `x-api-key` continue working in production
- [ ] Confirm fallback `api-key` query integration works for legacy clients
- [ ] Review access logs/pipeline configs to avoid query key leakage

## References

- Commit: `d14614d` (`feat(auth): add support for API key in query params`)
- File changed: `src/lib/auth.js`

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
