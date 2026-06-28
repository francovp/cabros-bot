feat(ai): implement OpenAI SDK via Cloudflare AI Gateway (CB-46)

## Summary
Add the `openai` npm package and create a reusable `CloudflareAiClient` wrapper that uses the OpenAI SDK with a configurable `baseURL` pointed at Cloudflare AI Gateway. Integrate it as a new `MODEL_PROVIDER=cloudflare` option in the existing LLM routing infrastructure and resolve Codex feedback regarding configuration validation and fallback model reporting.

## Key Changes
- **`package.json`**: Added `openai@^4.0.0` dependency
- **`src/services/inference/cloudflareAiClient.js`**: OpenAI SDK wrapper with `CF_AIG_TOKEN`, `CF_AIG_BASE_URL`, and `CF_AIG_MODEL` env vars. Provides `chatCompletion()`, `validate()`, `parseJsonResponse()`, and `healthCheck()`.
- **`src/services/grounding/config.js`**: Removed default account-scoped `CF_AIG_BASE_URL` to fail validation early if not explicitly configured by deployment.
- **`src/services/grounding/genaiClient.js`**: Added `MODEL_PROVIDER=cloudflare` case in `llmCallv2()` that delegates to `CloudflareAiClient`.
- **`src/controllers/status.js`**: Added `cloudflareAig` dependency status in `/api/status` and `cloudflare` provider case in `getNewsMonitorLlmDependency()`, correctly supporting default model configuration fallback `DEFAULT_CF_AIG_MODEL`.
- **`tests/unit/cloudflare-client.test.js`**: Created unit tests covering validation, chat completion, JSON parsing, and health checks.
- **`tests/integration/status-endpoint.test.js`**: Added integration test coverage for the Cloudflare provider status.

## Technical Implementation
- The `CloudflareAiClient` wraps the official OpenAI SDK with a custom `baseURL` targeting Cloudflare AI Gateway.
- Uses the established singleton + factory pattern matching existing Azure/OpenRouter clients.
- Handles empty/undefined `CF_AIG_BASE_URL` by failing validation instead of silent default pass.
- Status endpoint checks incorporate the default configuration fallback for `CF_AIG_MODEL`.

## Testing
- Unit tests added in `tests/unit/cloudflare-client.test.js` passing.
- Status endpoint integration tests added in `tests/integration/status-endpoint.test.js` passing.
- Full test suite verified green (781 tests).

## References
- **Linear**: [CB-46](https://linear.app/knil/issue/CB-46/implementar-openai-sdk-usando-cloudflare-ai-gateway)
- GitHub Issue: #137
