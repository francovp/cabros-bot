# Sentinel's Journal

## 2024-05-24 - Rate Limiting Implementation
**Vulnerability:** Missing rate limiting on API endpoints exposed to potential DoS attacks.
**Learning:** Even if `express-rate-limit` is mentioned in memory, it might not be installed or used. Always verify presence of files and dependencies.
**Prevention:** Explicitly check for rate limiting middleware in the main app entry point (`app.js` or `index.js`).
