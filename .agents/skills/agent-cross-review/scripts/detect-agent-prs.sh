#!/usr/bin/env bash
# detect-agent-prs.sh
# Safely inspects GitHub PRs and classifies the authoring AI agent
# (Codex, GitHub Copilot, OpenCode, Claude, Antigravity, Human/Other).
#
# Usage:
#   detect-agent-prs.sh [--limit N] [--state open|merged|all] [--agent NAME] [--exclude-self NAME] [--pr NUMBER] [--json] [--repo OWNER/NAME]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$SCRIPT_DIR/../../../../" && pwd))"
AUTH_UTILS="$REPO_ROOT/.agents/skills/issue-automator/scripts/gh-auth-utils.sh"

# Source auth utils if available
if [[ -f "$AUTH_UTILS" ]]; then
  # shellcheck source=/dev/null
  source "$AUTH_UTILS"
  trap 'restore_gh_user' EXIT
  save_gh_user && switch_to_francovp
fi

LIMIT=10
STATE="open"
TARGET_AGENT=""
EXCLUDE_SELF=""
TARGET_PR=""
OUTPUT_JSON=false
REPO_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --limit)
      LIMIT="${2:?missing value for --limit}"
      shift 2
      ;;
    --state)
      STATE="${2:?missing value for --state}"
      shift 2
      ;;
    --agent)
      TARGET_AGENT="$(echo "${2:?missing value for --agent}" | tr '[:upper:]' '[:lower:]')"
      shift 2
      ;;
    --exclude-self)
      EXCLUDE_SELF="$(echo "${2:?missing value for --exclude-self}" | tr '[:upper:]' '[:lower:]')"
      shift 2
      ;;
    --pr)
      TARGET_PR="${2:?missing value for --pr}"
      shift 2
      ;;
    --json)
      OUTPUT_JSON=true
      shift
      ;;
    --repo)
      REPO_NAME="${2:?missing value for --repo}"
      shift 2
      ;;
    -h|--help)
      cat << 'EOF'
Usage: detect-agent-prs.sh [OPTIONS]

Options:
  --limit N            Max PRs to fetch (default: 10)
  --state STATE        PR state: open, merged, all (default: open)
  --agent NAME         Filter to PRs authored by specific agent (e.g. codex, copilot, opencode, claude)
  --exclude-self NAME  Exclude PRs authored by current agent (e.g. antigravity, codex)
  --pr NUMBER          Inspect a specific PR number
  --json               Output machine-readable JSON
  --repo OWNER/NAME    Target GitHub repository (default: current repo)
  -h, --help           Show this help message
EOF
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Resolve repo
if [[ -z "$REPO_NAME" ]]; then
  REPO_NAME="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || echo "francovp/cabros-bot")"
fi

# Fetch PRs and propagate errors if gh fails
if [[ -n "$TARGET_PR" ]]; then
  if ! RAW_PR="$(gh pr view "$TARGET_PR" --repo "$REPO_NAME" --json number,title,body,headRefName,author,createdAt,state,url,commits 2>&1)"; then
    echo "Error: Failed to fetch PR #$TARGET_PR from $REPO_NAME: $RAW_PR" >&2
    exit 1
  fi
  PR_JSON="$(echo "$RAW_PR" | jq '[.]')"
else
  if ! RAW_PR="$(gh pr list --repo "$REPO_NAME" --state "$STATE" --limit "$LIMIT" --json number,title,body,headRefName,author,createdAt,state,url,commits 2>&1)"; then
    echo "Error: Failed to list PRs from $REPO_NAME: $RAW_PR" >&2
    exit 1
  fi
  PR_JSON="$RAW_PR"
fi

# Classify each PR's authoring agent
CLASSIFIED_JSON="$(echo "$PR_JSON" | jq --arg targetAgent "$TARGET_AGENT" --arg excludeSelf "$EXCLUDE_SELF" '
  def detect_agent:
    . as $pr |
    ($pr.headRefName // "") as $branch |
    ($pr.body // "") as $body |
    ($pr.commits // []) as $commits |
    ($commits | map(.authors // [] | map(.name + " " + .email + " " + (.login // "")) | join(" ")) | join(" ")) as $commitAuthors |
    ($commits | map(.messageHeadline + " " + .messageBody) | join(" ")) as $commitMsgs |
    ($body + " " + $commitMsgs) as $fullText |

    if ($branch | test("^codex/|/codex/"; "i")) or ($fullText | test("codex"; "i")) or ($commitAuthors | test("codex"; "i")) then
      "codex"
    elif ($branch | test("^copilot/|/copilot/"; "i")) or ($commitAuthors | test("copilot|anthropic\\.local"; "i")) or ($fullText | test("copilot|Co-authored-by:.*copilot"; "i")) then
      "github-copilot"
    elif ($branch | test("opencode"; "i")) or ($commitAuthors | test("opencode"; "i")) or ($fullText | test("opencode"; "i")) then
      "opencode"
    elif ($branch | test("claude"; "i")) or ($commitAuthors | test("claude"; "i")) or ($fullText | test("Claude Code"; "i")) then
      "claude"
    elif ($branch | test("antigravity"; "i")) or ($commitAuthors | test("antigravity"; "i")) or ($fullText | test("antigravity"; "i")) then
      "antigravity"
    elif ($branch | test("cursor"; "i")) or ($commitAuthors | test("cursor"; "i")) then
      "cursor"
    else
      "human"
    end;

  map(
    . + {
      detectedAgent: detect_agent
    }
    | select(
        if $targetAgent != "" then
          (.detectedAgent == $targetAgent or (.detectedAgent | test($targetAgent; "i")))
        else
          true
        end
      )
    | select(
        if $excludeSelf != "" then
          (.detectedAgent != $excludeSelf and (.detectedAgent | test($excludeSelf; "i") | not))
        else
          true
        end
      )
  )
')"

if [[ "$OUTPUT_JSON" == "true" ]]; then
  echo "$CLASSIFIED_JSON"
  exit 0
fi

TOTAL_COUNT="$(echo "$CLASSIFIED_JSON" | jq 'length')"

if [[ "$TOTAL_COUNT" -eq 0 ]]; then
  echo "No PRs matched criteria (state=$STATE, agent=$TARGET_AGENT, exclude-self=$EXCLUDE_SELF)."
  exit 0
fi

echo "================================================================================"
echo " Detected PRs for Cross-Review in $REPO_NAME (Total: $TOTAL_COUNT)"
echo "================================================================================"

echo "$CLASSIFIED_JSON" | jq -r '.[] | "PR #\(.number): \(.title)\n  • Agent:  \(.detectedAgent)\n  • Branch: \(.headRefName)\n  • State:  \(.state)\n  • URL:    \(.url)\n"'
