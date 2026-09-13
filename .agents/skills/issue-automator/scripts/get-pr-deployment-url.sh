#!/usr/bin/env bash
# get-pr-deployment-url.sh
# Resolves the active deployment URL for a PR from the GitHub Deployments API.
# Returns the environment_url of the latest deployment with state=success or state=active.
# Falls back to the Railway URL pattern if no GitHub deployment is found.
#
# Usage:
#   ./get-pr-deployment-url.sh <PR_NUMBER>
#   ./get-pr-deployment-url.sh production   → https://cabros-bot-production.up.railway.app
#
# Output:
#   Prints the resolved URL to stdout.
#   Exits 0 on success (URL printed), 1 on hard failure (no fallback available).
#
# Environment:
#   REPO            — GitHub repository slug (default: francovp/cabros-bot)
#   PRODUCTION_URL  — Override the production URL (default: https://cabros-bot-production.up.railway.app)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <PR_NUMBER|production>" >&2
  exit 1
fi

PR_NUMBER="$1"
REPO="${REPO:-francovp/cabros-bot}"
PRODUCTION_URL="${PRODUCTION_URL:-https://cabros-bot-production.up.railway.app}"
RAILWAY_FALLBACK_URL="https://cabros-bot-cabros-bot-pr-${PR_NUMBER}.up.railway.app"

# Switch to francovp user for gh commands; restore on exit
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

# Handle production/master aliases — always use the fixed production URL
if [ "$PR_NUMBER" = "production" ] || [ "$PR_NUMBER" = "prod" ] || [ "$PR_NUMBER" = "master" ]; then
  echo "$PRODUCTION_URL"
  exit 0
fi

# Validate PR number is numeric
if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: PR_NUMBER must be a positive integer or 'production', got '$PR_NUMBER'." >&2
  exit 1
fi

# Fetch the PR branch ref so we can search deployments by ref
PR_BRANCH="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null || true)"

# --- Probe GitHub Deployments API ---
# Strategy:
#  1. Try environment name matching the canonical pattern "cabros-bot-pr-<N>"
#  2. If no match and we have a branch name, try filtering by ref
#  3. On any match, return the environment_url of the newest success/active status
#  4. Fall back to Railway URL pattern with a warning

resolve_from_environment() {
  local env_name="$1"
  # Get deployment IDs for this environment (newest first)
  local deploy_ids
  deploy_ids="$(gh api "repos/${REPO}/deployments?environment=${env_name}&per_page=5" \
    --jq '.[].id' 2>/dev/null || true)"

  if [ -z "$deploy_ids" ]; then
    return 1
  fi

  # Iterate deployments newest-first until we find a success/active status with a URL
  while IFS= read -r dep_id; do
    [ -z "$dep_id" ] && continue
    local status_info
    status_info="$(gh api "repos/${REPO}/deployments/${dep_id}/statuses?per_page=1" \
      --jq '.[0] | {state: .state, url: .environment_url}' 2>/dev/null || true)"

    if [ -z "$status_info" ]; then
      continue
    fi

    local state url
    state="$(echo "$status_info" | jq -r '.state // empty')"
    url="$(echo "$status_info" | jq -r '.url // empty')"

    if { [ "$state" = "success" ] || [ "$state" = "active" ]; } && [ -n "$url" ]; then
      echo "$url"
      return 0
    fi
  done <<< "$deploy_ids"

  return 1
}

resolve_from_ref() {
  local branch="$1"
  # Deployments filtered by ref (branch name)
  local deploy_ids
  deploy_ids="$(gh api "repos/${REPO}/deployments?ref=${branch}&per_page=5" \
    --jq '.[].id' 2>/dev/null || true)"

  if [ -z "$deploy_ids" ]; then
    return 1
  fi

  while IFS= read -r dep_id; do
    [ -z "$dep_id" ] && continue
    local status_info
    status_info="$(gh api "repos/${REPO}/deployments/${dep_id}/statuses?per_page=1" \
      --jq '.[0] | {state: .state, url: .environment_url}' 2>/dev/null || true)"

    if [ -z "$status_info" ]; then
      continue
    fi

    local state url
    state="$(echo "$status_info" | jq -r '.state // empty')"
    url="$(echo "$status_info" | jq -r '.url // empty')"

    if { [ "$state" = "success" ] || [ "$state" = "active" ]; } && [ -n "$url" ]; then
      echo "$url"
      return 0
    fi
  done <<< "$deploy_ids"

  return 1
}

# 1. Try canonical environment name
ENV_NAME="cabros-bot-pr-${PR_NUMBER}"
RESOLVED_URL=""

if RESOLVED_URL="$(resolve_from_environment "$ENV_NAME" 2>/dev/null)"; then
  echo "$RESOLVED_URL"
  exit 0
fi

# 2. Try by branch ref if we have it
if [ -n "$PR_BRANCH" ]; then
  if RESOLVED_URL="$(resolve_from_ref "$PR_BRANCH" 2>/dev/null)"; then
    echo "$RESOLVED_URL"
    exit 0
  fi
fi

# 3. Fallback to Railway URL pattern with a warning
echo "Warning: No active GitHub deployment found for PR #${PR_NUMBER} (env=${ENV_NAME}${PR_BRANCH:+, ref=${PR_BRANCH}}). Falling back to Railway URL." >&2
echo "$RAILWAY_FALLBACK_URL"
exit 0
