---
name: agent-cross-review
description: Cross-review pull requests created by other AI coding agents (Codex, GitHub Copilot, OpenCode, Claude, Antigravity) against Cabros Bot architectural, security, and contract standards. Use when asked to review recently opened PRs from other agents, conduct comparative agent reviews, or audit PRs before merging.
---

# Agent Cross-Review

Review pull requests authored by other AI coding agents (or human contributors) with deep architectural scrutiny tailored to Cabros Bot.

When you are acting as one agent (e.g., **Antigravity**), use this skill to inspect, validate, and provide structured feedback on pull requests opened by other agents (such as **Codex**, **GitHub Copilot**, **OpenCode**, or **Claude**).

---

## Workflow

### 1. Discover Target PRs

Discover active pull requests authored by other agents using the detection script:

```bash
# Auto-detect PRs from other agents (excluding current agent, e.g. antigravity)
.agents/skills/agent-cross-review/scripts/detect-agent-prs.sh --exclude-self antigravity --limit 5

# Or filter for a specific authoring agent
.agents/skills/agent-cross-review/scripts/detect-agent-prs.sh --agent codex
.agents/skills/agent-cross-review/scripts/detect-agent-prs.sh --agent github-copilot
```

If a specific PR number is provided (e.g. `PR #894`), target that PR directly:

```bash
.agents/skills/agent-cross-review/scripts/detect-agent-prs.sh --pr 894
```

### 2. Inspect PR Context and Diff

Fetch PR metadata and inspect the full changeset:

```bash
# View PR summary and description
gh pr view "$PR_NUM" --json number,title,body,headRefName,author,url

# Inspect the diff
gh pr diff "$PR_NUM"
```

Read the linked GitHub issues, Linear tickets (e.g. `CB-xxx`), or user stories mentioned in the PR description to understand the intended behavior.

### 3. Evaluate Against Cabros Bot Rubric

Review the diff systematically against [cabros-bot-review-rubric.md](references/cabros-bot-review-rubric.md):

1. **Async & Fail-Open Safety**:
   - Do external calls (Sentry, Firestore, Twelve Data, TradingView MCP, Telegram, WhatsApp) use native `fetch` with bounded `AbortController` timeouts?
   - Are errors caught and handled gracefully so core alert delivery never crashes?
   - Are retries bounded and do they respect `Retry-After` floating-point headers without integer truncation?

2. **Telegram & Notification Formatting**:
   - Are Telegram messages in `parse_mode: 'MarkdownV2'` safely escaped with `MarkdownV2Formatter.js`?
   - Are all notification channels fail-open if a destination is down?

3. **Firestore & Persistence Safety**:
   - Are all objects sanitized before Firestore write calls (`docRef.set`, `transaction.set`, etc.) to prevent `undefined` serialization crashes?
   - Are TTLs and idempotency locks bounded?

4. **Security & Authentication**:
   - Does API key validation use `crypto.timingSafeEqual`?
   - In production (`NODE_ENV=production`, Render, Railway), does missing `WEBHOOK_API_KEY` fail closed with HTTP 503?
   - Are secrets, credentials, or API tokens strictly protected from logs, URL query strings, and output?

5. **Contract & Configuration Parity**:
   - Is `.env.example` updated for new application-owned environment variables?
   - Are non-secret runtime variables added to `RemoteConfigService.js` and `firebase-remote-config-template.json`?
   - Are new routes and payloads registered in `src/openapi/openapi.json` and `CabrosBot.postman_collection.json`?

6. **Test Quality & Coverage**:
   - Are new or modified behaviors tested in `tests/unit/` or `tests/integration/`?
   - Do bug fixes include regression tests proving the bug is resolved?

### 4. Run Preflight Verification

Execute relevant local test suites to verify that the changes pass cleanly:

```bash
# Run focused tests related to the PR
pnpm test -- tests/unit/<related-test>.test.js

# Or verify the full test suite
pnpm test
```

### 5. Format Structured Review

Assemble the review using this standard structure:

```markdown
# 🤖 Cross-Agent PR Review: PR #[NUMBER] - [TITLE]

**Reviewer Agent**: [Your Name/Model, e.g. Antigravity]
**Author Agent**: [Detected Agent, e.g. GitHub Copilot, Codex, OpenCode]
**Branch**: `[HEAD_BRANCH]`
**Verdict**: [APPROVE | REQUEST_CHANGES | COMMENT]

---

### Executive Summary
[1-2 sentences summarizing the core change and review outcome]

### 🛑 Critical Findings (Blockers)
- **[File & Line]**: [Specific flaw, e.g. unescaped MarkdownV2 character causing Telegram failure]
  - *Impact*: [Potential production crash / contract break]
  - *Suggested Fix*: [Code snippet or concrete adjustment]

### ⚠️ Warnings & Reliability Risks
- **[File & Line]**: [Risk, e.g. missing AbortController timeout on external fetch]
  - *Suggested Fix*: [Adjustment]

### 💡 Improvements & Non-Blocking Suggestions
- **[File & Line]**: [Suggestion, e.g. code simplification, helper reuse]

### 📋 Contract & Parity Checks
- [ ] Fail-open async resilience
- [ ] Telegram MarkdownV2 escaping
- [ ] Firestore undefined sanitization
- [ ] Timing-safe auth & fail-closed production check
- [ ] `.env.example` & Remote Config parity
- [ ] OpenAPI 3.1 & Postman collection sync
- [ ] Unit & Integration test coverage

### 🎯 Recommendation
[Final recommendation for merging or next steps]
```

### 6. Present Findings & Optional GitHub Posting

1. Present the complete formatted review to the user.
2. If the user explicitly asks to post the review or the skill was invoked with `--post`, confirm with the user before publishing:
   ```bash
   # For approval:
   gh pr review "$PR_NUM" --approve --body "$REVIEW_BODY"
   
   # For change requests:
   gh pr review "$PR_NUM" --request-changes --body "$REVIEW_BODY"
   
   # For general comments:
   gh pr review "$PR_NUM" --comment --body "$REVIEW_BODY"
   ```

---

## Guardrails

- **Read-only by default**: Never post comments, request changes, or approve PRs on GitHub without explicit user confirmation.
- **Credential safety**: Follow `gh-auth-utils.sh` conventions (`francovp` user) and never output API keys or tokens.
- **Evidence-backed**: Every critical finding or warning must cite the exact file, line number, and rule from the rubric.
- **Constructive & Actionable**: Always provide concrete code suggestions or test assertions for every flagged issue.
