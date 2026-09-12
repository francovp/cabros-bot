#!/usr/bin/env bash
# verify-preview.sh
# Verifies the deployment for a given PR number, and optionally validates new
# endpoints exposed by the PR. Production is also verifiable.
#
# PR deployment URL is resolved via the GitHub Deployments API using the
# companion script get-pr-deployment-url.sh, which returns the environment_url
# of the latest success/active deployment and falls back to the Railway pattern
# when no GitHub deployment is found:
#   https://cabros-bot-cabros-bot-pr-<pr-number>.up.railway.app
#
# Production (master):    https://cabros-bot-production.up.railway.app
#
# Usage:
#   ./verify-preview.sh <PR_NUMBER> [ENDPOINTS_CSV] [EXPECTED_SHA]
#   ./verify-preview.sh production [ENDPOINTS_CSV]
#   ./verify-preview.sh 359 "/healthcheck,/openapi.json,/api/status"
#   ./verify-preview.sh 359 "/healthcheck,/openapi.json" "abc1234..."
#
# EXPECTED_SHA (optional):
#   When provided, the script fetches the SHA of the latest GitHub deployment
#   for the PR and compares it to EXPECTED_SHA. A mismatch triggers a stale-
#   deploy warning and exits non-zero, which routes issue-automator to Step 6.5.
#   Obtain the PR head SHA with: gh pr view <N> --json headRefOid --jq .headRefOid
#
# Render is no longer used — Railway and platform-agnostic GitHub Deployments
# API are the supported paths.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <PR_NUMBER|production> [ENDPOINTS_CSV] [EXPECTED_SHA]" >&2
  exit 1
fi

PR_NUMBER="$1"
EXTRA_ENDPOINTS="${2:-}"
EXPECTED_SHA="${3:-}"

# Switch to francovp user for gh commands; restore on exit
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

# Resolve preview/production URL using the GitHub Deployments API helper
# (falls back to Railway pattern when no GitHub deployment is found)
if [ "$PR_NUMBER" = "production" ] || [ "$PR_NUMBER" = "prod" ] || [ "$PR_NUMBER" = "master" ]; then
  PREVIEW_URL="${PRODUCTION_URL:-https://cabros-bot-production.up.railway.app}"
  LABEL="production"
  EXPECTED_SHA=""  # SHA check not applicable to production
else
  # Validate PR number is numeric when not production
  if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer or 'production', got '$PR_NUMBER'." >&2
    exit 1
  fi
  PREVIEW_URL="$("${SCRIPT_DIR}/get-pr-deployment-url.sh" "$PR_NUMBER")"
  LABEL="PR #${PR_NUMBER}"
fi

HEALTHCHECK_URL="${PREVIEW_URL}/healthcheck"

echo "Verifying deployment for ${LABEL}..."
echo "Target URL: ${HEALTHCHECK_URL}"
echo "Base URL: ${PREVIEW_URL}"

# --- Optional SHA staleness check ---
# If EXPECTED_SHA is provided, compare against the latest GitHub deployment SHA.
# A mismatch means the deployed revision is not the PR head — trigger stale warning.
if [ -n "$EXPECTED_SHA" ] && [ "$PR_NUMBER" != "production" ] && [ "$PR_NUMBER" != "prod" ] && [ "$PR_NUMBER" != "master" ]; then
  REPO="${REPO:-francovp/cabros-bot}"
  PR_BRANCH="$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName --jq .headRefName 2>/dev/null || true)"
  DEPLOYED_SHA=""

  # Try environment-name-based lookup first, then ref-based
  ENV_NAME="cabros-bot-pr-${PR_NUMBER}"
  for QUERY_PARAM in "environment=${ENV_NAME}" "${PR_BRANCH:+ref=${PR_BRANCH}}"; do
    [ -z "$QUERY_PARAM" ] && continue
    DEPLOYED_SHA="$(gh api "repos/${REPO}/deployments?${QUERY_PARAM}&per_page=1" \
      --jq '.[0].sha // empty' 2>/dev/null || true)"
    [ -n "$DEPLOYED_SHA" ] && break
  done

  if [ -n "$DEPLOYED_SHA" ]; then
    # Compare prefix (full SHA vs short SHA both accepted)
    if [[ "$DEPLOYED_SHA" != "${EXPECTED_SHA}"* ]] && [[ "${EXPECTED_SHA}" != "${DEPLOYED_SHA}"* ]]; then
      echo "Error: Stale deploy detected for PR #${PR_NUMBER}." >&2
      echo "  Expected SHA : ${EXPECTED_SHA}" >&2
      echo "  Deployed SHA : ${DEPLOYED_SHA}" >&2
      echo "  The Railway preview is not serving the PR head commit. Trigger Step 6.5 recovery." >&2
      exit 2  # exit 2 = stale deploy (distinct from general endpoint failure exit 1)
    else
      echo "SHA match: deployed ${DEPLOYED_SHA:0:10} matches expected ${EXPECTED_SHA:0:10}."
    fi
  else
    echo "Warning: Could not fetch deployed SHA for PR #${PR_NUMBER} — skipping staleness check." >&2
  fi
fi

# Endpoints to verify: always /healthcheck, plus any comma-separated extras
# Default extra endpoints cover the contract and status probes — they are
# unauthenticated and should return 200 even without API keys.
DEFAULT_EXTRA="/openapi.json"
if [ -n "$EXTRA_ENDPOINTS" ]; then
  ENDPOINTS="/healthcheck,${EXTRA_ENDPOINTS}"
else
  ENDPOINTS="/healthcheck,${DEFAULT_EXTRA}"
fi

# Normalize: remove duplicate slashes, ensure leading /
normalize_endpoint() {
  local ep="$1"
  # trim whitespace
  ep="$(echo "$ep" | xargs)"
  if [ -z "$ep" ]; then echo ""; return; fi
  if [[ "$ep" != /* ]]; then ep="/$ep"; fi
  echo "$ep"
}

MAX_ATTEMPTS=3
DELAY_SECONDS=5

verify_endpoint() {
  local endpoint="$1"
  local url="${PREVIEW_URL}${endpoint}"
  local attempt=1 success=0
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    echo "  Checking ${url} — attempt ${attempt}/${MAX_ATTEMPTS}..."
    set +e
    response=$(curl -s -w "\n%{http_code}" --connect-timeout 10 --max-time 15 "$url")
    curl_exit_code=$?
    set -e
    if [ "$curl_exit_code" -ne 0 ]; then
      echo "    Warning: curl failed with exit code $curl_exit_code." >&2
    else
      body=$(echo "$response" | sed '$d')
      status_code=$(echo "$response" | tail -n1)
      echo "    HTTP ${status_code} — body: $(echo "$body" | head -c 300)"
      if [ "$status_code" -eq 200 ] || [ "$status_code" -eq 401 ] || [ "$status_code" -eq 403 ]; then
        # 401/403 means the service is up but endpoint is auth-gated — counts as live
        # 200 is ideal for unauthenticated endpoints like /healthcheck and /openapi.json
        if [[ "$endpoint" == "/healthcheck" ]] && [ "$status_code" -ne 200 ]; then
          echo "    Healthcheck must be 200, got ${status_code} — retrying..." >&2
        else
          success=1
          break
        fi
      fi
    fi
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "    Waiting ${DELAY_SECONDS}s before next attempt..."
      sleep "$DELAY_SECONDS"
    fi
    attempt=$((attempt + 1))
  done
  if [ "$success" -eq 1 ]; then return 0; else return 1; fi
}

# Verify each endpoint sequentially
IFS=',' read -ra EPS <<< "$ENDPOINTS"
FAILED=0
for raw in "${EPS[@]}"; do
  ep="$(normalize_endpoint "$raw")"
  [ -z "$ep" ] && continue
  if ! verify_endpoint "$ep"; then
    echo "Error: Failed to verify ${PREVIEW_URL}${ep} after ${MAX_ATTEMPTS} attempts." >&2
    FAILED=1
  else
    echo "Success: ${ep} is reachable."
  fi
done

if [ "$FAILED" -eq 0 ]; then
  echo "Success: Deployment ${LABEL} is live and healthy (${PREVIEW_URL})."
  exit 0
else
  echo "Error: One or more endpoint verifications failed for ${PREVIEW_URL}." >&2
  exit 1
fi
