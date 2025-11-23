# Implementation Plan: Enrich Alert Output

**Branch**: `004-enrich-alert-output` | **Date**: 22 de noviembre de 2025 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-enrich-alert-output/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Enrich webhook alerts with sentiment analysis, key insights, technical levels, and verified sources using Gemini Grounding. The system will use a structured JSON prompt to extract this data and format it for Telegram and WhatsApp.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: Node.js 20.x
**Primary Dependencies**: Express, Telegraf, GreenAPI, Google Generative AI (Gemini)
**Storage**: N/A (Stateless processing)
**Testing**: Jest (Unit & Integration)
**Target Platform**: Render (Node.js)
**Project Type**: Web application + Bot
**Performance Goals**: < 2s latency increase for enrichment
**Constraints**: Free tier Gemini limits, WhatsApp message length
**Scale/Scope**: Low volume, high value alerts

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Code Quality**: Will use clear variable names and modular functions.
- **Simplicity**: Reusing existing Grounding Service pattern.
- **Testing**: Will add unit tests for the new prompt and formatters.
- **Review**: PR will reference this spec.
- **Incremental**: Feature is gated by `ENABLE_GEMINI_GROUNDING`.

## Project Structure

### Documentation (this feature)

```text
specs/004-enrich-alert-output/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
src/
├── controllers/
│   └── webhooks/
│       └── handlers/
│           └── alert/
│               └── alert.js       # Update to use new enrichment logic
├── services/
│   ├── grounding/
│   │   ├── gemini.js              # Add generateEnrichedAlert with new prompt
│   │   └── grounding.js           # Export enrichAlert
│   └── notification/
│       └── formatters/
│           ├── markdownV2Formatter.js      # Update for Telegram
│           └── whatsappMarkdownFormatter.js # Update for WhatsApp
tests/
├── integration/
│   └── alert-grounding.test.js    # Update integration tests
└── unit/
    ├── gemini-client.test.js      # Test new prompt logic
    └── news-alert-formatting.test.js # Test new formatting
```

**Structure Decision**: Modifying existing service and controller layers to support structured enrichment.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| N/A | | |
