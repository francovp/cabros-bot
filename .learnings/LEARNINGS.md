## [LRN-20261026-054842-6298] correction

**Logged**: 2026-10-26T05:48:42.772377Z
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
## Automation design decision (2026-10-26)

I’m resolving the open validation-order question in favor of the existing security boundary: request validation must run after the global rate limiter and e...

### Details
Correction from @francovp on Issue #739:

> ## Automation design decision (2026-10-26)

I’m resolving the open validation-order question in favor of the existing security boundary: request validation must run after the global rate limiter and endpoint authentication, and before idempotency or handler work. Validating before `validateApiKey` would expose schema details to unauthenticated callers and let malformed requests avoid the API rate limit.

The first implementation tranche will cover the six `POST /api/webhook/*` operations in OpenAPI. Validation failures will use the existing 400 error envelope with code `VALIDATION_ERROR`; details will contain sanitized field paths and schema keywords, never submitted values. `ENABLE_REQUEST_VALIDATION` will default to `true` as the issue requests, while `false` preserves existing handler checks. This request-security gate stays environment-only and is excluded from Firebase Remote Config.

No PR references this issue. I’m proceeding with that bounded design and will update OpenAPI, Postman examples, and operator docs.


**Source URL**: https://github.com/francovp/cabros-bot/issues/739#issuecomment-6408312128

### Suggested Action
Review the feedback and implement necessary changes.

### Metadata
- Source: user_feedback
- Related Files: TBD
- Tags: correction, feedback
- See Also: https://github.com/francovp/cabros-bot/issues/739#issuecomment-6408312128
- Pattern-Key: harden.feedback_response

---
