# Improvement Catalog

Read only the section that matches the evidence being acted on.

## Evidence Threshold

Add a rule or helper only when a recent PR, review, session, command failure, or current repository artifact shows the problem. Record the artifact identifier, exact symptom, replacement, and bounded verification. Do not encode a dated deployment state as a permanent fact.

## GitHub and Codex Review

- Fetch `reviewThreads` with GraphQL and paginate when needed; flat comments cannot establish unresolved inline review debt.
- A general Codex quota message is a failed automation, not review feedback. Perform one diff-based self-review for correctness, security, tests, contracts, and acceptance criteria, then continue the normal gate.
- Before making implementation changes, inspect the issue, all related open/closed/merged PRs, branch state, and Linear ID. A merged equivalent means tracker cleanup, not a new branch or PR.
- Use one compact `gh --json` request per decision. Avoid repeated `gh pr view` calls that retrieve the same large body.

## CLI and Auth

| Integration | Safe pattern | Degradation |
| --- | --- | --- |
| GitHub | Confirm `gh auth status`; preserve the `francovp` write-account helper and restore it. | Keep local analysis/tests; mark GitHub writes blocked. |
| Linear | Check the configured CLI only before tracker work; send Markdown through `--description-file`. | Keep GitHub/code work; report Linear sync blocked. |
| Render | Inspect live service/key state; mutate one env-var key and explicitly create a deploy. | Keep code/preview work; report production propagation unverified. |
| Protected API | Require the key before parsing; feed `x-api-key` by stdin via `curl -H @-`; disable redirects. | Return a named `AUTH_BLOCKED`/`SKIPPED` outcome without leaking the key. |
| Sentry/observability | Treat denied or absent metrics as unavailable evidence. | Report `No measurements found`; do not infer a regression. |

## Verification and Waiting

- Limit repeated CI/preview/review checks to three cycles unless a new commit or external state change gives a concrete reason to retry.
- Treat Render `x-render-routing: no-server` as transient only if bounded retries end in a direct `/healthcheck` 200.
- When a full Jest run fails but the focused file passes, preserve both results and label it a suite-order candidate, not a confirmed regression.
- Separate preview validation, merged CI, and production rollout. They prove different things.

## Token Budget

- Start from a compact fact table: target, source artifact, decision, and next action.
- Use scripts for reusable JSON extraction or auth-sensitive request construction.
- Do not include long command output in PR/issue comments. Include a short conclusion and link or cite the relevant immutable artifact.
- Avoid polling discussions, CI, or Render merely to fill time. Wait only when a bounded readiness gate requires it.
