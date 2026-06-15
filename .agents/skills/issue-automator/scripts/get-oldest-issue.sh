#!/usr/bin/env bash
# get-oldest-issue.sh
# Uses the GitHub CLI (gh) to fetch the oldest open issue for the repository.

set -euo pipefail

# Ensure gh CLI is installed
if ! command -v gh &> /dev/null; then
  echo "Error: 'gh' CLI is not installed or not in PATH." >&2
  exit 127
fi

# Ensure gh CLI is authenticated
if ! gh auth status &> /dev/null; then
  echo "Error: 'gh' CLI is not authenticated. Please run 'gh auth login' or configure GITHUB_TOKEN." >&2
  exit 1
fi

# Fetch the oldest open issue
issue_json=$(gh issue list --state open --sort created --direction asc --limit 1 --json number,title,createdAt,labels,url 2>/dev/null)

if [ -z "$issue_json" ] || [ "$issue_json" == "[]" ]; then
  echo "No open issues found."
  exit 0
fi

echo "$issue_json"
