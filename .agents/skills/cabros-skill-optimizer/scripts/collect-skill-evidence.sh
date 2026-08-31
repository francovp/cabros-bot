#!/usr/bin/env bash
set -uo pipefail

skills_dir=".agents/skills"
pr_limit=15
repo=""

usage() {
  cat <<'EOF'
Usage: collect-skill-evidence.sh [--skills-dir PATH] [--pr-limit 1-30] [--repo OWNER/NAME]

Emit a compact, read-only Markdown evidence report for repository skill updates.
The GitHub review scan is skipped when gh authentication or repository discovery is unavailable.
EOF
}

while (($#)); do
  case "$1" in
    --skills-dir)
      skills_dir="${2:?missing value for --skills-dir}"
      shift 2
      ;;
    --pr-limit)
      pr_limit="${2:?missing value for --pr-limit}"
      shift 2
      ;;
    --repo)
      repo="${2:?missing value for --repo}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$pr_limit" =~ ^[1-9][0-9]*$ ]] || ((pr_limit > 30)); then
  printf '%s\n' '--pr-limit must be an integer from 1 to 30.' >&2
  exit 2
fi

printf '%s\n' '# Skill evidence (read-only)'
printf '%s\n' '- Remote writes: none.'
printf -- '- Working tree: '
if [[ -z "$(git status --porcelain 2>/dev/null)" ]]; then
  printf '%s\n' 'clean'
else
  printf '%s\n' 'has local changes; preserve them'
fi

printf '\n%s\n' '## Skills'
if [[ -d "$skills_dir" ]]; then
  skill_count=0
  while IFS= read -r -d '' skill_file; do
    skill_count=$((skill_count + 1))
    printf -- '- `%s`: %s lines\n' "${skill_file#./}" "$(wc -l < "$skill_file" | tr -d ' ')"
  done < <(find "$skills_dir" -mindepth 2 -maxdepth 2 -type f -name SKILL.md -print0)
  printf -- '- Total skills: %s\n' "$skill_count"
  printf '%s\n' '- Recent skill commits:'
  git log --oneline -8 -- "$skills_dir" 2>/dev/null | sed 's/^/  - /' || true
else
  printf -- '- Missing skills directory: `%s`\n' "$skills_dir"
fi

printf '\n%s\n' '## CLI availability'
for command in gh linear render jq; do
  if command -v "$command" >/dev/null 2>&1; then
    printf -- '- `%s`: available\n' "$command"
  else
    printf -- '- `%s`: unavailable\n' "$command"
  fi
done

if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
  printf '\n%s\n' '## GitHub evidence'
  printf '%s\n' '- `INTEGRATION_BLOCKED`: GitHub CLI authentication unavailable; skipped PR and review scans.'
  exit 0
fi
if ! command -v jq >/dev/null 2>&1; then
  printf '\n%s\n' '## GitHub evidence'
  printf '%s\n' '- `INTEGRATION_BLOCKED`: jq is unavailable; skipped structured PR and review scans.'
  exit 0
fi

if [[ -z "$repo" ]]; then
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
fi
if [[ -z "$repo" || "$repo" != */* ]]; then
  printf '\n%s\n' '## GitHub evidence'
  printf '%s\n' '- `INTEGRATION_BLOCKED`: repository discovery failed; skipped PR and review scans.'
  exit 0
fi

owner="${repo%%/*}"
name="${repo#*/}"
pr_json="$(gh pr list --repo "$repo" --state all --limit "$pr_limit" \
  --json number,title,state,mergedAt,closedAt,url 2>/dev/null || true)"
if [[ -z "$pr_json" || "$pr_json" == '[]' ]]; then
  printf '\n%s\n' '## GitHub evidence'
  printf -- '- Repository: `%s`\n- No recent PRs returned.\n' "$repo"
  exit 0
fi

printf '\n%s\n' '## GitHub evidence'
printf -- '- Repository: `%s`\n' "$repo"

query='query($owner:String!, $name:String!, $number:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      reviewThreads(first:100) { nodes { isResolved } }
      comments(first:100) { nodes { author { login } body } }
      reviews(first:100) { nodes { author { login } body } }
    }
  }
}'

scanned=0
unresolved_total=0
quota_total=0
open_quota_total=0
duplicates=0
open_duplicates=0
while IFS=$'\t' read -r number state title; do
  [[ -n "$number" ]] || continue
  scanned=$((scanned + 1))
  response="$(gh api graphql -f owner="$owner" -f name="$name" -F number="$number" -f query="$query" 2>/dev/null || true)"
  if [[ -z "$response" ]]; then
    printf -- '- PR #%s: review scan unavailable\n' "$number"
    continue
  fi
  unresolved="$(jq '[.data.repository.pullRequest.reviewThreads.nodes[]? | select(.isResolved == false)] | length' <<<"$response" 2>/dev/null || printf '0')"
  quota="$(jq '[.data.repository.pullRequest | (.comments.nodes[]?, .reviews.nodes[]?) | select(.author.login == "chatgpt-codex-connector") | select(.body | startswith("You have reached your Codex usage limits for code reviews"))] | length' <<<"$response" 2>/dev/null || printf '0')"
  duplicate="$(jq '[.data.repository.pullRequest.comments.nodes[]? | select(.body | test("[Cc]losing duplicate PR in favor of PR #[0-9]+"))] | length' <<<"$response" 2>/dev/null || printf '0')"
  unresolved_total=$((unresolved_total + unresolved))
  quota_total=$((quota_total + quota))
  duplicates=$((duplicates + duplicate))
  if [[ "$state" == 'OPEN' ]]; then
    open_quota_total=$((open_quota_total + quota))
    open_duplicates=$((open_duplicates + duplicate))
  fi
  if ((unresolved > 0 || quota > 0 || duplicate > 0)); then
    printf -- '- PR #%s (%s): unresolved=%s, codex-quota-comments=%s, duplicate-close-comments=%s\n' \
      "$number" "$state" "$unresolved" "$quota" "$duplicate"
  fi
done < <(jq -r '.[] | [.number, .state, .title] | @tsv' <<<"$pr_json")

printf -- '- Review summary: scanned=%s, unresolved-inline=%s, codex-quota-comments=%s (open=%s), duplicate-close-comments=%s (open=%s)\n' \
  "$scanned" "$unresolved_total" "$quota_total" "$open_quota_total" "$duplicates" "$open_duplicates"
if ((open_quota_total > 0)); then
  printf '%s\n' '- Action: use a bounded self-review fallback; do not wait for Codex quota recovery.'
fi
if ((open_duplicates > 0)); then
  printf '%s\n' '- Action: strengthen early PR/Linear dedupe before implementation work.'
fi
