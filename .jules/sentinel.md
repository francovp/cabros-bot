## 2025-02-19 - Critical: Missing Authentication on Webhooks
**Vulnerability:** Webhook endpoints `/webhook/alert` and `/news-monitor` were exposed publicly without any authentication, allowing anyone to trigger alerts or consume resources.
**Learning:** The endpoints were implemented with functionality in mind but the security middleware `validateApiKey` mentioned in documentation/memory was never actually implemented or applied.
**Prevention:** Always verify that "protected" endpoints actually have the protection middleware applied in the route definition. Use integration tests that explicitly check for 401/403 responses on unauthorized access, not just 200 on success.
