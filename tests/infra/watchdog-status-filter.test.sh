#!/bin/bash
set -euo pipefail

# Mock gh api to return a specific JSON payload
# We'll use a temporary directory to store the mock response
MOCK_DIR=$(mktemp -d)
trap 'rm -rf "$MOCK_DIR"' EXIT

# Mock gh command
gh() {
  if [[ "$1" == "api" ]]; then
    cat "$MOCK_DIR/response.json"
  else
    command gh "$@"
  fi
}
export -f gh

# Helper to run the logic extracted from the workflow
run_watchdog_logic() {
  local max_age=$1
  # Simulate the environment variables
  export GH_TOKEN="mock"
  export MAX_AGE_MINUTES="$max_age"
  
  # The exact logic from the workflow
  runs_json="$(gh api "repos/owner/repo/actions/workflows/external-uptime-monitor.yml/runs?per_page=1&status=completed")"
  created_at="$(printf '%s' "$runs_json" | jq -r '.workflow_runs[0].created_at // empty')"
  
  if [[ -z "$created_at" ]]; then
    return 1
  fi

  age_minutes=$(( ( $(date -u +%s) - $(date -u -d "$created_at" +%s) ) / 60 ))
  if (( age_minutes > MAX_AGE_MINUTES )); then
    return 1
  fi
  return 0
}

echo "Test 1: Only in-progress run exists (should fail)"
# Payload: No completed runs, but there is one in-progress run
# Note: The API with &status=completed should return an empty list
echo '{"workflow_runs": []}' > "$MOCK_DIR/response.json"
if run_watchdog_logic 30; then
  echo "❌ Test 1 Failed: Watchdog passed when no completed runs existed"
  exit 1
else
  echo "✅ Test 1 Passed: Watchdog failed as expected"
fi

echo "Test 2: Fresh in-progress run and stale completed run (should fail)"
# Payload: The API with &status=completed should ignore the in-progress run 
# and return the stale completed run.
# Create a date 40 minutes ago
STALE_DATE=$(date -u -d "40 minutes ago" --iso-8601=seconds)
echo "{\"workflow_runs\": [{\"created_at\": \"$STALE_DATE\", \"status\": \"completed\"}]}" > "$MOCK_DIR/response.json"
if run_watchdog_logic 30; then
  echo "❌ Test 2 Failed: Watchdog passed despite stale completed run"
  exit 1
else
  echo "✅ Test 2 Passed: Watchdog failed as expected"
fi

echo "Test 3: Fresh completed run exists (should pass)"
# Create a date 5 minutes ago
FRESH_DATE=$(date -u -d "5 minutes ago" --iso-8601=seconds)
echo "{\"workflow_runs\": [{\"created_at\": \"$FRESH_DATE\", \"status\": \"completed\"}]}" > "$MOCK_DIR/response.json"
if run_watchdog_logic 30; then
  echo "✅ Test 3 Passed: Watchdog passed as expected"
else
  echo "❌ Test 3 Failed: Watchdog failed despite fresh completed run"
  exit 1
fi

echo "All tests passed! 🚀"
