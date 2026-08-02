#!/usr/bin/env bash
# claim-issue.sh <ISSUE_NUMBER>
# Atomically claims a GitHub issue for this agent session so concurrent sessions
# (Codex, Antigravity, OpenCode, hourly cron) never work the same issue twice
# and never create duplicate PRs.
#
# Protocol:
#   1. Re-fetch the issue. If it already carries the `agent-working` label:
#      - newest claim comment (or legacy labeled event) is fresh and owned by
#        ANOTHER session  -> RESULT=SKIP (exit 2) — do NOT touch the issue.
#      - claim is stale (older than CLAIM_TTL_MINUTES) -> post a takeover claim
#        comment -> RESULT=TAKEOVER (exit 0).
#      - claim is ours (same agent + session) -> renew -> RESULT=CLAIMED (exit 0).
#   2. If unclaimed: add the `agent-working` label, post a claim comment
#      (`**agent-claim**: <agent> <session> <ISO-8601>`), re-read the comments
#      and arbitrate concurrent races by comment ID — the earliest new claim
#      wins, the loser deletes its comment and exits 2 (RESULT=SKIP).
#
# Env:
#   CLAIM_AGENT_ID     agent identity (e.g. codex, antigravity) — set per
#                      session; REQUIRED for meaningful coordination.
#   CLAIM_SESSION_ID   session identity; auto-generated unless set (set it to
#                      continue work across sessions of the same agent).
#   CLAIM_TTL_MINUTES  claim freshness window (default: 180). A claim older
#                      than this may be taken over by any agent.
#
# Exit codes:
#   0  claimed by this session (RESULT=CLAIMED | RESULT=TAKEOVER)
#   2  claimed by another session (RESULT=SKIP — zero-work skip)
#   1  error (RESULT=ERROR)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/gh-auth-utils.sh"

ISSUE_NUMBER="${1:-}"
if [[ ! "$ISSUE_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "Error: usage: claim-issue.sh <ISSUE_NUMBER>" >&2
  exit 1
fi

AGENT_ID="${CLAIM_AGENT_ID:-${AGENT_NAME:-unknown-agent}}"
SESSION_ID="${CLAIM_SESSION_ID:-session-$$-$(date +%s)}"
TTL_MINUTES="${CLAIM_TTL_MINUTES:-180}"
if [[ ! "$TTL_MINUTES" =~ ^[0-9]+$ ]]; then
  echo "Error: CLAIM_TTL_MINUTES must be a positive integer, got '$TTL_MINUTES'." >&2
  exit 1
fi
CLAIM_PREFIX='**agent-claim**:'

NOW_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Switch to francovp for all gh commands; restore on exit.
trap 'restore_gh_user' EXIT
save_gh_user
switch_to_francovp

if ! gh auth status &> /dev/null; then
  echo "RESULT=ERROR"
  echo "Error: 'gh' CLI is not authenticated as francovp. Please run 'gh auth login' or configure GITHUB_TOKEN." >&2
  exit 1
fi

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null || true)"
if [ -z "$REPO" ]; then
  echo "RESULT=ERROR"
  echo "Error: cannot determine repository owner/name — run claim-issue.sh from the repo root." >&2
  exit 1
fi

# epoch_of: portable ISO-8601 UTC -> epoch seconds (GNU date first, BSD fallback).
# Timestamps are always UTC (Z suffix), so both paths must interpret them as UTC
# (`-u`); BSD `date -j` defaults to local time, which would skew TTL checks.
epoch_of() {
  local ts="$1" e
  e="$(date -u -d "$ts" +%s 2>/dev/null)" && { echo "$e"; return 0; }
  e="$(date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null)" && { echo "$e"; return 0; }
  echo ""
}

# age_minutes <ISO-8601> -> whole minutes since the timestamp (huge if unparseable)
age_minutes() {
  local e now
  e="$(epoch_of "$1")"
  [ -z "$e" ] && { echo "99999"; return 0; }
  now="$(date +%s)"
  echo $(( (now - e) / 60 ))
}

# has_agent_working -> "true" | "false"
has_agent_working() {
  gh issue view "$ISSUE_NUMBER" --json labels \
    --jq '[.labels[].name] | index("agent-working") != null' 2>/dev/null
}

# newest_claim -> single line "id<TAB>agent<TAB>session<TAB>ts" for the newest
# claim comment, or empty when no claim comments exist.
newest_claim() {
  gh issue view "$ISSUE_NUMBER" --json comments --jq '
    [.comments[] | select(.body | startswith("**agent-claim**")) |
      . as $c | ($c.body | gsub("^\\*\\*agent-claim\\*\\*:\\s*"; "")) as $rest |
      ($rest | split(" ")) as $f | { id: $c.id, agent: $f[0], session: $f[1], ts: $f[2] }]
    | select(length > 0)
    | sort_by(.id) | reverse | .[0]
    | "\(.id)\t\(.agent)\t\(.session)\t\(.ts)"' 2>/dev/null || true
}

# last_labeled_event_ts -> timestamp of the most recent agent-working labeled
# event (fallback for legacy claims made before claim comments existed).
last_labeled_event_ts() {
  gh api "repos/${REPO}/issues/${ISSUE_NUMBER}/events" --jq '
    [.[] | select(.event == "labeled" and .label.name == "agent-working") | .created_at]
    | max // empty' 2>/dev/null || true
}

# post_claim_comment <body> -> new comment id (empty on failure)
post_claim_comment() {
  gh api "repos/${REPO}/issues/${ISSUE_NUMBER}/comments" -f body="$1" --jq .id 2>/dev/null || echo ""
}

# delete_claim_comment <comment_id> — best-effort cleanup of a lost race comment.
delete_claim_comment() {
  gh api -X DELETE "repos/${REPO}/issues/comments/$1" &> /dev/null || true
}

# ---------------------------------------------------------------------------
# 1) Issue already carries the agent-working label -> resolve the claim.
# ---------------------------------------------------------------------------
if [ "$(has_agent_working)" == "true" ]; then
  NEWEST="$(newest_claim)"

  if [ -n "$NEWEST" ]; then
    NEWEST_ID="$(echo "$NEWEST" | cut -f1)"
    NEWEST_AGENT="$(echo "$NEWEST" | cut -f2)"
    NEWEST_SESSION="$(echo "$NEWEST" | cut -f3)"
    NEWEST_TS="$(echo "$NEWEST" | cut -f4)"

    if [ "$NEWEST_AGENT" == "$AGENT_ID" ] && [ "$NEWEST_SESSION" == "$SESSION_ID" ]; then
      # Our own claim: renew the timestamp and confirm ownership.
      post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS}" > /dev/null
      echo "RESULT=CLAIMED"
      echo "Issue #${ISSUE_NUMBER} already claimed by this session (${AGENT_ID}/${SESSION_ID}); renewed."
      exit 0
    fi

    AGE="$(age_minutes "$NEWEST_TS")"
    if [ "$AGE" -le "$TTL_MINUTES" ]; then
      echo "RESULT=SKIP"
      echo "Issue #${ISSUE_NUMBER} is claimed by ${NEWEST_AGENT}/${NEWEST_SESSION} (${AGE} min ago, TTL ${TTL_MINUTES} min). Skipping — zero-work, no budget consumed."
      exit 2
    fi

    post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS} (takeover of stale claim by ${NEWEST_AGENT}/${NEWEST_SESSION})" > /dev/null
    echo "RESULT=TAKEOVER"
    echo "Issue #${ISSUE_NUMBER}: stale claim (${AGE} min) by ${NEWEST_AGENT}/${NEWEST_SESSION} taken over."
    exit 0
  fi

  # Label present but no claim comment (legacy claim): fall back to the most
  # recent labeled event timestamp.
  LEGACY_TS="$(last_labeled_event_ts)"
  if [ -n "$LEGACY_TS" ]; then
    AGE="$(age_minutes "$LEGACY_TS")"
    if [ "$AGE" -le "$TTL_MINUTES" ]; then
      echo "RESULT=SKIP"
      echo "Issue #${ISSUE_NUMBER} carries agent-working (legacy claim, ${AGE} min ago). Skipping — zero-work, no budget consumed."
      exit 2
    fi
  fi

  post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS} (takeover of legacy agent-working)" > /dev/null
  echo "RESULT=TAKEOVER"
  echo "Issue #${ISSUE_NUMBER}: legacy agent-working claim taken over."
  exit 0
fi

# ---------------------------------------------------------------------------
# 2) Unclaimed -> race to claim. Historical claim comments from already
#    released issues are ignored (snapshot id) so they cannot block us.
# ---------------------------------------------------------------------------
SNAPSHOT_ID="$(newest_claim | cut -f1)"
SNAPSHOT_ID="${SNAPSHOT_ID:-0}"

gh issue edit "$ISSUE_NUMBER" --add-label "agent-working" &> /dev/null || {
  echo "RESULT=ERROR"
  echo "Error: failed to add the agent-working label to issue #${ISSUE_NUMBER}." >&2
  exit 1
}

OUR_ID="$(post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS}")"
if [ -z "$OUR_ID" ]; then
  echo "RESULT=ERROR"
  echo "Error: failed to post the claim comment on issue #${ISSUE_NUMBER}." >&2
  exit 1
fi

# Read back comments (GitHub API may lag briefly) and arbitrate: the earliest
# new claim comment wins. Poll up to 3 times so concurrent claims surface.
WINNER_ID="$OUR_ID"
for _ in 1 2 3; do
  NEWER="$(gh issue view "$ISSUE_NUMBER" --json comments --jq '
    [.comments[] | select(.body | startswith("**agent-claim**")) | .id]
    | map(select(. > '"$SNAPSHOT_ID"')) | .[]' 2>/dev/null || true)"
  if [ -n "$NEWER" ]; then
    MIN_ID="$(echo "$NEWER" | awk '{ if (min == "" || $1+0 < min+0) min = $1 } END { print min }')"
    if [ -n "$MIN_ID" ] && [ "$MIN_ID" != "$OUR_ID" ] && [ "$MIN_ID" -lt "$OUR_ID" ]; then
      WINNER_ID="$MIN_ID"
      break
    fi
  fi
  sleep 1
done

if [ "$WINNER_ID" == "$OUR_ID" ]; then
  echo "RESULT=CLAIMED"
  echo "Issue #${ISSUE_NUMBER} claimed by ${AGENT_ID}/${SESSION_ID}."
  exit 0
fi

# Lost the race: another session claimed first. Remove our comment and skip.
delete_claim_comment "$OUR_ID"
echo "RESULT=SKIP"
echo "Issue #${ISSUE_NUMBER} was claimed first by another session (comment ${WINNER_ID}). Skipping — zero-work, no budget consumed."
exit 2
