# Tasks: Event Category Filtering for News Monitor (Issue #735)

- [x] Task 1: Add `ALLOWED_EVENT_CATEGORIES` to `constants.js`
- [x] Task 2: Implement category parsing and validation in `newsMonitor.js`
- [x] Task 3: Implement category filtering in `analyzer.js` (both cache reads and post-Gemini analysis)
- [x] Task 4: Write unit tests in `tests/unit/news-monitor-categories.test.js`
- [x] Task 5: Write integration tests in `tests/integration/news-monitor-categories.test.js`
- [x] Task 6: Update `src/openapi/openapi.json` with `categories` parameter
- [x] Task 7: Update `CabrosBot.postman_collection.json` with category-filtered requests
- [x] Task 8: Run `postman-collection.test.js` and all tests, verify clean working tree
