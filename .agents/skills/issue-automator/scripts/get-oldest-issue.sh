#!/usr/bin/env bash
# get-oldest-issue.sh [EXCLUDE_NUMBERS]
# Uses the GitHub CLI (gh) to fetch the oldest open issue for the repository.
# Optional EXCLUDE_NUMBERS advances the cursor past those issue numbers
# (comma- or space-separated, e.g. "270,271" or "270 271"). Used by the
# Step 6 skip loop so already-skipped issues are never selected again.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

EXCLUDE="${1:-}"

# Ensure gh CLI is installed
if ! command -v gh &> /dev/null; then
  echo "Error: 'gh' CLI is not installed or not in PATH." >&2
  exit 127
fi

# Ensure jq CLI is installed (used to filter the candidate batch)
if ! command -v jq &> /dev/null; then
  echo "Error: 'jq' CLI is not installed or not in PATH." >&2
  exit 127
fi

# Normalize and validate the optional skip list (comma- or space-separated issue numbers)
SKIP_LIST=""
if [ -n "$EXCLUDE" ]; then
  SKIP_LIST=$(echo "$EXCLUDE" | tr ' ' ',' | sed 's/,,*/,/g; s/^,//; s/,$//')
  if [ -n "$SKIP_LIST" ]; then
    for n in $(echo "$SKIP_LIST" | tr ',' ' '); do
      if [[ ! "$n" =~ ^[0-9]+$ ]]; then
        echo "Error: EXCLUDE_NUMBERS must contain only positive integers, got '$n'." >&2
        exit 1
      fi
    done
  fi
fi

# Switch to francovp user for all gh commands; restore on exit
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

if ! gh auth status &> /dev/null; then
  echo "Error: 'gh' CLI is not authenticated as francovp. Please run 'gh auth login' or configure GITHUB_TOKEN." >&2
  exit 1
fi

# Walk open issues oldest-first with a creation-time cursor. A single GitHub
# search query is capped at 1000 results, so when the whole batch is excluded
# by the skip list the cursor advances to the newest createdAt seen and the
# query repeats (created:>=cursor) until a non-excluded issue is found, no
# more open issues exist, or MAX_PAGES bounds the walk (Hard Rule #6).
MAX_PAGES=10
page=0
cursor=""
while [ "$page" -lt "$MAX_PAGES" ]; do
  page=$((page + 1))

  if [ -n "$cursor" ]; then
    query="is:open is:issue sort:created-asc created:>=$cursor"
  else
    query="is:open is:issue sort:created-asc"
  fi

  batch=$(gh issue list --state open --search "$query" --limit 1000 --json number,title,createdAt,labels,url 2>/dev/null)

  if [ -z "$batch" ] || [ "$batch" == "[]" ]; then
    echo "No open issues found."
    exit 0
  fi

  cursor=$(echo "$batch" | jq -r 'map(.createdAt) | max')

  # Always exclude issues carrying `need manual PR deploy` or `brainstorming` —
  # operator has marked them as requiring human intervention or as
  # idea-stage without implementation intent. These are zero-work skips.
  batch=$(echo "$batch" | jq -c '
    map(select(
      (.labels | map(.name | ascii_downcase) | index("need manual pr deploy") | not)
      and (.labels | map(.name | ascii_downcase) | index("brainstorming") | not)
      and (.labels | map(.name | ascii_downcase) | index("brainstorm") | not)
    ))
  ')

  if [ -n "$SKIP_LIST" ]; then
    batch=$(echo "$batch" | jq -c "map(select(.number as \$n | [$SKIP_LIST] | index(\$n) | not))")
  fi

  if [ "$batch" != "[]" ]; then
    # Keep only the oldest remaining issue (single-element array, same contract as before)
    echo "$batch" | jq -c '.[0:1]'
    exit 0
  fi
done

echo "No open issues found."
exit 0
