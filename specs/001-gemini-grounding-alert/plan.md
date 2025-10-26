# Implementation Plan: Gemini Grounding Alert Feature

**Branch**: `001-gemini-grounding-alert` | **Date**: 2025-10-26 | **Spec**: `/specs/001-gemini-grounding-alert/spec.md`
**Input**: Feature specification from `/specs/001-gemini-grounding-alert/spec.md`

## Summary

Add enriched context to webhook alerts using Gemini AI with Google Search grounding. When an alert is received, the system will use Google Search to find relevant sources and use Gemini to generate a contextual summary with citations. The enriched content will be appended to the original alert text in Telegram messages, providing users with verified context and sources.

## Technical Context

**Language/Version**: Node.js 20.x (from package.json engines)
**Primary Dependencies**:

  - @google/genai (a.k.a. `genai`) - Gemini API client and googleSearch groundingTool Tools (use latest `@google/genai` package implementation)
  - express - Web server framework
  - telegraf - Telegram Bot framework
**Storage**: N/A (stateless webhooks)
**Testing**: Jest (unit/integration testing)
**Target Platform**: Linux server (existing bot infrastructure)
**Project Type**: Single - Node.js webhook service
**Constraints**:

  - External API timeout: 8000ms (configurable via `GROUNDING_TIMEOUT_MS`)
  - Maximum 3 search results per alert (configurable via `GROUNDING_MAX_SOURCES`)
  - Message size limits for Telegram
  - Grounding implementation MUST use the googleSearch groundingTool Tools; do NOT implement a separate/custom web search client or `searchapi` client as part of this feature. If an alternate provider is required later, implement a thin adapter behind a provider-agnostic interface as a follow-up task.
**Scale/Scope**: 
  - Single webhook endpoint enhancement
  - Integration with 2 external APIs (Gemini, Google Search)
  - Environment-based configuration

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Code Quality & Readability
✅ Plan enforces clear interfaces and documentation
✅ Implementation organized into focused modules
✅ Error handling and fallbacks clearly defined

### Simplicity & Minimalism
✅ Direct implementation approach using official packages
✅ No premature abstractions introduced
✅ Configuration follows existing patterns

### Testing Policy
✅ Critical paths identified for testing
✅ Integration tests planned for API interactions
✅ Unit tests outlined for core logic

### Review & Quality Gates
✅ API contracts defined and documented
✅ Error scenarios and fallbacks specified
✅ Validation rules established

### Incremental Delivery
✅ Feature can be enabled/disabled via configuration
✅ Changes confined to webhook handler
✅ Backward compatible with existing alert format

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── controllers/
│   ├── commands.js
│   ├── helpers.js
│   └── webhooks/
│       └── handlers/
│           └── alert/
│               ├── alert.js           # Existing webhook handler
│               ├── grounding.js       # Grounding integration entry (orchestration)
│               └── types.ts           # Type definitions for alert enrichment
├── services/
│   └── grounding/
│       ├── genaiClient.js            # Thin wrapper around @google/genai (googleSearch + LLM helpers)
│       ├── gemini.js                 # Prompt composition and LLM post-processing (uses genaiClient)
│       ├── grounding.js              # Orchestrator: derive query, collect evidence, enforce timeout
│       └── types.ts                  # Shared types for grounding
└── lib/
  └── validation.js                 # Input validation helpers

tests/
├── integration/
│   └── alert-grounding.test.js      # Integration tests for enrichment
└── unit/
  ├── alert-handler.test.js        # Unit tests for alert processing
  └── gemini-client.test.js        # Unit tests for Gemini integration
```

### Module responsibilities

- `genaiClient.js`: Initialize and export a minimal, well-documented wrapper around `@google/genai` with two convenience functions: `search(query, opts)` (calls genai.googleSearch and returns normalized SearchResult[]), and `llmCall(prompt, context, opts)` (calls the LLM with provided prompt and context). Keep this file thin and free of business logic.
- `grounding.js`: Orchestrator that (1) derives a search query (via a configurable prompt), (2) uses `genaiClient.search` to collect evidence (respecting `GROUNDING_MAX_SOURCES`), (3) calls `gemini.js`/`genaiClient.llmCall` to obtain summaries, and (4) enforces `GROUNDING_TIMEOUT_MS` with a clear fallback path.
- `gemini.js`: Business-facing utilities for prompt composition and response normalization (maps LLM output into `GeminiResponse` with `summary`, `citations`).

These responsibilities should be kept minimal to satisfy the Constitution's Simplicity & Minimalism principle.

**Structure Decision**: The feature will be implemented within the existing single-project structure, adding new modules under `src/services/grounding/` for the Gemini and Search integrations, and extending the existing alert handler with grounding capabilities. This maintains the current project organization while cleanly separating the new functionality.

## Complexity Tracking

No constitution violations identified. The implementation follows the project's principles:

- Maintains simple webhook processing flow
- Uses official libraries without unnecessary abstractions
- Follows existing configuration patterns
- Implements focused, testable modules
- Provides clear error handling and fallbacks
