# Local default prompt files

These files are the **version-controlled local fallbacks** used when Langfuse prompt management is disabled, unavailable, or missing a prompt.

## Naming

- `*.system.txt` → system message for chat prompts
- `*.user.txt` → user message for chat prompts
- `*.txt` → plain text prompt/query

## Variables

Templates support simple `{{variableName}}` placeholders.

Examples:

- `{{alertText}}`
- `{{symbol}}`
- `{{maxLength}}`
- `{{languageDirective}}`

Rendering is handled by `src/services/prompts/filePromptLoader.js`.
