# Gemini Grounding Alert Feature - Quickstart Guide

## Overview
This feature adds context-enriched alerts to the Telegram bot by using Gemini AI and Google Search grounding to provide verified sources and summaries for alert messages.

## Prerequisites

1. Google Cloud Platform (GCP) Account with:
   - Gemini API enabled
   - Search API enabled
   - (Optional) Programmable Search Engine configured

2. API Keys and Credentials:
   - GEMINI_API_KEY
   - SEARCH_API_KEY
   - SEARCH_CX (optional)

## Configuration

Add these environment variables to enable and configure the feature:

```bash
# Required for enabling the feature
ENABLE_GEMINI_GROUNDING=true
GEMINI_API_KEY=your_gemini_api_key
SEARCH_API_KEY=your_search_api_key

# Optional configuration
SEARCH_CX=your_search_engine_id           # Optional: Custom Search Engine ID
GEMINI_SYSTEM_PROMPT=your_custom_prompt   # Optional: Custom system prompt
GROUNDING_MAX_SOURCES=3                   # Optional: Default is 3
GROUNDING_TIMEOUT_MS=8000                 # Optional: Default is 8000ms
```

## Usage

### Basic Alert Webhook

Send a POST request to `/api/webhook/alert` with either:

```bash
# Plain text body
curl -X POST http://your-bot-url/api/webhook/alert \
  -H "Content-Type: text/plain" \
  -d "Your alert text here"

# Or JSON body
curl -X POST http://your-bot-url/api/webhook/alert \
  -H "Content-Type: application/json" \
  -d '{"text": "Your alert text here"}'
```

### Response Format

The bot will send a Telegram message containing:

1. Original alert text
2. AI-generated summary with context
3. List of verified sources with URLs

Example:
```
🚨 Original Alert:
Bitcoin breaks $50,000 mark

📝 Context:
Bitcoin has surpassed $50,000 for the first time since Dec 2023, driven by increased institutional adoption and ETF approvals.

🔍 Sources:
• Bloomberg: "Bitcoin Surges Past $50,000" - https://bloom.bg/example
• CoinDesk: "Market Analysis" - https://coindesk.com/example
```

## Troubleshooting

### Common Issues

1. Feature not working:
   - Check `ENABLE_GEMINI_GROUNDING` is set to "true"
   - Verify API keys are valid and properly set
   - Check logs for API errors

2. Timeout errors:
   - Increase `GROUNDING_TIMEOUT_MS` if needed
   - Check network connectivity
   - Monitor API quotas

3. No sources in output:
   - Verify Search API key permissions
   - Check `GROUNDING_MAX_SOURCES` setting
   - Review search query derivation logs

### Monitoring

Monitor the feature using:

- Console logs (includes structured error info)
- Admin notifications (if enabled)
- API response times and success rates

## Development

### Adding New Features

1. Extend the grounding pipeline:
   - Add new handlers in `src/controllers/webhooks/handlers/alert/`
   - Update interface types in `types/`
   - Add tests for new functionality

2. Customizing prompts:
   - Update system prompts via environment variables
   - Modify search query derivation logic
   - Adjust source filtering rules

### Running Tests

```bash
# Run all tests
npm test

# Run specific test suite
npm test -- --grep "Alert Grounding"
```