# API Contracts

## Webhook Endpoints

### POST /api/webhook/alert

Receives an alert text and enriches it with grounded context from Gemini + Google Search.

#### Request

Content-Type: `text/plain` OR `application/json`

```yaml
# Plain text body
"Bitcoin breaks $50,000 mark"

# OR JSON body
{
  "text": "Bitcoin breaks $50,000 mark"
}
```

#### Response

Status: 200 OK

```json
{
  "success": true,
  "messageId": "string",  // Telegram message ID
  "enriched": true       // Whether grounding was applied
}
```

#### Error Responses

```json
// 400 Bad Request
{
  "error": "Invalid request body",
  "details": "Request body must be text/plain or JSON with text property"
}

// 408 Request Timeout
{
  "error": "Grounding timeout",
  "details": "External API calls exceeded timeout threshold"
}

// 500 Internal Server Error
{
  "error": "Grounding failed",
  "details": "Error details from external APIs or processing"
}
```

## Internal APIs

### Gemini API Integration

#### Ground Alert Text

```typescript
interface GroundAlertRequest {
  text: string;
  maxSources?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

interface GroundAlertResponse {
  summary: string;
  citations: SearchResult[];
  confidence?: number;
}
```

### Search API Integration

#### Derive Search Query

```typescript
interface DeriveQueryRequest {
  alertText: string;
  maxLength?: number;
}

interface DeriveQueryResponse {
  query: string;
  confidence: number;
}
```

#### Fetch Search Results

```typescript
interface SearchRequest {
  query: string;
  maxResults?: number;
}

interface SearchResponse {
  results: SearchResult[];
  totalResults: number;
}
```

## Data Schemas

```typescript
interface SearchResult {
  title: string;
  snippet: string;
  url: string;
  sourceDomain: string;
}

interface TelegramMessage {
  chatId: string;
  text: string;
  parseMode?: "MarkdownV2";
  disableWebPagePreview?: boolean;
}
```

## Environment Configuration

Required environment variables for feature enablement:

```bash
ENABLE_GEMINI_GROUNDING=true
GEMINI_API_KEY=string
SEARCH_API_KEY=string
```

Optional configuration:

```bash
SEARCH_CX=string                     # Search engine ID
GEMINI_SYSTEM_PROMPT=string         # Custom system prompt
GROUNDING_MAX_SOURCES=number        # Default: 3
GROUNDING_TIMEOUT_MS=number         # Default: 8000
```