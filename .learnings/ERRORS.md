# Errors

Command failures and integration errors.

---
## [ERR-20260523-001] oh-my-openagent-install

**Logged**: 2026-05-23T20:05:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
oh-my-openagent install failed because bunx is not installed in the workspace environment.

### Error
`/bin/bash: line 1: bunx: command not found`

### Context
- Command attempted: `bunx oh-my-openagent install --no-tui --claude=no --openai=yes --gemini=no --copilot=no --opencode-go=no --opencode-zen=no --zai-coding-plan=no --kimi-for-coding=no --vercel-ai-gateway=no`
- Environment: /home/ubuntu/.openclaw/workspace

### Suggested Fix
Install Bun first, then rerun the installer.

### Metadata
- Reproducible: yes
- Related Files: .learnings/ERRORS.md
- Tags: bun, bunx, installation

---
