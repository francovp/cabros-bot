---
name: langfuse-prompt-sync
description: Use when adding, updating, or modifying LLM prompt templates in the codebase (`src/services/prompts/`, `src/services/prompts/defaults/*.txt`, `src/services/prompts/promptRegistry.js`) to synchronize and publish new versions or labels to Langfuse.
---

# Langfuse Prompt Sync

Synchronize codebase-managed prompt templates with Langfuse to keep remote prompt management and local file-backed fallbacks in lockstep.

## When to Use This Skill

Activate this skill whenever:
- A new prompt is added to `src/services/prompts/promptRegistry.js` or `src/services/prompts/defaults/`.
- An existing prompt template (`*.system.txt`, `*.user.txt`, or `*.txt`) under `src/services/prompts/defaults/` is modified.
- Langfuse prompt versions need labels updated (e.g. `latest`, `production`).
- Auditing parity between local fallback templates and remote Langfuse prompts.

## Managed Prompt Files

Local prompts are stored under `src/services/prompts/defaults/`:
- **Chat Prompts**: `<name>.system.txt` and `<name>.user.txt` (e.g., `alert-enrichment`, `grounded-summary`, `news-analysis`, `search-query-derivation`, `confidence-enrichment`).
- **Text Prompts**: `<name>.txt` (e.g., `market-price-fetch`, `news-analysis-search-query`).

Registered prompt keys and definitions are configured in `src/services/prompts/promptRegistry.js`.

---

## Authentication & Configuration

The CLI needs `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` (and optional `LANGFUSE_HOST` / `LANGFUSE_BASE_URL`).
The tool resolves credentials in order:
1. `--env <path>` argument (e.g. `--env ~/.config/langfuse-cli/.env`)
2. `~/.config/langfuse-cli/.env`
3. `.env` in the repository root
4. Ambient process environment variables (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`)

> [!IMPORTANT]
> Never log or print Langfuse secret keys in command outputs, commit messages, or pull requests.

---

## Synchronization Workflow

### Method 1: Automated Sync Script (Recommended)

Run the included sync utility:

```bash
# Preview changes and payload diffs without pushing to Langfuse
node .agents/skills/langfuse-prompt-sync/scripts/sync-prompts.js --dry-run

# Sync all prompts from src/services/prompts/defaults/
node .agents/skills/langfuse-prompt-sync/scripts/sync-prompts.js --env ~/.config/langfuse-cli/.env

# Sync a specific prompt with a custom commit message
node .agents/skills/langfuse-prompt-sync/scripts/sync-prompts.js \
  --prompt alert-enrichment \
  --message "Add risk metadata instructions" \
  --labels "production,latest"
```

---

### Method 2: Direct Langfuse CLI Commands

You can also use `langfuse-cli` directly via `npx langfuse`:

#### 1. Inspect existing remote prompt
```bash
npx langfuse --env ~/.config/langfuse-cli/.env api prompts get <prompt-name> --label latest
```

#### 2. Create a new prompt version

**For Chat Prompts:**
```bash
npx langfuse --env ~/.config/langfuse-cli/.env api prompts create --body-json '{
  "name": "alert-enrichment",
  "type": "chat",
  "prompt": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "labels": ["production", "latest"],
  "commitMessage": "Update system guidance and examples"
}'
```

**For Text Prompts:**
```bash
npx langfuse --env ~/.config/langfuse-cli/.env api prompts create --body-json '{
  "name": "news-analysis-search-query",
  "type": "text",
  "prompt": "{{symbol}} news market sentiment events today",
  "labels": ["production", "latest"],
  "commitMessage": "Refine query terms"
}'
```

---

## Required Verification

After updating prompts in Langfuse and the codebase:

1. **Verify Remote Prompt Retrieval**:
   ```bash
   npx langfuse --env ~/.config/langfuse-cli/.env api prompts get <prompt-name> --label latest
   ```
2. **Run Prompt Unit Tests**:
   ```bash
   pnpm test -- tests/unit/prompt-service.test.js
   ```
3. **Run Feature Integration Tests**:
   ```bash
   pnpm test -- tests/integration/alert-grounding.test.js
   ```
