## Summary

Implemented Brave Search API integration for grounding in the Gemini service. This provides a robust fallback mechanism when Google Search is unavailable or returns no results, ensuring consistent alert enrichment and news analysis.

## Key Changes

### 🔍 Brave Search Integration

- Implemented `_searchBrave` in `GenaiClient` to fetch search results from Brave Search API.
- Added `_executeBraveSearch` to generate grounded text using LLM based on Brave search results.
- Maintained compatible source fetching and citation logic.

### 🛡️ Robust Grounding Fallback

- Implemented a multi-stage search logic: Force Brave (if configured) -> Google Search -> Fallback to Brave Search.
- Added graceful handling of Google Search failures and empty results.

### ⚙️ Configuration Updates

- Added `BRAVE_SEARCH_API_KEY`, `BRAVE_SEARCH_ENDPOINT`, and `FORCE_BRAVE_SEARCH` environment variables.
- Refactored `GenaiClient` to use a centralized config object.
- Fixed `ENABLE_NEWS_MONITOR_TEST_MODE` to be a constant.

### 📝 Enhanced Logging

- Added detailed debug logs for enriched alert context.
- Improved logging for LLM call candidates and usage metadata.

### 🧪 Testing Infrastructure

- Updated `genaiClient.test.js` with comprehensive test suites for:
    - Default Google Search behavior.
    - Fallback to Brave Search on Google failure or empty results.
    - Forced Brave Search mode.
- Mocked `fetch` and configuration for unit tests.

## Technical Implementation

### Architecture changes

#### GenaiClient

The `GenaiClient` now orchestrates multiple search providers. It uses native `fetch` for Brave Search API calls and leverages the existing Gemini model to process search results into grounded answers when using Brave.

### File Structure Additions

```
src/
└── services/
    └── grounding/
        ├── config.js        # Updated with Brave Search settings
        ├── gemini.js        # Enhanced logging for enriched alerts
        └── genaiClient.js   # Core Brave Search and fallback logic
tests/
└── unit/
    └── genaiClient.test.js  # Updated with Brave Search test cases
```

## Testing infraestructure

### Test Suite

- **10+ Unit Tests** (Updated `genaiClient.test.js`)

### Test Coverage

- Added tests for `_searchBrave` logic.
- Added tests for `search` fallback mechanism.
- Added tests for `FORCE_BRAVE_SEARCH` configuration.

## Configuration Updates

### Environment Variables

```bash
BRAVE_SEARCH_API_KEY=your_api_key
BRAVE_SEARCH_ENDPOINT=https://api.search.brave.com/res/v1/web/search
FORCE_BRAVE_SEARCH=false
```

## Testing

### Pre-merge Verification

- [x] Run unit tests: `npm test -- tests/unit/genaiClient.test.js`
- [x] Verify Google Search still works as primary provider.
- [x] Verify fallback to Brave Search when Google API is mocked to fail.
- [x] Verify `FORCE_BRAVE_SEARCH=true` bypasses Google Search.

---

**Review Checklist:**

- [x] Code quality meets project standards
- [x] All tests pass and coverage is maintained
- [x] Documentation is complete and accurate
- [x] Breaking change assessment completed
