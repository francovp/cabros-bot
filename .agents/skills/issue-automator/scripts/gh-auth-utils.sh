#!/usr/bin/env bash
# gh-auth-utils.sh
# Helper functions for switching to the francovp GitHub user before gh CLI commands
# and restoring the original user after completion.
#
# Usage:
#   source "$(dirname "$0")/gh-auth-utils.sh"
#   save_gh_user
#   switch_to_francovp
#   # ... run gh commands ...
#   restore_gh_user
#
# Or use the trap-friendly pattern:
#   source "$(dirname "$0")/gh-auth-utils.sh"
#   trap 'restore_gh_user' EXIT
#   save_gh_user && switch_to_francovp

# Saves the currently active GitHub user to a temp file for later restoration.
# The temp file path is stored in GH_AUTH_TMP and cleaned up on restore.
save_gh_user() {
  GH_AUTH_TMP=$(mktemp /tmp/gh-auth-XXXXXX 2>/dev/null || mktemp -t gh-auth 2>/dev/null)

  # Get the current active account from gh auth status
  # Output format: "Logged in to github.com as francovp"
  local status_output
  status_output=$(gh auth status 2>&1 || true)

  local current_user
  current_user=$(echo "$status_output" | grep -oP 'account \K\S+' 2>/dev/null || \
                 echo "$status_output" | sed -n 's/.*logged in to github\.com as \([^ .]*\).*/\1/p' 2>/dev/null || \
                 echo "")

  if [ -n "$current_user" ]; then
    echo "$current_user" > "$GH_AUTH_TMP"
  else
    # If no user detected, store empty — means we don't need to restore
    echo "" > "$GH_AUTH_TMP"
  fi
}

# Switches gh CLI authentication to the francovp user.
# Must be called after save_gh_user.
switch_to_francovp() {
  if [ ! -f "${GH_AUTH_TMP:-}" ]; then
    echo "Error: save_gh_user must be called before switch_to_francovp" >&2
    return 1
  fi

  local current_user
  current_user=$(cat "$GH_AUTH_TMP")

  # Only switch if not already francovp
  if [ "$current_user" != "francovp" ]; then
    gh auth switch --user francovp 2>/dev/null || {
      echo "Warning: Failed to switch gh auth to francovp. Continuing with current user." >&2
      return 0
    }
  fi
}

# Restores the original GitHub user saved by save_gh_user.
restore_gh_user() {
  if [ ! -f "${GH_AUTH_TMP:-}" ]; then
    return 0
  fi

  local original_user
  original_user=$(cat "$GH_AUTH_TMP" 2>/dev/null || echo "")

  # Clean up temp file
  rm -f "$GH_AUTH_TMP" 2>/dev/null || true
  unset GH_AUTH_TMP

  if [ -n "$original_user" ] && [ "$original_user" != "francovp" ]; then
    gh auth switch --user "$original_user" 2>/dev/null || {
      echo "Warning: Failed to restore gh auth to $original_user" >&2
    }
  fi
}
