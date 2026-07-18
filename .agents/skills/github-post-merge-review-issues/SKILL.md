---
name: github-post-merge-review-issues
description: Find unresolved inline review discussions on the latest merged GitHub pull requests and convert only concrete, still-relevant, non-duplicate findings into new GitHub issues. Use when auditing recently merged PRs for review debt, post-merge follow-up, or backlog items left by unresolved PR discussions. Defaults to the current repository and the latest 10 merged PRs, unless the user supplies a repository, PR range, count, or date window.
---

# Post-Merge Review Issues

Turn review debt left on merged PRs into a small, evidence-backed GitHub backlog. Use `gh` and GitHub GraphQL; `reviewThreads` is the source of truth for unresolved inline discussions.

## Workflow

1. Resolve scope before reading deeply.

   - Use the current repository unless the user supplies another one:

     ```bash
     gh auth status
     repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
     default_branch="$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name)"
     ```

   - Stop without writes if authentication or repository discovery fails.
   - Default to the 10 most recently merged PRs into `default_branch`. Accept explicit PR numbers, a count, or a date window when provided.
   - Get enough merged PRs before sorting; do not trust the CLI's default ordering. Keep only PRs with `mergedAt` set and `baseRefName == default_branch`, then sort descending by `mergedAt`.

     ```bash
     gh pr list --repo "$repo" --state merged --limit 100 \
       --json number,title,mergedAt,url,baseRefName,headRefName \
       | jq --arg branch "$default_branch" --argjson limit 10 \
         'map(select(.mergedAt != null and .baseRefName == $branch)) | sort_by(.mergedAt) | reverse | .[:$limit]'
     ```

   - In `francovp/cabros-bot`, obey the repository auth convention: save the current `gh` account, switch to `francovp` before repository commands, and restore the original account afterward.

2. Fetch review threads, not just flat PR comments.

   For every selected PR, query GraphQL and paginate both connections when `hasNextPage` is true:

   ```bash
   gh api graphql -f query='
   query($owner:String!, $name:String!, $number:Int!, $cursor:String) {
     repository(owner:$owner, name:$name) {
       pullRequest(number:$number) {
         number title url mergedAt baseRefName
         reviewThreads(first:100, after:$cursor) {
           pageInfo { hasNextPage endCursor }
           nodes {
             id isResolved isOutdated path line originalLine
             comments(first:100) {
               pageInfo { hasNextPage endCursor }
               nodes { url body createdAt updatedAt author { login } }
             }
           }
         }
       }
     }
   }' -F owner="$owner" -F name="$name" -F number="$number"
   ```

   Consider only `isResolved == false`. Treat outdated threads as candidates only if the concern still applies to the merged code; an outdated marker alone is not evidence to file an issue. Do not use `gh pr view --comments` as the sole source because it loses thread resolution and inline context.

3. Validate each candidate against the merged code.

   - Read the relevant file and current `default_branch` code. Inspect the PR diff or commits when needed to understand the original context.
   - Keep only actionable concerns: a concrete bug, security gap, data-loss risk, reliability problem, missing test/contract, or clearly scoped maintainability defect.
   - Skip approvals, questions, praise, style nits, speculative ideas, comments already fixed by the merge, and concerns that cannot be reproduced or tied to current code.
   - Preserve a short, faithful summary of the discussion. Link the PR and the exact comment/thread URL; do not invent impact or quote more than necessary.

4. Deduplicate before creating anything.

   - Search all open and recently closed issues using the candidate's distinctive terms, affected component, PR number, and behavior. Inspect plausible matches, not only titles:

     ```bash
     gh issue list --repo "$repo" --state all --limit 100 --search "<distinctive terms>"
     ```

   - Also check linked issues and later merged PRs. If an existing issue covers the same root problem, skip creation and report the existing issue. Do not split one bug class into several issues merely because multiple threads mention it.

5. Create one issue per distinct root problem.

   Use a concise action-oriented title and this body shape:

   ```markdown
   ## Summary

   <One sentence describing the concrete post-merge problem.>

   ## Evidence

   - Merged PR: <PR URL>
   - Review discussion: <thread/comment URL>
   - Location: `<path>:<line>`
   - Current code evidence: <what remains true on the merged branch>

   ## Impact

   <Observable failure, risk, or operator/developer cost. State uncertainty explicitly.>

   ## Proposed follow-up

   <Smallest useful implementation direction, without prescribing unrelated refactors.>

   ## Acceptance criteria

   - <Behavior or invariant that must be true>
   - <Regression test, monitoring, or contract check that proves it>
   ```

   Create only after the candidate and duplicate checks are complete:

   ```bash
   issue_url="$(gh issue create --repo "$repo" --title "$title" --body-file "$body_file")"
   gh issue view "$issue_url" --repo "$repo" --json number,title,url,labels
   ```

   Use existing labels only when their meaning is clear and relevant; do not create a new label namespace as part of this audit. Leave PR threads unresolved unless the user explicitly asks to resolve or reply to them.

6. Report a closed-loop result.

   For each selected PR, report the unresolved threads inspected, candidates skipped with the reason, duplicate issue matches, created issue URLs, and any auth/API blocker. If no thread survives validation, report `NO_ACTIONABLE_FINDINGS` rather than manufacturing an issue.

## Guardrails

- Never file an issue from an unresolved flag alone; prove the concern still exists after merge.
- Never create duplicate issues. Prefer an existing issue and include its URL in the result.
- Never inspect or modify unrelated repositories, PRs, or issues outside the requested scope.
- Never edit source code, merge PRs, reply to reviews, resolve threads, or change labels unless the user separately requests it.
- Re-check the live issue list immediately before each issue creation because another agent may have filed the same finding.
- If GitHub auth, rate limits, or GraphQL access blocks reliable evidence, stop and report the blocker; do not guess.
