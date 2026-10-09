#!/usr/bin/env bash
# get-pr-deployment-url.sh
# Resolves the active deployment URL for a PR from the GitHub Deployments API.
# Returns the environment_url of the newest deployment whose latest status is
# state=success or state=active.
# Falls back to the Railway URL pattern if no GitHub deployment is found.
#
# Usage:
#   ./get-pr-deployment-url.sh <PR_NUMBER>
#   ./get-pr-deployment-url.sh production   → https://cabros-crypto-bot-telegram.onrender.com
#   ./get-pr-deployment-url.sh <PR_NUMBER> --details
#
# Output:
#   Default  — the resolved URL on stdout (single line). Unchanged contract.
#   --details — a single-line JSON object so a caller can bind the URL to the
#               deployment record that actually produced it:
#                 {"url":…,"sha":…,"state":…,"deployment_id":…,"source":…}
#               `source` is production | github-deployment | railway-fallback.
#               `sha` is the commit of the SAME deployment whose status supplied
#               `url`, and `state` is that status. Both are empty when no GitHub
#               deployment was selected (production / Railway fallback).
#
#               Deployments are walked newest-first and a still-`pending`
#               deployment is skipped in favour of the previous successful one.
#               Reporting that older deployment's `sha` alongside its `url` is
#               what lets callers verify the commit they are about to probe
#               instead of the commit of a deployment they skipped.
#
# Exit codes:
#   0  URL resolved (including the Railway fallback)
#   1  hard failure (bad PR number)
#   64 unknown flag
#
# Environment:
#   REPO            — GitHub repository slug (default: francovp/cabros-bot)
#   PRODUCTION_URL  — Override the production URL (default: https://cabros-crypto-bot-telegram.onrender.com)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

usage() {
  echo "Usage: $0 <PR_NUMBER|production> [--details]" >&2
}

DETAILS=false
PR_NUMBER=""
for arg in "$@"; do
  case "$arg" in
    --details) DETAILS=true ;;
    -h|--help) usage; exit 0 ;;
    -*) usage; echo "Error: unknown option '$arg'." >&2; exit 64 ;;
    *)
      if [ -z "$PR_NUMBER" ]; then
        PR_NUMBER="$arg"
      else
        usage
        echo "Error: unexpected extra argument '$arg'." >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "$PR_NUMBER" ]; then
  usage
  exit 1
fi

REPO="${REPO:-francovp/cabros-bot}"
PRODUCTION_URL="${PRODUCTION_URL:-https://cabros-crypto-bot-telegram.onrender.com}"
RAILWAY_FALLBACK_URL="https://cabros-bot-cabros-bot-pr-${PR_NUMBER}.up.railway.app"

# Switch to francovp user for gh commands; restore on exit
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

# Renders the resolved selection in the mode the caller asked for.
emit_selection() {
  local url="$1" sha="$2" state="$3" deployment_id="$4" source="$5"
  # Normalize: remove trailing slashes to prevent //endpoint concatenation issues
  url="${url%%/}"
  if [ "$DETAILS" = true ]; then
    jq -cn --arg url "$url" --arg sha "$sha" --arg state "$state" \
      --arg deployment_id "$deployment_id" --arg source "$source" \
      '{url:$url, sha:$sha, state:$state, deployment_id:$deployment_id, source:$source}'
  else
    echo "$url"
  fi
}

# Handle production/master aliases — always use the fixed production URL
if [ "$PR_NUMBER" = "production" ] || [ "$PR_NUMBER" = "prod" ] || [ "$PR_NUMBER" = "master" ]; then
  emit_selection "$PRODUCTION_URL" "" "" "" "production"
  exit 0
fi

# Validate PR number is numeric
if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: PR_NUMBER must be a positive integer or 'production', got '$PR_NUMBER'." >&2
  exit 1
fi

# Fetch the PR branch ref so we can search deployments by ref
PR_BRANCH="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null || true)"

# Walks the deployments at the "$1" deployments endpoint newest-first and returns
# the first one whose latest status is success/active and carries an
# environment_url.
#
# On stdout: <deployment_id>\t<sha>\t<state>\t<url> — the deployment id and sha
# come from the deployment record, the state and url from that same
# deployment's newest status, so the two can never describe different builds.
resolve_from_query() {
  local endpoint="$1"
  local rows dep_id dep_sha status_info state url

  # One call for both id and sha: the deployment list carries the commit.
  rows="$(gh api "${endpoint}&per_page=5" \
    --jq '.[] | "\(.id)\t\(.sha // "")"' 2>/dev/null || true)"
  [ -z "$rows" ] && return 1

  while IFS=$'\t' read -r dep_id dep_sha; do
    [ -z "$dep_id" ] && continue

    status_info="$(gh api "repos/${REPO}/deployments/${dep_id}/statuses?per_page=1" \
      --jq '.[0] | {state: .state, url: .environment_url}' 2>/dev/null || true)"
    [ -z "$status_info" ] && continue

    state="$(echo "$status_info" | jq -r '.state // empty')"
    url="$(echo "$status_info" | jq -r '.url // empty')"

    if { [ "$state" = "success" ] || [ "$state" = "active" ]; } && [ -n "$url" ]; then
      if [ -z "$dep_sha" ]; then
        # The list payload omitted the commit; read it off the deployment record.
        dep_sha="$(gh api "repos/${REPO}/deployments/${dep_id}" --jq '.sha // empty' 2>/dev/null || true)"
      fi
      printf '%s\t%s\t%s\t%s\n' "$dep_id" "$dep_sha" "$state" "$url"
      return 0
    fi
  done <<< "$rows"

  return 1
}

# The two named probes of the resolver contract (environment name first, branch
# ref second). Both delegate to one walker so the deployment id, sha, state and
# url can never come from different records.
resolve_from_environment() { resolve_from_query "repos/${REPO}/deployments?environment=${1}"; }
resolve_from_ref() { resolve_from_query "repos/${REPO}/deployments?ref=${1}"; }

# 1. Try canonical environment name
ENV_NAME="cabros-bot-pr-${PR_NUMBER}"
BOUND=""
if BOUND="$(resolve_from_environment "$ENV_NAME")" && [ -n "$BOUND" ]; then
  emit_selection \
    "$(printf '%s' "$BOUND" | cut -f4-)" \
    "$(printf '%s' "$BOUND" | cut -f2)" \
    "$(printf '%s' "$BOUND" | cut -f3)" \
    "$(printf '%s' "$BOUND" | cut -f1)" \
    "github-deployment"
  exit 0
fi

# 2. Try by branch ref if we have one
if [ -n "$PR_BRANCH" ]; then
  BOUND="$(resolve_from_ref "$PR_BRANCH" || true)"
  if [ -n "$BOUND" ]; then
    emit_selection \
      "$(printf '%s' "$BOUND" | cut -f4-)" \
      "$(printf '%s' "$BOUND" | cut -f2)" \
      "$(printf '%s' "$BOUND" | cut -f3)" \
      "$(printf '%s' "$BOUND" | cut -f1)" \
      "github-deployment"
    exit 0
  fi
fi

# 3. Fallback to Railway URL pattern with a warning
echo "Warning: No active GitHub deployment found for PR #${PR_NUMBER} (env=${ENV_NAME}${PR_BRANCH:+, ref=${PR_BRANCH}}). Falling back to Railway URL." >&2
emit_selection "$RAILWAY_FALLBACK_URL" "" "" "" "railway-fallback"
