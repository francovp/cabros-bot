#!/usr/bin/env bash
# verify-preview.sh
# Verifies the Render preview deployment for a given PR number.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <PR_NUMBER>" >&2
  exit 1
fi

PR_NUMBER="$1"

# Determine Render service name: RENDER_SERVICE_NAME env var > repo name > hardcoded fallback
RENDER_SERVICE_NAME="${RENDER_SERVICE_NAME:-$(gh repo view --json name -q '.name' 2>/dev/null)}"

PREVIEW_URL="https://${RENDER_SERVICE_NAME}-pr-${PR_NUMBER}.onrender.com"
HEALTHCHECK_URL="${PREVIEW_URL}/healthcheck"

echo "Verifying Render preview deployment for PR #${PR_NUMBER}..."
echo "Target URL: ${HEALTHCHECK_URL}"

MAX_ATTEMPTS=3
DELAY_SECONDS=5
ATTEMPT=1
SUCCESS=0

while [ "$ATTEMPT" -le "$MAX_ATTEMPTS" ]; do
  echo "Attempt $ATTEMPT of $MAX_ATTEMPTS..."
  
  # Fetch healthcheck status code and content
  set +e
  response=$(curl -s -w "\n%{http_code}" --connect-timeout 10 --max-time 15 "$HEALTHCHECK_URL")
  curl_exit_code=$?
  set -e

  if [ "$curl_exit_code" -ne 0 ]; then
    echo "Warning: curl request failed with exit code $curl_exit_code." >&2
  else
    # Parse the response and HTTP status code
    body=$(echo "$response" | sed '$d')
    status_code=$(echo "$response" | tail -n1)

    echo "HTTP Status Code: $status_code"
    echo "Response Body: $body"

    if [ "$status_code" -eq 200 ]; then
      echo "Success: Preview deployment is live and healthy."
      SUCCESS=1
      break
    fi
  fi

  if [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; then
    echo "Waiting $DELAY_SECONDS seconds before next attempt..."
    sleep "$DELAY_SECONDS"
  fi
  ATTEMPT=$((ATTEMPT + 1))
done

if [ "$SUCCESS" -eq 1 ]; then
  exit 0
else
  echo "Error: Failed to verify preview deployment at ${HEALTHCHECK_URL} after $MAX_ATTEMPTS attempts." >&2
  exit 1
fi
