#!/usr/bin/env bash
# scripts/preflight-deployment.sh
# Standardized platform-agnostic deployment preflight with graceful fallback
# when render CLI is absent or unauthenticated.
#
# Usage:
#   bash scripts/preflight-deployment.sh [OPTIONS]
#
# Options:
#   --json              Emit machine-readable JSON status to stdout
#   --url URL           Explicit deployment base URL or healthcheck endpoint to probe
#   --target TARGET     Target identifier ('production' or URL)
#   --strict            Fail with non-zero exit code if live inspection and all fallbacks fail
#   -h, --help          Show this help message and exit
#
# Exit codes:
#   0  Preflight succeeded or skipped gracefully (render CLI unavailable, fallbacks ready)
#   1  Preflight failed (strict mode failure or unrecoverable error)
#   2  Invalid arguments

set -uo pipefail

JSON_OUTPUT=false
STRICT_MODE=false
TARGET=""
EXPLICIT_URL=""
DEFAULT_PRODUCTION_URL="https://cabros-crypto-bot-telegram.onrender.com"

usage() {
  cat <<'EOF'
Usage: preflight-deployment.sh [OPTIONS]

Standardized platform-agnostic deployment preflight.
Detects available deployment CLIs (render, railway, gh) and falls back gracefully
to GitHub Deployments API and /healthcheck verification when render CLI is absent.

Options:
  --json              Emit machine-readable JSON status to stdout
  --url URL           Explicit deployment base URL to probe
  --target TARGET     Target ('production' or URL)
  --strict            Fail with exit code 1 if no verification channels are available
  -h, --help          Show this help message and exit
EOF
}

# Parse options
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_OUTPUT=true
      shift
      ;;
    --strict)
      STRICT_MODE=true
      shift
      ;;
    --url)
      if [[ $# -lt 2 ]]; then
        echo "Error: --url requires a value." >&2
        exit 2
      fi
      EXPLICIT_URL="$2"
      shift 2
      ;;
    --target)
      if [[ $# -lt 2 ]]; then
        echo "Error: --target requires a value." >&2
        exit 2
      fi
      TARGET="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$TARGET" && ! "$1" =~ ^- ]]; then
        TARGET="$1"
        shift
      else
        echo "Error: unknown option or argument '$1'." >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

# Resolve effective probe URL
PROBE_URL=""
if [[ -n "$EXPLICIT_URL" ]]; then
  PROBE_URL="$EXPLICIT_URL"
elif [[ -n "$TARGET" ]]; then
  if [[ "$TARGET" =~ ^https?:// ]]; then
    PROBE_URL="$TARGET"
  elif [[ "$TARGET" == "production" || "$TARGET" == "prod" || "$TARGET" == "master" ]]; then
    PROBE_URL="${PRODUCTION_URL:-$DEFAULT_PRODUCTION_URL}"
  fi
fi

# 1. Detect render CLI
RENDER_AVAILABLE=false
RENDER_AUTHENTICATED=false
RENDER_VERSION=""
if command -v render >/dev/null 2>&1; then
  RENDER_AVAILABLE=true
  # Safely read version without SIGPIPE / pipefail issues
  RENDER_VERSION="$(render version 2>/dev/null || true)"
  RENDER_VERSION="$(printf '%s\n' "$RENDER_VERSION" | head -n 1 | tr -d '\r')"
  [[ -z "$RENDER_VERSION" ]] && RENDER_VERSION="installed"

  # Check authentication: render API key in environment or authenticated profile
  if [[ -n "${RENDER_API_KEY:-}" ]]; then
    RENDER_AUTHENTICATED=true
  elif render whoami >/dev/null 2>&1; then
    RENDER_AUTHENTICATED=true
  fi
fi

# 2. Detect railway CLI (non-blocking, token-based check)
RAILWAY_AVAILABLE=false
RAILWAY_AUTHENTICATED=false
if command -v railway >/dev/null 2>&1; then
  RAILWAY_AVAILABLE=true
  if [[ -n "${RAILWAY_TOKEN:-}" ]]; then
    RAILWAY_AUTHENTICATED=true
  fi
fi

# 3. Detect gh CLI
GH_AVAILABLE=false
GH_AUTHENTICATED=false
if command -v gh >/dev/null 2>&1; then
  GH_AVAILABLE=true
  if gh auth status >/dev/null 2>&1; then
    GH_AUTHENTICATED=true
  fi
fi

# 4. Fallback status evaluation
GITHUB_DEPLOYMENTS_FALLBACK=false
if [[ "$GH_AVAILABLE" == "true" && "$GH_AUTHENTICATED" == "true" ]]; then
  GITHUB_DEPLOYMENTS_FALLBACK=true
fi

HEALTHCHECK_FALLBACK=false
HEALTHCHECK_URL=""
HEALTHCHECK_REACHABLE=false
if [[ -n "$PROBE_URL" ]]; then
  HEALTHCHECK_FALLBACK=true
  # Normalize healthcheck URL
  BASE_URL="${PROBE_URL%/}"
  if [[ "$BASE_URL" =~ /healthcheck$ ]]; then
    HEALTHCHECK_URL="$BASE_URL"
  else
    HEALTHCHECK_URL="${BASE_URL}/healthcheck"
  fi
  # Probe healthcheck with timeout if curl is available
  if command -v curl >/dev/null 2>&1; then
    HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "$HEALTHCHECK_URL" 2>/dev/null)" || HTTP_CODE="000"
    if [[ "$HTTP_CODE" =~ ^(200|204|401|403)$ ]]; then
      HEALTHCHECK_REACHABLE=true
    fi
  fi
fi

# 5. Determine overall verdict
STATUS="skipped"
ACTIVE_INSPECTION=false
MESSAGE="SKIPPED (render CLI unavailable)"

if [[ "$RENDER_AVAILABLE" == "true" && "$RENDER_AUTHENTICATED" == "true" ]]; then
  STATUS="ready"
  ACTIVE_INSPECTION=true
  MESSAGE="ACTIVE (render CLI available and authenticated)"
elif [[ "$GITHUB_DEPLOYMENTS_FALLBACK" == "true" || "$HEALTHCHECK_REACHABLE" == "true" ]]; then
  STATUS="skipped"
  ACTIVE_INSPECTION=false
  MESSAGE="SKIPPED (render CLI unavailable; alternate verification channels active)"
else
  if [[ "$STRICT_MODE" == "true" ]]; then
    STATUS="blocked"
    MESSAGE="BLOCKED (render CLI unavailable and no alternate verification channels configured)"
  else
    STATUS="skipped"
    MESSAGE="SKIPPED (render CLI unavailable)"
  fi
fi

# Sanitize strings for valid JSON interpolation
SAFE_RENDER_VERSION=""
if [[ -n "$RENDER_VERSION" ]]; then
  SAFE_RENDER_VERSION="${RENDER_VERSION//\\/\\\\}"
  SAFE_RENDER_VERSION="${SAFE_RENDER_VERSION//\"/\\\"}"
fi

# 6. Emit output
if [[ "$JSON_OUTPUT" == "true" ]]; then
  cat <<EOF
{
  "status": "$STATUS",
  "activeInspection": $ACTIVE_INSPECTION,
  "message": "$MESSAGE",
  "renderCli": {
    "available": $RENDER_AVAILABLE,
    "authenticated": $RENDER_AUTHENTICATED,
    "version": $(if [[ -n "$SAFE_RENDER_VERSION" ]]; then printf '"%s"' "$SAFE_RENDER_VERSION"; else printf 'null'; fi)
  },
  "clis": {
    "render": {
      "available": $RENDER_AVAILABLE,
      "authenticated": $RENDER_AUTHENTICATED,
      "version": $(if [[ -n "$SAFE_RENDER_VERSION" ]]; then printf '"%s"' "$SAFE_RENDER_VERSION"; else printf 'null'; fi)
    },
    "railway": {
      "available": $RAILWAY_AVAILABLE,
      "authenticated": $RAILWAY_AUTHENTICATED
    },
    "gh": {
      "available": $GH_AVAILABLE,
      "authenticated": $GH_AUTHENTICATED
    }
  },
  "fallbacks": {
    "githubDeployments": {
      "available": $GITHUB_DEPLOYMENTS_FALLBACK
    },
    "healthcheck": {
      "configured": $HEALTHCHECK_FALLBACK,
      "url": $(if [[ -n "$HEALTHCHECK_URL" ]]; then printf '"%s"' "$HEALTHCHECK_URL"; else printf 'null'; fi),
      "reachable": $HEALTHCHECK_REACHABLE
    }
  }
}
EOF
else
  echo "[preflight] $MESSAGE"
  echo "[preflight] CLIs: render=${RENDER_AVAILABLE} (auth=${RENDER_AUTHENTICATED}), railway=${RAILWAY_AVAILABLE} (auth=${RAILWAY_AUTHENTICATED}), gh=${GH_AVAILABLE} (auth=${GH_AUTHENTICATED})"
  echo "[preflight] Fallbacks: githubDeployments=${GITHUB_DEPLOYMENTS_FALLBACK}, healthcheck=${HEALTHCHECK_FALLBACK} (reachable=${HEALTHCHECK_REACHABLE})"
fi

# Exit code handling
if [[ "$STATUS" == "blocked" && "$STRICT_MODE" == "true" ]]; then
  exit 1
fi

exit 0
