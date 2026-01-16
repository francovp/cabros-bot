## 2025-02-14 - Unauthorized Webhook Access
**Vulnerability:** Publicly accessible webhook endpoints (`/webhook/alert`, `/news-monitor`) allowed unauthenticated triggering of alerts and operations.
**Learning:** Adding new endpoints without default security middleware leaves them exposed by default.
**Prevention:** Implement a default "deny all" policy for new routes or require explicit authentication middleware application for all routes in `getRoutes`.
