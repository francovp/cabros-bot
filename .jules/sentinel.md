## 2024-05-23 - Unprotected Webhook Endpoints
**Vulnerability:** Critical endpoints (`/webhook/alert` and `/news-monitor`) were publicly accessible without any authentication, despite documentation/memory suggesting otherwise.
**Learning:** Documentation and memory can drift from codebase reality. The `auth.js` file referenced in memory did not exist in the codebase.
**Prevention:** Always verify security controls by inspecting code and running verification tests, rather than relying on documentation or assumed state. Implement "fail-closed" defaults where possible.
