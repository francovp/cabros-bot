#!/usr/bin/env bash
# detect-agent-prs.sh
# Safely inspects GitHub PRs and classifies the authoring AI agent & model
# (Codex, GitHub Copilot, OpenCode, Claude, Antigravity, Human/Other).
#
# Recognizes agent-model labels like "antigravity-*", "codex-*", "github-copilot-*", etc.
#
# Usage:
#   detect-agent-prs.sh [--limit N] [--state open|merged|all] [--agent NAME] [--label PATTERN] [--exclude-self NAME] [--pr NUMBER] [--add-label LABEL] [--json] [--repo OWNER/NAME]

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
TARGET_LABEL=""
EXCLUDE_SELF=""
TARGET_PR=""
ADD_LABEL=""
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
    --label)
      TARGET_LABEL="${2:?missing value for --label}"
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
    --add-label|--ensure-agent-label)
      ADD_LABEL="${2:?missing value for --add-label}"
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
  --label PATTERN      Filter to PRs having a label matching PATTERN (e.g. "codex-*", "antigravity-*")
  --exclude-self NAME  Exclude PRs authored by current agent (e.g. antigravity, codex)
  --pr NUMBER          Inspect a specific PR number
  --add-label LABEL    Attach an agent-model label to the specified PR (--pr required)
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
  if ! REPO_NAME="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>&1)"; then
    echo "Error: Failed to resolve current repository with 'gh repo view': $REPO_NAME" >&2
    exit 1
  fi
fi

# If --add-label requested on a PR
if [[ -n "$ADD_LABEL" ]]; then
  if [[ -z "$TARGET_PR" ]]; then
    echo "Error: --add-label requires --pr <number>" >&2
    exit 1
  fi
  # Ensure label exists in repository or create it
  gh label create "$ADD_LABEL" --repo "$REPO_NAME" --color "7057ff" --description "Agent and model attribution label" 2>/dev/null || true
  gh pr edit "$TARGET_PR" --repo "$REPO_NAME" --add-label "$ADD_LABEL" >/dev/null
  if [[ "$OUTPUT_JSON" != "true" ]]; then
    echo "Added label '$ADD_LABEL' to PR #$TARGET_PR in $REPO_NAME."
  fi
fi

# Fetch PRs and propagate errors if gh fails
if [[ -n "$TARGET_PR" ]]; then
  if ! RAW_PR="$(gh pr view "$TARGET_PR" --repo "$REPO_NAME" --json number,title,body,headRefName,author,createdAt,state,url,commits,labels 2>&1)"; then
    echo "Error: Failed to fetch PR #$TARGET_PR from $REPO_NAME: $RAW_PR" >&2
    exit 1
  fi
  PR_JSON="$(echo "$RAW_PR" | jq '[.]')"
else
  if ! RAW_PR="$(gh pr list --repo "$REPO_NAME" --state "$STATE" --limit "$LIMIT" --json number,title,body,headRefName,author,createdAt,state,url,commits,labels 2>&1)"; then
    echo "Error: Failed to list PRs from $REPO_NAME: $RAW_PR" >&2
    exit 1
  fi
  PR_JSON="$RAW_PR"
fi

# Classify each PR's authoring agent and model
CLASSIFIED_JSON="$(echo "$PR_JSON" | jq --arg targetAgent "$TARGET_AGENT" --arg targetLabel "$TARGET_LABEL" --arg excludeSelf "$EXCLUDE_SELF" '
  def extract_agent_label:
    (.labels // [])
    | map(.name)
    | map(select(test("^(antigravity|codex|github-copilot|copilot|claude|opencode|cursor)-"; "i")))
    | first // null;

  def parse_agent_from_label($lbl):
    if $lbl == null then null
    elif ($lbl | test("^antigravity-"; "i")) then "antigravity"
    elif ($lbl | test("^codex-"; "i")) then "codex"
    elif ($lbl | test("^(github-copilot|copilot)-"; "i")) then "github-copilot"
    elif ($lbl | test("^claude-"; "i")) then "claude"
    elif ($lbl | test("^opencode-"; "i")) then "opencode"
    elif ($lbl | test("^cursor-"; "i")) then "cursor"
    else null
    end;

  def parse_model_from_label($lbl):
    if $lbl == null then null
    elif ($lbl | test("^antigravity-"; "i")) then ($lbl | sub("^antigravity-"; ""; "i"))
    elif ($lbl | test("^codex-"; "i")) then ($lbl | sub("^codex-"; ""; "i"))
    elif ($lbl | test("^github-copilot-"; "i")) then ($lbl | sub("^github-copilot-"; ""; "i"))
    elif ($lbl | test("^copilot-"; "i")) then ($lbl | sub("^copilot-"; ""; "i"))
    elif ($lbl | test("^claude-"; "i")) then ($lbl | sub("^claude-"; ""; "i"))
    elif ($lbl | test("^opencode-"; "i")) then ($lbl | sub("^opencode-"; ""; "i"))
    elif ($lbl | test("^cursor-"; "i")) then ($lbl | sub("^cursor-"; ""; "i"))
    else ($lbl | sub("^[a-zA-Z0-9_]+-"; ""))
    end;

  def detect_agent:
    . as $pr |
    (extract_agent_label) as $agentLabel |
    (parse_agent_from_label($agentLabel)) as $agentFromLabel |

    if $agentFromLabel != null then
      $agentFromLabel
    else
      ($pr.headRefName // "") as $branch |
      ($pr.body // "") as $body |
      ($pr.commits // []) as $commits |
      ($commits | map(.authors // [] | map(.name + " " + .email + " " + (.login // "")) | join(" ")) | join(" ")) as $commitAuthors |

      # 1. First check explicit branch prefix and commit author signatures
      if ($branch | test("^codex/|/codex/"; "i")) or ($commitAuthors | test("codex"; "i")) then
        "codex"
      elif ($branch | test("^copilot/|/copilot/"; "i")) or ($commitAuthors | test("copilot"; "i")) then
        "github-copilot"
      elif ($branch | test("^claude/|/claude/"; "i")) or ($commitAuthors | test("claude|anthropic"; "i")) then
        "claude"
      elif ($branch | test("^opencode/|/opencode/"; "i")) or ($commitAuthors | test("opencode"; "i")) then
        "opencode"
      elif ($branch | test("^antigravity/|/antigravity/|agent_cross_review"; "i")) or ($commitAuthors | test("antigravity"; "i")) then
        "antigravity"
      elif ($branch | test("^cursor/|/cursor/"; "i")) or ($commitAuthors | test("cursor"; "i")) then
        "cursor"

      # 2. If branch and commit authors are neutral, check specific generator/attribution markers in body
      elif ($body | test("Generated by Codex|Created by Codex"; "i")) then
        "codex"
      elif ($body | test("Co-authored-by:.*copilot|Created by GitHub Copilot"; "i")) then
        "github-copilot"
      elif ($body | test("Claude Code|Co-authored-by:.*claude"; "i")) then
        "claude"
      elif ($body | test("Created with OpenCode|Co-authored-by:.*opencode"; "i")) then
        "opencode"
      elif ($body | test("Created with Antigravity|Co-authored-by:.*antigravity"; "i")) then
        "antigravity"
      elif ($body | test("Created with Cursor|Co-authored-by:.*cursor"; "i")) then
        "cursor"
      else
        "human"
      end
    end;

  map(
    . as $item |
    ($item | extract_agent_label) as $lbl |
    $item + {
      detectedAgent: detect_agent,
      agentLabel: $lbl,
      detectedModel: (parse_model_from_label($lbl))
    }
    | select(
        if $targetAgent != "" then
          (.detectedAgent == $targetAgent or (.detectedAgent | test($targetAgent; "i")))
        else
          true
        end
      )
    | select(
        if $targetLabel != "" then
          ((.labels // []) | map(.name) | any(test($targetLabel | gsub("\\*"; ".*"); "i")))
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
  echo "No PRs matched criteria (state=$STATE, agent=$TARGET_AGENT, label=$TARGET_LABEL, exclude-self=$EXCLUDE_SELF)."
  exit 0
fi

echo "================================================================================"
echo " Detected PRs for Cross-Review in $REPO_NAME (Total: $TOTAL_COUNT)"
echo "================================================================================"

echo "$CLASSIFIED_JSON" | jq -r '.[] | 
  "PR #\(.number): \(.title)\n  • Agent:  \(.detectedAgent)\(if .detectedModel then " (Model: " + .detectedModel + ", Label: " + .agentLabel + ")" elif .agentLabel then " (Label: " + .agentLabel + ")" else "" end)\n  • Branch: \(.headRefName)\n  • State:  \(.state)\n  • URL:    \(.url)\n"'
