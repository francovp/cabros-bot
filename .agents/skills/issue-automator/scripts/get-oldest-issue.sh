#!/usr/bin/env bash
# get-oldest-issue.sh
# Uses the GitHub CLI (gh) to fetch the oldest open issue for the repository.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

# Ensure gh CLI is installed
if ! command -v gh &> /dev/null; then
  echo "Error: 'gh' CLI is not installed or not in PATH." >&2
  exit 127
fi

# Switch to francovp user for all gh commands; restore on exit
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

if ! gh auth status &> /dev/null; then
  echo "Error: 'gh' CLI is not authenticated as francovp. Please run 'gh auth login' or configure GITHUB_TOKEN." >&2
  exit 1
fi

# Fetch the oldest open issue
issue_json=$(gh issue list --state open --search "is:open is:issue sort:created-asc" --limit 1 --json number,title,createdAt,labels,url 2>/dev/null)

if [ -z "$issue_json" ] || [ "$issue_json" == "[]" ]; then
  echo "No open issues found."
  exit 0
fi

echo "$issue_json"
