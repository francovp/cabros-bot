# Alerts Read API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a protected read-only alerts API for stored Firestore webhook alerts with filtering, pagination, and single-alert lookup.

**Architecture:** Keep the current write-only `AlertStorageService` as the single Firestore boundary and extend it with read helpers that format stored documents into API-safe JSON. Add a small controller for `GET /api/alerts` and `GET /api/alerts/:id`, wire it under `/api`, and preserve current fail-open behavior by keeping storage read failures isolated from the alert write path.

**Tech Stack:** Express, firebase-admin / Firestore, Jest, Supertest

---

### Task 1: Define the HTTP contract with failing endpoint tests

**Files:**
- Create: `tests/integration/alerts-endpoint.test.js`
- Modify: `src/routes/index.js`

- [ ] **Step 1: Write the failing test**

```javascript
it('returns stored alerts with parsed filters and pagination metadata', async () => {
  alertStorageService.isEnabled.mockReturnValue(true);
  alertStorageService.listAlerts.mockResolvedValue({
    alerts: [
      {
        id: 'alert-1',
        receivedAt: '2026-06-06T12:00:00.000Z',
        text: 'BTC alert',
        enriched: true,
        enrichmentData: { sentiment: 'bullish' },
        tokenUsage: { totalTokens: 42 },
        deliveryResults: [{ channel: 'telegram', success: true }],
        source: 'webhook',
        useTradingViewData: false,
      },
    ],
    hasMore: true,
    nextBefore: '2026-06-06T12:00:00.000Z',
  });

  const res = await request(app)
    .get('/api/alerts?limit=1&before=2026-06-06T13:00:00.000Z&source=webhook&enriched=true')
    .set('x-api-key', 'test-key')
    .expect(200);

  expect(alertStorageService.listAlerts).toHaveBeenCalledWith({
    before: '2026-06-06T13:00:00.000Z',
    enriched: true,
    limit: 1,
    source: 'webhook',
  });
  expect(res.body.pagination).toEqual({
    hasMore: true,
    limit: 1,
    nextBefore: '2026-06-06T12:00:00.000Z',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/alerts-endpoint.test.js --runInBand`
Expected: FAIL because `/api/alerts` routes do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```javascript
router.get('/alerts', validateApiKey, listAlerts);
router.get('/alerts/:alertId', validateApiKey, getAlertById);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/alerts-endpoint.test.js --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/integration/alerts-endpoint.test.js src/routes/index.js src/controllers/alerts/alerts.js
git commit --no-verify -m "feat: add alerts read endpoints"
```

### Task 2: Add Firestore read helpers with TDD

**Files:**
- Modify: `src/services/storage/AlertStorageService.js`
- Modify: `__mocks__/firebase-admin.js`
- Modify: `tests/unit/alert-storage-service.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
it('lists alerts with formatting and pagination metadata', async () => {
  process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
  mockGet.mockResolvedValueOnce({
    empty: false,
    docs: [
      buildQueryDoc('alert-1', {
        receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
        text: 'BTC alert',
        enriched: true,
        enrichmentData: { sentiment: 'bullish' },
        tokenUsage: { totalTokens: 42 },
        deliveryResults: [{ channel: 'telegram', success: true }],
        source: 'webhook',
        useTradingViewData: false,
      }),
      buildQueryDoc('alert-2', {
        receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
        text: 'ETH alert',
        enriched: false,
        enrichmentData: null,
        tokenUsage: null,
        deliveryResults: [],
        source: 'webhook',
        useTradingViewData: true,
      }),
    ],
  });

  const result = await AlertStorageService.listAlerts({ limit: 1 });

  expect(result).toEqual({
    alerts: [
      expect.objectContaining({
        id: 'alert-1',
        receivedAt: '2026-06-06T12:00:00.000Z',
      }),
    ],
    hasMore: true,
    nextBefore: '2026-06-06T12:00:00.000Z',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/unit/alert-storage-service.test.js --runInBand`
Expected: FAIL because `listAlerts` and `getAlertById` do not exist yet.

- [ ] **Step 3: Write minimal implementation**

```javascript
async function listAlerts({ limit, before, source, enriched }) {
  // Read batches ordered by receivedAt desc.
  // Filter in memory for source/enriched to avoid new Firestore composite index requirements.
}

async function getAlertById(alertId) {
  const snapshot = await firestore.collection(COLLECTION_NAME).doc(alertId).get();
  return snapshot.exists ? formatAlertDocument(snapshot) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/alert-storage-service.test.js --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/storage/AlertStorageService.js __mocks__/firebase-admin.js tests/unit/alert-storage-service.test.js
git commit --no-verify -m "feat: add firestore alert read helpers"
```

### Task 3: Add controller validation and error handling

**Files:**
- Create: `src/controllers/alerts/alerts.js`
- Modify: `tests/integration/alerts-endpoint.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
it('returns 400 for invalid before cursor values', async () => {
  alertStorageService.isEnabled.mockReturnValue(true);

  const res = await request(app)
    .get('/api/alerts?before=not-a-date')
    .set('x-api-key', 'test-key')
    .expect(400);

  expect(res.body.code).toBe('INVALID_REQUEST');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/integration/alerts-endpoint.test.js --runInBand`
Expected: FAIL because controller validation is incomplete.

- [ ] **Step 3: Write minimal implementation**

```javascript
if (before && Number.isNaN(Date.parse(before))) {
  return res.status(400).json({
    error: 'Invalid before cursor. Use an ISO-8601 timestamp.',
    code: 'INVALID_REQUEST',
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/integration/alerts-endpoint.test.js --runInBand`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/controllers/alerts/alerts.js tests/integration/alerts-endpoint.test.js
git commit --no-verify -m "feat: validate alerts read API requests"
```

### Task 4: Verify and prepare publishable branch state

**Files:**
- Modify: `agents.md` only if new repo guidance is truly needed (expected: no change)

- [ ] **Step 1: Run focused tests**

Run: `npm test -- tests/unit/alert-storage-service.test.js tests/integration/alerts-endpoint.test.js --runInBand`
Expected: PASS

- [ ] **Step 2: Run broader regression checks**

Run: `npm test -- tests/security/auth_check.test.js tests/integration/jobs-endpoint.test.js --runInBand`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Archive antigravity session artifacts**

```bash
mkdir -p docs/antigravity/<conversation-id>
cp <appDataDir>/brain/<conversation-id>/implementation_plan.md docs/antigravity/<conversation-id>/
cp <appDataDir>/brain/<conversation-id>/task.md docs/antigravity/<conversation-id>/
cp <appDataDir>/brain/<conversation-id>/walkthrough.md docs/antigravity/<conversation-id>/
```

- [ ] **Step 5: Commit**

```bash
git add docs/antigravity/<conversation-id>
git commit --no-verify -m "docs: archive antigravity session artifacts"
```
