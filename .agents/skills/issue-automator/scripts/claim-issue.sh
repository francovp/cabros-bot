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
#        comment, then post-and-arbitrate: the earliest new claim wins, the
#        loser deletes its comment and exits 2 (RESULT=SKIP). This closes the
#        simultaneous-takeover race: two sessions that both see a stale claim
#        cannot both end up as owners.
#      - claim is ours (same agent + session) -> renew -> RESULT=CLAIMED (exit 0).
#   2. If unclaimed: add the `agent-working` label, post a claim comment
#      (`**agent-claim**: <agent> <session> <ISO-8601>`), re-read the comments
#      and arbitrate concurrent races by comment ID — the earliest new claim
#      wins, the loser deletes its comment and exits 2 (RESULT=SKIP).
#
# All claim-comment reads go through the REST API (`gh api
# repos/<owner>/<repo>/issues/<n>/comments`), which returns numeric comment IDs
# in creation order. The GraphQL `gh issue view --json comments` endpoint is
# NOT used for arbitration because it returns opaque node IDs (e.g. `IC_...`)
# that cannot be compared numerically with the REST IDs returned when posting.
#
# Env:
#   CLAIM_AGENT_ID     agent identity (e.g. codex, antigravity) — set per
#                      session; REQUIRED for meaningful coordination.
#   CLAIM_SESSION_ID   session identity; auto-generated unless set. Set it once
#                      per session (e.g. `export CLAIM_SESSION_ID="$(uuidgen)"`
#                      in the parent workflow) so every claim check in the same
#                      run shares the identity. When omitted, the script
#                      persists its generated ID per agent+repo and reuses it
#                      within CLAIM_SESSION_REUSE_MINUTES (default 30) so the
#                      Step 1 claim and the Step 2 re-check stay the same
#                      session; a new session (e.g. the next hourly run) gets a
#                      fresh ID once the reuse window passes.
#   CLAIM_TTL_MINUTES  claim freshness window (default: 180). A claim older
#                      than this may be taken over by any agent.
#   CLAIM_SESSION_REUSE_MINUTES  how long a persisted auto-generated session ID
#                      stays reusable (default: 30; must be shorter than the
#                      typical gap between sessions so fresh runs get fresh IDs).
#   CLAIM_SESSION_STATE_DIR  directory for the persisted session ID
#                      (default: ${TMPDIR:-/tmp}).
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

# Resolve the session identity. Prefer an explicit CLAIM_SESSION_ID; otherwise
# reuse a persisted auto-generated ID within the reuse window so consecutive
# invocations of the same run (Step 1 claim -> Step 2 re-check) share it, while
# a new session (past the window) generates and persists a fresh one.
SESSION_ID=""
if [ -n "${CLAIM_SESSION_ID:-}" ]; then
  SESSION_ID="$CLAIM_SESSION_ID"
else
  REUSE_MINUTES="${CLAIM_SESSION_REUSE_MINUTES:-30}"
  STATE_DIR="${CLAIM_SESSION_STATE_DIR:-${TMPDIR:-/tmp}}"
  # Scope the persisted session ID to the run when the parent workflow supplies
  # one; otherwise two distinct runs of the same agent on one host would share
  # the ID within the reuse window and treat each other's claims as their own.
  RUN_NS="${CLAIM_RUN_ID:-}"
  STATE_FILE="${STATE_DIR}/cabros-claim-session-$(printf '%s' "$REPO" | tr '/:' '-')-${AGENT_ID}${RUN_NS:+-${RUN_NS}}"
  if [ -f "$STATE_FILE" ]; then
    # Portable mtime: macOS `stat -f %m`, GNU `stat -c %Y`.
    saved_epoch="$(stat -f %m "$STATE_FILE" 2>/dev/null || stat -c %Y "$STATE_FILE" 2>/dev/null || echo 0)"
    now_epoch="$(date +%s)"
    if [ -n "$saved_epoch" ] && [ $(( now_epoch - saved_epoch )) -lt $(( REUSE_MINUTES * 60 )) ]; then
      SESSION_ID="$(cat "$STATE_FILE" 2>/dev/null || true)"
    fi
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="session-$$-$(date +%s)"
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    printf '%s' "$SESSION_ID" > "$STATE_FILE" 2>/dev/null || true
  fi
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

# claim_comments_rest -> TSV "id<TAB>body" for ALL claim comments via the REST
# API (numeric ids, creation order). Empty when none exist. Paginated so
# claim comments past the first REST page still participate in arbitration.
claim_comments_rest() {
  gh api --paginate "repos/${REPO}/issues/${ISSUE_NUMBER}/comments" --jq '
    [.[] | select(.body | startswith("**agent-claim**"))]
    | .[] | "\(.id)\t\(.body)"' 2>/dev/null || true
}

# newest_claim -> single line "id<TAB>agent<TAB>session<TAB>ts" for the newest
# claim comment (largest numeric id), or empty when no claim comments exist.
newest_claim() {
  local newest
  newest="$(claim_comments_rest | awk -F '\t' '{ if (max == "" || $1+0 > max+0) { max=$1; line=$0 } } END { print line }')"
  if [ -z "$newest" ]; then return 0; fi
  local rest agent session ts
  rest="$(echo "$newest" | cut -f2 | sed 's/^\*\*agent-claim\*\*:[[:space:]]*//')"
  agent="$(echo "$rest" | awk '{print $1}')"
  session="$(echo "$rest" | awk '{print $2}')"
  ts="$(echo "$rest" | awk '{print $3}')"
  printf '%s\t%s\t%s\t%s\n' "$(echo "$newest" | cut -f1)" "$agent" "$session" "$ts"
}

# last_labeled_event_ts -> timestamp of the most recent agent-working labeled
# event (fallback for legacy claims made before claim comments existed).
last_labeled_event_ts() {
  gh api --paginate "repos/${REPO}/issues/${ISSUE_NUMBER}/events" --jq '
    [.[] | select(.event == "labeled" and .label.name == "agent-working") | .created_at]
    | max // empty' 2>/dev/null || true
}

# post_claim_comment <body> -> new numeric comment id (empty on failure)
post_claim_comment() {
  gh api "repos/${REPO}/issues/${ISSUE_NUMBER}/comments" -f body="$1" --jq .id 2>/dev/null || echo ""
}

# delete_claim_comment <comment_id> — best-effort cleanup of a lost race comment.
delete_claim_comment() {
  gh api -X DELETE "repos/${REPO}/issues/comments/$1" &> /dev/null || true
}

# remove_agent_working — best-effort label removal (used only when this script
# knows no other session holds a valid claim).
remove_agent_working() {
  gh issue edit "$ISSUE_NUMBER" --remove-label "agent-working" &> /dev/null || true
}

# arbitrate_race <snapshot_id> <our_id> -> echoes the winning numeric comment id
# among claim comments newer than the snapshot; echoes <our_id> when we win.
# Reads back up to 3 times so concurrent claims surface despite API lag.
arbitrate_race() {
  local snapshot_id="$1" our_id="$2"
  local winner="$our_id" newer min_id
  for _ in 1 2 3; do
    newer="$(claim_comments_rest | awk -F '\t' -v snap="$snapshot_id" '$1+0 > snap+0 { print $1 }')"
    if [ -n "$newer" ]; then
      min_id="$(echo "$newer" | awk '{ if (min == "" || $1+0 < min+0) min = $1 } END { print min }')"
      if [ -n "$min_id" ] && [ "$min_id" != "$our_id" ] && [ "$min_id" -lt "$our_id" ]; then
        winner="$min_id"
        break
      fi
    fi
    sleep 1
  done
  echo "$winner"
}

# ---------------------------------------------------------------------------
# Snapshot the newest claim comment BEFORE the label check: if another session
# completes its claim between our label observation and our own post, its
# comment must participate in arbitration instead of being dismissed as
# "historical".
# ---------------------------------------------------------------------------
SNAPSHOT_ID="$(newest_claim | cut -f1)"
SNAPSHOT_ID="${SNAPSHOT_ID:-0}"

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

    # Stale claim by another session: post our takeover and arbitrate. Two
    # sessions may race here, so the earliest new claim comment wins.
    OUR_TAKEOVER_ID="$(post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS} (takeover of stale claim by ${NEWEST_AGENT}/${NEWEST_SESSION})")"
    if [ -z "$OUR_TAKEOVER_ID" ]; then
      echo "RESULT=ERROR"
      echo "Error: failed to post the takeover claim comment on issue #${ISSUE_NUMBER}." >&2
      exit 1
    fi
    WINNER="$(arbitrate_race "$NEWEST_ID" "$OUR_TAKEOVER_ID")"
    if [ "$WINNER" != "$OUR_TAKEOVER_ID" ]; then
      delete_claim_comment "$OUR_TAKEOVER_ID"
      echo "RESULT=SKIP"
      echo "Issue #${ISSUE_NUMBER}: takeover raced by another session (comment ${WINNER} won). Skipping — zero-work, no budget consumed."
      exit 2
    fi
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

  # Legacy takeover: snapshot is 0 (no claim comments exist) so any claim
  # comment that appears during the race participates in arbitration.
  OUR_LEGACY_ID="$(post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS} (takeover of legacy agent-working)")"
  if [ -z "$OUR_LEGACY_ID" ]; then
    echo "RESULT=ERROR"
    echo "Error: failed to post the takeover claim comment on issue #${ISSUE_NUMBER}." >&2
    exit 1
  fi
  WINNER="$(arbitrate_race 0 "$OUR_LEGACY_ID")"
  if [ "$WINNER" != "$OUR_LEGACY_ID" ]; then
    delete_claim_comment "$OUR_LEGACY_ID"
    echo "RESULT=SKIP"
    echo "Issue #${ISSUE_NUMBER}: legacy takeover raced by another session (comment ${WINNER} won). Skipping — zero-work, no budget consumed."
    exit 2
  fi
  echo "RESULT=TAKEOVER"
  echo "Issue #${ISSUE_NUMBER}: legacy agent-working claim taken over."
  exit 0
fi

# ---------------------------------------------------------------------------
# 2) Unclaimed -> race to claim. SNAPSHOT_ID was captured before the label
#    check (above) and historical claim comments from already-released issues
#    are ignored by arbitration (only ids newer than the snapshot participate).
# ---------------------------------------------------------------------------
gh issue edit "$ISSUE_NUMBER" --add-label "agent-working" &> /dev/null || {
  echo "RESULT=ERROR"
  echo "Error: failed to add the agent-working label to issue #${ISSUE_NUMBER}." >&2
  exit 1
}

OUR_ID="$(post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS}")"
if [ -z "$OUR_ID" ]; then
  # Partial failure: the label is on but our claim comment never landed. Remove
  # the label unless a NEWER claim comment (past the snapshot) appeared in the
  # meantime — a historical comment alone must not keep the label we added.
  if [ -z "$(claim_comments_rest | awk -F '\t' -v snap="$SNAPSHOT_ID" '$1+0 > snap+0 { print $1 }')" ]; then
    remove_agent_working
  fi
  echo "RESULT=ERROR"
  echo "Error: failed to post the claim comment on issue #${ISSUE_NUMBER}." >&2
  exit 1
fi

WINNER_ID="$(arbitrate_race "$SNAPSHOT_ID" "$OUR_ID")"

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
