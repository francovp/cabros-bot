#!/usr/bin/env bash
# verify-preview.sh
# Verifies the Railway preview deployment for a given PR number, and optionally
# validates new endpoints exposed by the PR. Production is also verifiable.
#
# Railway PR environments: https://cabros-bot-cabros-bot-pr-<pr-number>.up.railway.app
#   e.g. PR 359 -> https://cabros-bot-cabros-bot-pr-359.up.railway.app
# Production (master):    https://cabros-bot-production.up.railway.app
#
# Usage:
#   ./verify-preview.sh <PR_NUMBER> [ENDPOINTS_CSV]
#   ./verify-preview.sh production [ENDPOINTS_CSV]
#   ./verify-preview.sh 359 "/healthcheck,/openapi.json,/api/status"
#
# Render is no longer used — see legacy fallback at bottom of file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <PR_NUMBER|production> [ENDPOINTS_CSV]" >&2
  exit 1
fi

PR_NUMBER="$1"
EXTRA_ENDPOINTS="${2:-}"

# Switch to francovp user for gh commands; restore on exit
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

# Resolve preview/production URL on Railway
if [ "$PR_NUMBER" = "production" ] || [ "$PR_NUMBER" = "prod" ] || [ "$PR_NUMBER" = "master" ]; then
  PREVIEW_URL="https://cabros-bot-production.up.railway.app"
  LABEL="production"
else
  # Validate PR number is numeric when not production
  if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer or 'production', got '$PR_NUMBER'." >&2
    exit 1
  fi
  PREVIEW_URL="https://cabros-bot-cabros-bot-pr-${PR_NUMBER}.up.railway.app"
  LABEL="PR #${PR_NUMBER}"
fi

HEALTHCHECK_URL="${PREVIEW_URL}/healthcheck"

echo "Verifying Railway deployment for ${LABEL}..."
echo "Target URL: ${HEALTHCHECK_URL}"
echo "Base URL: ${PREVIEW_URL}"

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
  echo "Success: Railway deployment ${LABEL} is live and healthy (${PREVIEW_URL})."
  exit 0
else
  echo "Error: One or more endpoint verifications failed for ${PREVIEW_URL}." >&2
  # Legacy Render fallback note — keep for operator context but do not verify
  echo "Note: Render previews are disabled. Use Railway URLs only." >&2
  exit 1
fi
