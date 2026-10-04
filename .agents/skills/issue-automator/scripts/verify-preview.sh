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
#   When provided, the script checks that the deployment backing the probed URL
#   is the PR head commit, and that the URL actually serves it:
#     1. Bound-record check — EXPECTED_SHA is compared against the sha of the
#        *selected* deployment (the one whose status supplied the URL), not
#        against the newest deployment record.
#     2. Served-build check — the commit the running service reports at
#        /api/status (`service.commit`) is compared against EXPECTED_SHA.
#   Either mismatch exits 2, which routes issue-automator to Step 6.5. The second
#   check is skipped with a warning when it cannot be proven (no WEBHOOK_API_KEY,
#   auth-gated status endpoint, or a status payload without service.commit).
#   Obtain the PR head SHA with: gh pr view <N> --json headRefOid --jq .headRefOid
#
# Exit codes:
#   0  endpoints healthy (and EXPECTED_SHA satisfied when provided)
#   1  one or more endpoint checks failed
#   2  stale deploy (EXPECTED_SHA mismatch) → Step 6.5 recovery
#
# Retry tuning (optional):
#   VERIFY_PREVIEW_MAX_ATTEMPTS            — endpoint attempts (default: 3)
#   VERIFY_PREVIEW_RETRY_DELAY_SECONDS     — pause between attempts (default: 5)
#
# Credentialed-probe host allowlist (optional):
#   VERIFY_PREVIEW_ALLOWED_HOSTS — comma-separated hostnames that may receive
#   WEBHOOK_API_KEY. Each entry is an exact hostname or a `*.suffix` wildcard.
#   Defaults to DEFAULT_ALLOWED_HOSTS below; set it to extend (or replace) the
#   list when a preview runs on another host, without editing this script.
#
# Railway and GitHub Deployments are the supported preview-status sources.

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
  DEPLOYMENT_SHA=""
  DEPLOYMENT_STATE=""
  DEPLOYMENT_ID=""
  DEPLOYMENT_SOURCE="production"
else
  # Validate PR number is numeric when not production
  if [[ ! "$PR_NUMBER" =~ ^[0-9]+$ ]]; then
    echo "Error: PR_NUMBER must be a positive integer or 'production', got '$PR_NUMBER'." >&2
    exit 1
  fi
  # --details returns the URL together with the identity of the deployment that
  # produced it, so the SHA compared below always describes the URL we probe.
  DEPLOYMENT_DETAILS="$("${SCRIPT_DIR}/get-pr-deployment-url.sh" "$PR_NUMBER" --details)"
  PREVIEW_URL="$(echo "$DEPLOYMENT_DETAILS" | jq -r '.url // empty')"
  DEPLOYMENT_SHA="$(echo "$DEPLOYMENT_DETAILS" | jq -r '.sha // empty')"
  DEPLOYMENT_STATE="$(echo "$DEPLOYMENT_DETAILS" | jq -r '.state // empty')"
  DEPLOYMENT_ID="$(echo "$DEPLOYMENT_DETAILS" | jq -r '.deployment_id // empty')"
  DEPLOYMENT_SOURCE="$(echo "$DEPLOYMENT_DETAILS" | jq -r '.source // empty')"
  # Normalize: remove trailing slashes to prevent //endpoint concatenation issues
  PREVIEW_URL="${PREVIEW_URL%%/}"
  LABEL="PR #${PR_NUMBER}"
fi

HEALTHCHECK_URL="${PREVIEW_URL}/healthcheck"

echo "Verifying deployment for ${LABEL}..."
echo "Target URL: ${HEALTHCHECK_URL}"
echo "Base URL: ${PREVIEW_URL}"

# Full or short SHAs are both accepted by the prefix comparison below.
sha_matches() {
  local actual="$1" expected="$2"
  [ -z "$actual" ] && return 1
  [ -z "$expected" ] && return 1
  [[ "$actual" == "${expected}"* ]] || [[ "$expected" == "${actual}"* ]]
}

# Hosts that may receive WEBHOOK_API_KEY: the platforms this repository deploys
# to. A deployment's environment_url is an untrusted input — the deployment
# integration supplies it — so an unlisted host means "no credentialed probe",
# never "send the key anyway".
DEFAULT_ALLOWED_HOSTS="openclaw.tail5e4271.ts.net,*.onrender.com,*.up.railway.app"

# Exact hostname, or `*.suffix` matched on a label boundary so
# `evil-up.railway.app` does not satisfy `*.up.railway.app`.
host_is_allowed() {
  local host="$1" entry suffix
  local list="${VERIFY_PREVIEW_ALLOWED_HOSTS:-$DEFAULT_ALLOWED_HOSTS}"
  local -a entries=()
  IFS=',' read -ra entries <<< "$list"
  for entry in "${entries[@]}"; do
    entry="$(printf '%s' "$entry" | tr '[:upper:]' '[:lower:]' | xargs)"
    [ -z "$entry" ] && continue
    case "$entry" in
      '*'*)
        suffix="${entry#\*.}"
        [ -z "$suffix" ] && continue
        [ "$host" = "$suffix" ] && return 0
        [[ "$host" == *".${suffix}" ]] && return 0
        ;;
      *) [ "$host" = "$entry" ] && return 0 ;;
    esac
  done
  return 1
}

# Exits 0 when $1 may receive the key; otherwise fills CREDENTIAL_TARGET_REASON
# with the reason it may not.
resolve_credential_target() {
  local url="$1" rest authority host
  CREDENTIAL_TARGET_REASON=""

  case "$url" in
    http://*)
      CREDENTIAL_TARGET_REASON="the URL is plain http://, so the key would cross the wire in cleartext"
      return 1
      ;;
  esac

  # One positive character class, so userinfo (@), query/fragment (?#), curl
  # glob metacharacters ({}[], which curl expands into extra requests carrying
  # the header), whitespace and backslashes are all rejected rather than
  # leniently parsed — there must be no reading of a crafted URL under which
  # this check passes while curl still connects elsewhere.
  if ! [[ "$url" =~ ^https://[A-Za-z0-9._~:/-]+$ ]]; then
    CREDENTIAL_TARGET_REASON="the URL is not a plain https:// URL with an ASCII hostname"
    return 1
  fi

  rest="${url#https://}"
  authority="${rest%%/*}"
  host="${authority%%:*}"
  if [[ "$authority" == *:* ]] && ! [[ "${authority##*:}" =~ ^[0-9]+$ ]]; then
    CREDENTIAL_TARGET_REASON="the URL port is not numeric"
    return 1
  fi

  host="$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')"
  if ! [[ "$host" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]]; then
    CREDENTIAL_TARGET_REASON="the hostname is not a plain ASCII hostname"
    return 1
  fi

  if ! host_is_allowed "$host"; then
    CREDENTIAL_TARGET_REASON="host '${host}' is not in VERIFY_PREVIEW_ALLOWED_HOSTS (${VERIFY_PREVIEW_ALLOWED_HOSTS:-$DEFAULT_ALLOWED_HOSTS})"
    return 1
  fi

  return 0
}

# Asks the deployment already serving PREVIEW_URL which commit it runs.
# /api/status is admin-gated, so the key travels in the x-api-key header only —
# never in the URL, the query string, or any printed line.
#
# The key is ADMIN_OPERATOR-grade (it authorizes order placement and alert
# replay), and PREVIEW_URL came from a deployment status, so the credentialed
# probe is restricted to an allowlisted HTTPS host. curl must not follow
# redirects (-L would forward the header off-host) and must not expand URL
# globs (-g), which would repeat the request — header attached — per expansion.
fetch_served_commit() {
  local status_url="${PREVIEW_URL}/api/status"
  local response curl_exit_code body status_code

  if [ -z "${WEBHOOK_API_KEY:-}" ]; then
    echo "Warning: WEBHOOK_API_KEY is unset — cannot read the served commit from ${status_url}." >&2
    return 1
  fi

  if ! resolve_credential_target "$PREVIEW_URL"; then
    echo "Warning: refusing to send WEBHOOK_API_KEY to ${PREVIEW_URL}: ${CREDENTIAL_TARGET_REASON} — served-commit check skipped." >&2
    return 1
  fi

  set +e
  response="$(curl -s -g --connect-timeout 10 --max-time 15 -H "x-api-key: ${WEBHOOK_API_KEY}" -w '\n%{http_code}' "$status_url")"
  curl_exit_code=$?
  set -e

  if [ "$curl_exit_code" -ne 0 ]; then
    echo "Warning: could not reach ${status_url} (curl exit ${curl_exit_code}) — served-commit check skipped." >&2
    return 1
  fi

  body="$(echo "$response" | sed '$d')"
  status_code="$(echo "$response" | tail -n1)"
  if [ "$status_code" != "200" ]; then
    echo "Warning: ${status_url} returned HTTP ${status_code} — served-commit check skipped." >&2
    return 1
  fi

  SERVED_COMMIT="$(echo "$body" | jq -r '.service.commit // empty' 2>/dev/null || true)"
  if [ -z "$SERVED_COMMIT" ]; then
    echo "Warning: ${status_url} did not report service.commit — served-commit check skipped." >&2
    return 1
  fi

  return 0
}

# --- Optional SHA staleness check ---
# Two independent checks, because the deployment record alone does not prove the
# probed URL serves it, and the served build alone does not prove which
# deployment the URL was selected from.
if [ -n "$EXPECTED_SHA" ] && [ "$PR_NUMBER" != "production" ] && [ "$PR_NUMBER" != "prod" ] && [ "$PR_NUMBER" != "master" ]; then
  # 1. Bound-record check: compare against the deployment that supplied the URL.
  if [ -n "$DEPLOYMENT_SHA" ]; then
    echo "Selected deployment: id=${DEPLOYMENT_ID} state=${DEPLOYMENT_STATE} sha=${DEPLOYMENT_SHA:0:10}"
    if sha_matches "$DEPLOYMENT_SHA" "$EXPECTED_SHA"; then
      echo "SHA match: selected deployment ${DEPLOYMENT_SHA:0:10} matches expected ${EXPECTED_SHA:0:10}."
    else
      echo "Error: Stale deploy detected for PR #${PR_NUMBER}." >&2
      echo "  Expected SHA     : ${EXPECTED_SHA}" >&2
      echo "  Selected SHA     : ${DEPLOYMENT_SHA}" >&2
      echo "  Deployment ID    : ${DEPLOYMENT_ID} (state=${DEPLOYMENT_STATE})" >&2
      echo "  URL              : ${PREVIEW_URL}" >&2
      echo "  The newest deployment for this PR does not match the PR head, and the" >&2
      echo "  URL resolves to an older successful deployment. Trigger Step 6.5 recovery." >&2
      exit 2  # exit 2 = stale deploy (distinct from general endpoint failure exit 1)
    fi
  else
    echo "Warning: could not determine the commit of the selected deployment (source=${DEPLOYMENT_SOURCE}) — relying on the served-build check." >&2
  fi

  # 2. Served-build check: ask the running service what it actually runs.
  if fetch_served_commit; then
    if sha_matches "$SERVED_COMMIT" "$EXPECTED_SHA"; then
      echo "Served-build match: ${PREVIEW_URL} is serving ${SERVED_COMMIT:0:10}."
    else
      echo "Error: Stale deploy detected for PR #${PR_NUMBER}." >&2
      echo "  Expected SHA     : ${EXPECTED_SHA}" >&2
      echo "  Served SHA       : ${SERVED_COMMIT}" >&2
      echo "  URL              : ${PREVIEW_URL}" >&2
      echo "  The selected preview URL is not serving the PR head commit. Trigger Step 6.5 recovery." >&2
      exit 2
    fi
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

MAX_ATTEMPTS="${VERIFY_PREVIEW_MAX_ATTEMPTS:-3}"
DELAY_SECONDS="${VERIFY_PREVIEW_RETRY_DELAY_SECONDS:-5}"

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
