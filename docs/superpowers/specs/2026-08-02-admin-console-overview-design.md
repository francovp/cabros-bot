# feat(admin): add operational overview

## Scope

Refresh the static `/admin` console with a modern responsive layout and add an `Overview` view for operators. The view consumes the existing protected `GET /api/status` contract and presents service identity, feature readiness, delivery channels, and dependency health as readable cards.

## Decisions

- Use CSS custom properties, Grid, Flexbox, and native DOM rendering instead of Tailwind, Bootstrap, Material, or a new build pipeline. The admin assets are served directly by Express and the repository has no frontend bundler.
- Keep the current API-key flow, request helper, OpenAPI-driven forms, destructive confirmations, and all existing views.
- Render status values with `textContent` and bounded derived counts; do not expose secrets or change API contracts.
- Keep the raw status response available below the dashboard for troubleshooting and preserve error messages when `/api/status` is unavailable.

## Components and flow

1. `src/admin/index.html` provides the responsive shell, brand, sidebar navigation, session-key panel, and main view region.
2. `src/admin/admin.css` supplies the visual system, cards, status badges, responsive breakpoints, focus states, and reduced-motion behavior.
3. `src/admin/admin.js` adds the Overview renderer and refresh action. It reuses `sendRequest()` and the existing API-key header path, then derives display-only metrics from the status payload.
4. `tests/unit/admin-client.test.js` exercises the user-visible Overview rendering with a complete status fixture.

## Failure handling

If the status request fails, the dashboard retains the existing redacted error rendering. If optional status sections are absent, the dashboard shows zero/unknown values instead of throwing.

## Verification

- Run the focused admin client test.
- Run the full Jest suite once after implementation.
- No Postman or OpenAPI changes are required because this is a static consumer of an unchanged endpoint.
