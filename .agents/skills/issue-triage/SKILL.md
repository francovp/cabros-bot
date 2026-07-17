---
name: issue-triage
description: Classify and add ordered priority labels to eligible open GitHub issues for this bot. Use when asked to prioritize the trading-profit backlog, rank opportunities by ROI, apply ROI/QoL/performance/security/build-tool/developer-experience labels, or triage issues produced by trading-profit-opportunity-scout.
---

# Issue Triage

Apply one numbered `priority/*` label to each eligible open issue. This is a portfolio-ordering label, not an incident-severity label: leave the repository's existing `priority/p0` through `priority/p3` labels untouched.

## Label Contract

Create a missing label only when it is needed. Use exactly one label from this ordered set:

| Label | Use for |
| --- | --- |
| `priority/1-roi` | Directly measurable improvement to entries, exits, signal quality, false-positive reduction, risk control, or trading feedback loops. |
| `priority/2-qol` | Trader-facing usability or alert readability that does not directly alter a trading decision. |
| `priority/3-performance` | Latency, throughput, cost, or reliability work that materially improves timely alert delivery. |
| `priority/4-security` | Security hardening that protects the bot, credentials, or webhook integrity. |
| `priority/5-build-tools` | CI, build, deployment, dependency, or operational tooling. |
| `priority/6-developer-experience` | Tests, local workflow, documentation, or maintainability improvements. |
| `priority/7-other` | A concrete bot improvement that does not fit above. |

Choose the highest applicable category. Do not treat a speculative profit claim as ROI: `1-roi` requires a measurable trading hypothesis and validation path.

## Workflow

1. Read `.agents/skills/trading-profit-opportunity-scout/SKILL.md`; read its `references/trading-profit-framework.md` for trading candidates. Check the repository's open issues and PRs live before classifying.
2. Consider only open **issues**, never pull requests. Skip closed, duplicate, invalid, `wontfix`, and recently `agent-working` issues. Do not create, close, rewrite, or relabel unrelated issues.
3. Require concrete scope and evidence from the issue plus repository, issue, or PR context. For `1-roi`, require the scout's measurable hypothesis and a validation route (replay, paper/shadow mode, telemetry, or deterministic test). If evidence is insufficient, report it as unlabelled rather than guessing.
4. Ensure the seven labels exist, then add the selected one. First remove any other numbered `priority/*` label from that issue; preserve every other label, including `priority/p*`.
5. Re-read the issue labels and report: issue URL, chosen label, one-sentence evidence, skipped issues, and anything blocked by GitHub access.

Use the current repository unless the user explicitly supplies another one. Authenticate and identify it before writing:

```bash
gh auth status
repo_name="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
gh api --paginate "repos/$repo_name/issues?state=open&per_page=100" --jq '.[] | select(.pull_request | not) | {number,title,body,labels,url}'
gh api --paginate "repos/$repo_name/pulls?state=open&per_page=100" --jq '.[] | {number,title,body,labels,url}'
```

Create only missing labels; do not use `--force` because it can overwrite repository-managed label metadata:

```bash
ensure_label() {
  if ! gh api --silent "repos/$repo_name/labels/${1//\//%2F}" >/dev/null 2>&1; then
    gh label create "$1" --repo "$repo_name" --description "$2" --color "$3"
  fi
}
ensure_label "priority/1-roi" "Direct measurable trading outcome improvement" "b60205"
ensure_label "priority/2-qol" "Trader-facing quality-of-life improvement" "fbca04"
ensure_label "priority/3-performance" "Performance or timely delivery improvement" "1d76db"
ensure_label "priority/4-security" "Security hardening" "d93f0b"
ensure_label "priority/5-build-tools" "Build, CI, deploy, or operations tooling" "5319e7"
ensure_label "priority/6-developer-experience" "Developer workflow or maintainability improvement" "0e8a16"
ensure_label "priority/7-other" "Concrete bot improvement outside higher categories" "cfd3d7"
```

For each eligible issue, remove only the old label in this namespace, then add the selected label:

```bash
while IFS= read -r old_label; do
  [ -n "$old_label" ] || continue
  gh issue edit "$issue_number" --repo "$repo_name" --remove-label "$old_label"
done < <(gh issue view "$issue_number" --repo "$repo_name" --json labels --jq '.labels[].name' | rg '^priority/[1-7]-' || true)
gh issue edit "$issue_number" --repo "$repo_name" --add-label "$selected_label"
gh issue view "$issue_number" --repo "$repo_name" --json url,labels
```

## Guardrails

- Do not promise profit or label an issue `1-roi` merely because it mentions trading.
- Do not use this ordering to downgrade production-critical or security work; retain the existing `priority/p*` severity label when present.
- Stop without writes if GitHub auth is unavailable. Stop and ask if a requested label migration would alter labels outside the numbered `priority/*` set.
