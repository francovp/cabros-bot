#!/usr/bin/env bash
# get-oldest-issue.sh [EXCLUDE_NUMBER]
# Uses the GitHub CLI (gh) to fetch the oldest open issue for the repository.
# Optional EXCLUDE_NUMBER advances the cursor past that issue number (used by
# the Step 6 skip loop so a blocked issue is not selected again).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

EXCLUDE_NUMBER="${1:-}"

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

if [ -n "$EXCLUDE_NUMBER" ] && [[ ! "$EXCLUDE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: EXCLUDE_NUMBER must be a positive integer, got '$EXCLUDE_NUMBER'." >&2
  exit 1
fi

# Switch to francovp user for all gh commands; restore on exit
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

if ! gh auth status &> /dev/null; then
  echo "Error: 'gh' CLI is not authenticated as francovp. Please run 'gh auth login' or configure GITHUB_TOKEN." >&2
  exit 1
fi

# Fetch the oldest open issues (bounded batch so the cursor can advance past EXCLUDE_NUMBER)
issue_json=$(gh issue list --state open --search "is:open is:issue sort:created-asc" --limit 50 --json number,title,createdAt,labels,url 2>/dev/null)

if [ -z "$issue_json" ] || [ "$issue_json" == "[]" ]; then
  echo "No open issues found."
  exit 0
fi

if [ -n "$EXCLUDE_NUMBER" ]; then
  issue_json=$(echo "$issue_json" | jq -c "map(select(.number != $EXCLUDE_NUMBER))")
  if [ "$issue_json" == "[]" ]; then
    echo "No open issues found."
    exit 0
  fi
fi

# Keep only the oldest remaining issue (single-element array, same contract as before)
echo "$issue_json" | jq -c '.[0:1]'
