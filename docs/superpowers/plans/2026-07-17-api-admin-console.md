# API Admin Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a same-origin `/admin` console for Cabros Bot operations and an OpenAPI-backed API playground.

**Architecture:** Serve three static admin assets through the existing public docs router. A small browser client keeps its API key only in `sessionStorage`, calls the existing `/api` routes with native `fetch`, and reads `/openapi.json` to populate the playground. A tiny shared request helper stays dependency-free and is unit tested in Node.

**Tech Stack:** Node.js 20, Express 4, vanilla HTML/CSS/JavaScript, Jest, Supertest.

## Global Constraints

- Keep all protected `/api` handlers behind the existing `validateApiKey` middleware.
- Do not add dependencies, backend credential storage, a proxy, API routes, or API-contract changes.
- Store the operator key only in `sessionStorage` and only send it in the `x-api-key` header.
- Keep `/docs` and `/openapi.json` public and read-only.
- Use external static CSS and JavaScript so Helmet's default CSP remains valid.
- Update `CabrosBot.postman_collection.json` only if an API contract changes; this plan makes none.

---

### Task 1: Serve the admin shell

**Files:**
- Create: `src/admin/index.html`
- Create: `src/admin/admin.css`
- Create: `src/admin/admin.js`
- Modify: `src/openapi/docs.js`
- Modify: `tests/integration/openapi-docs.test.js`

**Interfaces:**
- Consumes: the public `getOpenApiDocsRouter()` router.
- Produces: `GET /admin`, `/admin/admin.css`, and `/admin/admin.js` public static assets.

- [ ] **Step 1: Write the failing route test**

```js
it('serves the API admin shell and external assets without an API key', async () => {
  const page = await request(app).get('/admin');
  const script = await request(app).get('/admin/admin.js');

  expect(page.status).toBe(200);
  expect(page.text).toContain('Cabros Bot Console');
  expect(page.text).toContain('/admin/admin.js');
  expect(page.text).not.toContain(process.env.WEBHOOK_API_KEY);
  expect(script.status).toBe(200);
  expect(script.headers['content-type']).toMatch(/javascript/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- tests/integration/openapi-docs.test.js --testNamePattern="API admin shell"`

Expected: FAIL because `/admin` does not exist.

- [ ] **Step 3: Add the static route and accessible shell**

Add `adminDir = path.join(__dirname, '../admin')`, `router.get('/admin', ...)`, and `router.use('/admin', express.static(adminDir, { index: false, immutable: true, maxAge: '1d' }))` to `src/openapi/docs.js`. Create an external-asset HTML shell with:

```html
<main class="console-shell">
  <header><h1>Cabros Bot Console</h1><button id="clear-key">Clear key</button></header>
  <section aria-labelledby="connection-title">
    <h2 id="connection-title">Connection</h2>
    <label>API key <input id="api-key" type="password" autocomplete="off"></label>
    <button id="save-key">Use key for this session</button>
  </section>
  <nav aria-label="Console sections">
    <button data-view="status">Status</button><button data-view="alerts">Alerts</button>
    <button data-view="presets">Presets</button><button data-view="jobs">Jobs</button>
    <button data-view="analysis">Analysis</button><button data-view="playground">Playground</button>
  </nav>
  <section id="view" aria-live="polite"></section>
</main>
<script src="/admin/admin-request.js" defer></script>
<script src="/admin/admin.js" defer></script>
```

Style focus indicators, responsive layout, visible request state, readable response blocks, and destructive-action confirmation in `admin.css`. Do not put credentials in values rendered back into the document.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test -- tests/integration/openapi-docs.test.js --testNamePattern="API admin shell"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin src/openapi/docs.js tests/integration/openapi-docs.test.js
git commit -m "feat(admin): serve operator console"
```

### Task 2: Add testable, browser-safe request helpers

**Files:**
- Create: `src/admin/admin-request.js`
- Create: `tests/unit/admin-request.test.js`

**Interfaces:**
- Produces: `window.CabrosAdminRequest.createRequest({ path, method, query, body, apiKey })` returning `{ url, options }`; CommonJS export exposes the same API for Jest.
- Consumes: native browser `URLSearchParams`, `fetch`, and the existing API-key header convention.

- [ ] **Step 1: Write the failing unit tests**

```js
const { createRequest } = require('../../src/admin/admin-request');

it('creates a same-origin request with an API-key header and JSON body', () => {
  expect(createRequest({
    path: '/api/webhook/volume-confirmation', method: 'POST', apiKey: 'secret',
    body: { symbol: 'BINANCE:BTCUSDT' }, query: { dryRun: false },
  })).toEqual({
    url: '/api/webhook/volume-confirmation?dryRun=false',
    options: expect.objectContaining({
      method: 'POST', body: '{"symbol":"BINANCE:BTCUSDT"}',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'secret' },
    }),
  });
});

it('rejects a non-relative API path', () => {
  expect(() => createRequest({ path: 'https://example.com', method: 'GET' })).toThrow('API path must start with /api/');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- tests/unit/admin-request.test.js`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the minimal helper**

Implement a UMD-style module that exports in Node and assigns `window.CabrosAdminRequest` in the browser. Validate that `path` starts with `/api/`, omit `undefined` query values, serialize only non-empty JSON bodies, set `Content-Type: application/json` for bodies, and set `x-api-key` only when a key is present. Do not construct absolute URLs and do not expose a header-inspection API.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test -- tests/unit/admin-request.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/admin-request.js tests/unit/admin-request.test.js
git commit -m "feat(admin): add safe request helper"
```

### Task 3: Implement the operator workflows and playground

**Files:**
- Modify: `src/admin/index.html`
- Modify: `src/admin/admin.js`
- Modify: `src/admin/admin.css`
- Modify: `tests/integration/openapi-docs.test.js`

**Interfaces:**
- Consumes: `window.CabrosAdminRequest.createRequest`, `/openapi.json`, and the existing `/api` operations.
- Produces: interactive Status, Alerts, Presets, Jobs, Analysis, and Playground views.

- [ ] **Step 1: Extend the route test for public contract discovery**

```js
it('keeps the admin client contract-driven without exposing the configured API key', async () => {
  const client = await request(app).get('/admin/admin.js');

  expect(client.status).toBe(200);
  expect(client.text).toContain("fetch('/openapi.json')");
  expect(client.text).not.toContain(process.env.WEBHOOK_API_KEY);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test -- tests/integration/openapi-docs.test.js --testNamePattern="contract-driven"`

Expected: FAIL because the client does not load the contract.

- [ ] **Step 3: Implement the smallest useful views**

In `admin.js`, load the public contract once and create forms from a small operation map:

```js
const VIEWS = {
  status: [{ method: 'GET', path: '/api/status', label: 'Refresh status' }],
  alerts: [{ method: 'GET', path: '/api/alerts', label: 'Load alerts' }],
  presets: [{ method: 'GET', path: '/api/scanner-presets', label: 'Load presets' }],
  jobs: [{ method: 'POST', path: '/api/jobs/tradingview-analysis', label: 'Create job' }],
  analysis: [
    { method: 'POST', path: '/api/webhook/expanded-analysis-alert', label: 'Expanded analysis' },
    { method: 'POST', path: '/api/webhook/market-scanner-alert', label: 'Market scanner' },
    { method: 'POST', path: '/api/webhook/volume-confirmation', label: 'Volume confirmation' },
    { method: 'POST', path: '/api/news-monitor', label: 'News monitor' },
  ],
};
```

Render a JSON textarea for POST bodies and query inputs for GET operations. Include operation-specific example JSON from the contract. For alert replay, preset run/delete, and job cancel/retry actions, ask `window.confirm()` immediately before the request. The Playground lists contract paths/operations, lets the operator supply path parameters, query JSON, and a request body, then calls the helper. Render status, elapsed time, and formatted JSON/text response; never render the API key or raw request headers.

Use `sessionStorage.getItem('cabros-admin-api-key')` only to prefill the password field while the session exists, update it only after an explicit save action, and remove it on clear. Every request failure must render its HTTP status or network message and leave the console usable.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `pnpm test -- tests/integration/openapi-docs.test.js --testNamePattern="contract-driven"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/index.html src/admin/admin.js src/admin/admin.css tests/integration/openapi-docs.test.js
git commit -m "feat(admin): add API workflows"
```

### Task 4: Verify the complete integration and documentation

**Files:**
- Modify: `context/codex-api-admin-site.md`

**Interfaces:**
- Consumes: completed static console assets and their focused tests.
- Produces: a review-ready branch summary without API-contract documentation changes.

- [ ] **Step 1: Run focused checks**

Run: `pnpm test -- tests/unit/admin-request.test.js tests/integration/openapi-docs.test.js`

Expected: PASS.

- [ ] **Step 2: Run the full regression suite**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Check the production diff**

Run: `git diff master...HEAD --check && git diff master...HEAD -- src/openapi/openapi.json CabrosBot.postman_collection.json`

Expected: no whitespace errors and no API-contract or Postman changes.

- [ ] **Step 4: Update the branch context**

Update `context/codex-api-admin-site.md` so its title ends with `(CB-58)`, its summary covers the complete console, and its References section includes `Fixes #190` and the Linear issue URL.

## Self-Review

- Spec coverage: Tasks 1–3 cover the same-origin UI, browser-only credentials, six required views, native fetch, contract discovery, and destructive-action confirmation. Task 4 verifies the scope boundary.
- Placeholder scan: no incomplete placeholders or undefined implementation steps remain.
- Type consistency: `createRequest()` is defined by Task 2 and consumed by Task 3 with the same object argument and return values.
