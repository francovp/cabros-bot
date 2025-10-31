# Research: News Monitoring with Sentiment Analysis and Alert Distribution

**Feature**: `003-news-monitor` | **Date**: October 31, 2025  
**Purpose**: Resolve NEEDS CLARIFICATION items and document technology choices

---

## Research Topics

### 1. Azure AI Inference Integration for Secondary LLM Enrichment

**Decision**: Use `@azure-rest/ai-inference` REST client with `@azure/core-auth` for authentication and `@azure/core-sse` for streaming responses (if needed for future features)

**Rationale**:
- **REST client pattern** matches existing codebase (Express REST API)
- **Lightweight integration**: No heavy SDK dependencies, just REST + auth utilities
- **Flexible authentication**: Supports both API key (`AzureKeyCredential`) and Azure AD (`DefaultAzureCredential`)
- **Streaming capable**: `@azure/core-sse` provides Server-Sent Events for future real-time features
- **Consistent with Gemini pattern**: Both use simple HTTP client wrappers

**Implementation Pattern** (from Azure SDK docs):
```javascript
import ModelClient from "@azure-rest/ai-inference";
import { AzureKeyCredential } from "@azure/core-auth";

const model = process.env.AZURE_AI_MODEL | | "openai/gpt-5-mini";

const client = ModelClient(
  process.env.AZURE_AI_ENDPOINT,
  new AzureKeyCredential(process.env.AZURE_AI_API_KEY)
);

const response = await client.path("/chat/completions").post({
  body: {
    messages: [{ role: "user", content: "Analyze this alert..." }],
    temperature: 0.2,
    max_tokens: 256,
    model,
  },
});
```

**Alternatives Considered**:
- **Native fetch()**: Simpler but lacks retry logic, credential management, and telemetry
- **@azure/ai-language-text**: Too heavy for simple chat completions, designed for Azure Cognitive Services
- **Direct OpenAI SDK**: Not compatible with Azure AI Inference endpoint format

**Integration Points**:
- New service: `src/services/inference/azureAiClient.js` - Wraps ModelClient with retry logic
- New service: `src/services/inference/enrichmentService.js` - Orchestrates Gemini → LLM enrichment flow
- Reuse: `src/lib/retryHelper.js` - Apply `sendWithRetry()` to LLM calls (3 retries, ~10s timeout)

---

### 2. In-Memory Cache Strategy for Deduplication

**Decision**: Use JavaScript Map with custom TTL tracking and periodic cleanup

**Rationale**:
- **No external dependencies**: Simplest solution that meets requirements
- **TTL per entry**: Cache key is `(symbol, event_category)`, value includes `{ timestamp, alert, enrichment }`
- **Memory efficient**: Typical workload is 10-50 symbols × 3 event categories × 6hr TTL = <500 cache entries
- **Stateless**: No persistence required (cache rebuilds on restart, acceptable for this use case)

**Implementation Pattern**:
```javascript
class NewsCache {
  constructor(ttlHours = 6) {
    this.cache = new Map();
    this.ttlMs = ttlHours * 60 * 60 * 1000;
  }

  get(symbol, eventCategory) {
    const key = `${symbol}:${eventCategory}`;
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    const age = Date.now() - entry.timestamp;
    if (age > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(symbol, eventCategory, data) {
    const key = `${symbol}:${eventCategory}`;
    this.cache.set(key, { timestamp: Date.now(), data });
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }
}
```

**Alternatives Considered**:
- **node-cache library**: Adds external dependency for minimal value (built-in TTL not needed, we control eviction)
- **Redis**: Overkill for MVP, adds deployment complexity, not justified for <1000 entries
- **LRU cache**: Not required (TTL-based eviction is sufficient, memory usage is bounded by TTL × request rate)

**Integration Points**:
- New module: `src/controllers/webhooks/handlers/newsMonitor/cache.js`
- Lifecycle: Initialize on app startup, cleanup every 1 hour via setInterval

---

### 3. Gemini GoogleSearch Grounding for News Analysis

**Decision**: Reuse existing `src/services/grounding/gemini.js` with enhanced prompts for event detection

**Rationale**:
- **Already integrated**: Existing `generateGroundedSummary()` function uses GoogleSearch grounding
- **Structured prompts**: Modify prompt to request JSON response with `{ event_category, event_significance, sentiment_score, sources }`
- **Fallback parsing**: If Gemini returns free-form text, parse with regex/heuristics (spec allows graceful degradation)

**Enhanced Prompt Strategy**:
```javascript
const prompt = `
Analyze the following financial symbol for trading-relevant events. Return a JSON object.

Symbol: ${symbol}
Current Price: ${price} (24h change: ${change}%)

Required JSON format:
{
  "event_category": "price_surge" | "price_decline" | "public_figure" | "regulatory" | "none",
  "event_significance": 0.0-1.0 (price magnitude + source credibility + mention frequency),
  "sentiment_score": -1.0 to 1.0 (bearish to bullish),
  "sources": ["source1", "source2"],
  "summary": "Brief explanation"
}

Detect:
1. Price movements >5% with bullish/bearish sentiment
2. Mentions of public figures (Trump, Elon Musk, etc.)
3. Regulatory or official announcements

If no significant event, return event_category="none".
`;
```

**Alternatives Considered**:
- **Fine-tuned model**: Overkill for MVP, requires training data and maintenance
- **Rule-based parsing**: Too brittle, misses nuanced events (e.g., "Trump hints at crypto support")
- **Third-party news APIs**: Adds cost and dependency, Gemini GoogleSearch already provides news context

**Integration Points**:
- Update: `src/services/grounding/gemini.js` - Add `analyzeNewsForSymbol()` function
- Update: `src/services/grounding/config.js` - Add `NEWS_ANALYSIS_PROMPT` constant
- Validation: `src/lib/validation.js` - Add `validateNewsAnalysisResponse()` function

---

### 4. Confidence Scoring Formula

**Decision**: Weighted formula `confidence = (0.6 × event_significance + 0.4 × |sentiment|)` clamped to [0, 1]

**Rationale**:
- **Reproducible**: Explicit formula enables debugging and tuning
- **Weighted toward significance**: Event magnitude (price movement, source credibility) matters more than sentiment alone
- **Absolute sentiment**: Use `|sentiment|` so both strong bullish (+0.9) and bearish (-0.9) contribute equally
- **Threshold filtering**: Compare against `NEWS_ALERT_THRESHOLD` (default 0.7) before sending alerts

**Example Calculations**:
| Event | Significance | Sentiment | Confidence | Send Alert? |
|-------|--------------|-----------|------------|-------------|
| BTC +8% bullish news | 0.9 | +0.8 | 0.86 | ✅ (>0.7) |
| NVDA -3% neutral | 0.4 | 0.0 | 0.24 | ❌ (<0.7) |
| Trump mentions BTC | 0.85 | +0.6 | 0.75 | ✅ (>0.7) |
| Regulatory rumor | 0.6 | -0.5 | 0.56 | ❌ (<0.7) |

**Conservative Enrichment Selection** (when `ENABLE_LLM_ALERT_ENRICHMENT=true`):
```javascript
const finalConfidence = Math.min(geminiConfidence, llmConfidence);
```
- Prevents false positives from LLM hallucination
- If LLM lowers confidence, use lower score
- If LLM raises confidence, ignore (Gemini is authoritative)

**Alternatives Considered**:
- **Average of Gemini + LLM**: Too trusting of LLM, can inflate false positives
- **LLM only**: Loses Gemini grounding authority (GoogleSearch results)
- **Max confidence**: Opposite of conservative, increases false positives

**Integration Points**:
- New module: `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` - Implements formula
- New module: `src/controllers/webhooks/handlers/newsMonitor/enrichment.js` - Applies min() selection

---

### 5. Parallel Symbol Analysis with Timeout Budget

**Decision**: Use `Promise.allSettled()` with per-symbol timeout wrappers (30s total budget)

**Rationale**:
- **Non-blocking**: One slow symbol doesn't block others
- **Partial results**: Return analyzed + timeout results together (spec requirement)
- **Timeout hierarchy**:
  - Binance: ~5s (aggressive, fast fail)
  - Gemini: ~20s (generous, fallback from Binance)
  - Optional LLM enrichment: ~10s (independent, doesn't block alert delivery)
- **Promise.allSettled()**: Never rejects, returns `{status, value/reason}` for each promise

**Implementation Pattern**:
```javascript
async function analyzeSymbols(symbols) {
  const analysisPromises = symbols.map(symbol =>
    withTimeout(analyzeSymbol(symbol), 30000, symbol)
  );
  
  const results = await Promise.allSettled(analysisPromises);
  
  return results.map((result, i) => {
    if (result.status === 'fulfilled') {
      return { symbol: symbols[i], status: 'analyzed', ...result.value };
    } else {
      return { symbol: symbols[i], status: 'timeout', error: result.reason.message };
    }
  });
}

function withTimeout(promise, ms, symbol) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
    ),
  ]);
}
```

**Alternatives Considered**:
- **Promise.all()**: Rejects on first failure, blocks entire batch
- **Sequential processing**: Too slow (10 symbols × 30s = 5 minutes worst case)
- **p-limit concurrency**: Adds dependency, not needed (external APIs handle concurrency)

**Integration Points**:
- New module: `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` - Orchestrates parallel analysis
- Reuse: `src/lib/retryHelper.js` - Wrap external API calls with retry logic

---

### 6. Multi-Channel Alert Delivery (Reuse Existing Pattern)

**Decision**: Reuse `NotificationManager.sendToAll()` from 002-whatsapp-alerts feature

**Rationale**:
- **Already implemented**: Parallel delivery to Telegram + WhatsApp with fail-open pattern
- **Retry logic**: Each channel retries 3 times with exponential backoff
- **Graceful degradation**: One channel failure doesn't block the other or HTTP response
- **Formatting**: Existing MarkdownV2 (Telegram) and WhatsApp formatters handle escaping

**Integration Pattern**:
```javascript
const { notificationManager } = require('../../services/notification/NotificationManager');

const alert = {
  text: formatAlertMessage({ symbol, price, sentiment, sources, eventCategory }),
  enriched: enrichmentMetadata, // Optional, when ENABLE_LLM_ALERT_ENRICHMENT=true
};

const deliveryResults = await notificationManager.sendToAll(alert);
// Returns: [{ success: true, channel: 'telegram', messageId, ... }, ...]
```

**No Changes Required**: Existing implementation already supports:
- Per-channel retry with timeout
- MarkdownV2 and WhatsApp markdown formatting
- Partial success tracking (some channels succeed, others fail)

**Integration Points**:
- Reuse: `src/services/notification/NotificationManager.js`
- Reuse: `src/services/notification/formatters/markdownV2Formatter.js`
- Reuse: `src/services/notification/formatters/whatsappMarkdownFormatter.js`

---

### 7. Optional Binance Price Fetching (Reuse Existing Service)

**Decision**: Reuse `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js` with fallback to Gemini

**Rationale**:
- **Already integrated**: Existing function calls `MainClient.getAvgPrice({ symbol })`
- **Timeout handling**: Wrap with 5s timeout, fallback to Gemini on failure
- **Symbol classification**: Requester is responsible (spec clarification), system doesn't validate

**Implementation Pattern**:
```javascript
async function getMarketContext(symbol, isCrypto) {
  if (!isCrypto || !process.env.ENABLE_BINANCE_PRICE_CHECK) {
    return getGeminiPriceContext(symbol); // Always use Gemini for stocks
  }
  
  try {
    const { price } = await withTimeout(fetchPriceCryptoSymbol(symbol), 5000);
    return { price, source: 'binance' };
  } catch (error) {
    console.warn(`Binance fetch failed for ${symbol}, falling back to Gemini:`, error.message);
    return getGeminiPriceContext(symbol); // Fallback
  }
}
```

**Alternatives Considered**:
- **Parallel Binance + Gemini**: Wastes API quota, not needed (Binance is preferred when available)
- **Binance only**: Too brittle (API downtime blocks alerts)
- **Gemini only**: Less accurate for crypto (Binance has real-time order book data)

**Integration Points**:
- Reuse: `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js`
- New helper: `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` - Implements fallback logic

---

## Summary of Technology Choices

| Component | Technology | Justification |
|-----------|-----------|---------------|
| **Secondary LLM Enrichment** | `@azure-rest/ai-inference` + `@azure/core-auth` + `@azure/core-sse` | Lightweight REST client, flexible auth, streaming capable, matches Azure AI Inference endpoint format |
| **Primary News Analysis** | Existing `@google/genai` with GoogleSearch grounding | Already integrated, supports structured JSON responses, provides web search context |
| **Deduplication Cache** | JavaScript Map with custom TTL | No external dependencies, simple, memory-efficient for expected workload |
| **Parallel Processing** | `Promise.allSettled()` | Non-blocking, returns partial results, native Node.js (no library needed) |
| **Notification Delivery** | Existing `NotificationManager` (from 002-whatsapp-alerts) | Already supports Telegram + WhatsApp, retry logic, graceful degradation |
| **Crypto Price Fetching** | Existing `binance` client with Gemini fallback | Already integrated, accurate real-time prices, fallback ensures reliability |
| **Testing** | Jest + supertest | Existing test infrastructure, supports integration tests for HTTP endpoints |

---

## Open Questions (None Remaining)

All NEEDS CLARIFICATION items from Technical Context have been resolved:
- ✅ Azure AI Inference integration pattern documented
- ✅ Cache strategy defined (in-memory Map with TTL)
- ✅ Gemini prompt strategy for event detection specified
- ✅ Confidence scoring formula finalized
- ✅ Parallel processing approach selected
- ✅ Multi-channel notification strategy (reuse existing)
- ✅ Binance integration approach (reuse with fallback)

**Ready for Phase 1: Design & Contracts**
