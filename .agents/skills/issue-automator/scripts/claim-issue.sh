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
#   CLAIM_SESSION_ID   session identity; optional. When set, it is used verbatim
#                      — the caller owns reuse, e.g.
#                      `export CLAIM_SESSION_ID="$(uuidgen)"` in the workflow so
#                      every invocation of the same session shares the identity.
#   CLAIM_RUN_ID       per-run identity; optional. When set (and
#                      CLAIM_SESSION_ID is not), the script generates a session
#                      ID once, persists it to a run-scoped file, and reuses it
#                      verbatim for the WHOLE run — there is NO wall-clock reuse
#                      window because the Step 1 claim and any later Step 2 / Nth
#                      re-check of the SAME run must share the identity even when
#                      the run outlives 30 minutes (an expiry would make the
#                      re-check mint a fresh ID, see its own Step 1 claim as a
#                      foreign session, and RESULT=SKIP, abandoning the issue to
#                      its TTL). Each run MUST use a fresh CLAIM_RUN_ID (e.g. set
#                      it to the run/cron timestamp) because it is the run's
#                      coordination namespace. When neither is set, a fresh
#                      per-invocation session ID is used with NO shared
#                      persistence — concurrent unnamespaced runs must not share
#                      a claim (duplicate-work risk).
#   CLAIM_TTL_MINUTES  claim freshness window (default: 180). A claim older
#                      than this may be taken over by any agent.
#   CLAIM_SESSION_STATE_DIR  directory for the persisted run-scoped session ID
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

# Resolve the session identity. Three modes:
#   - CLAIM_SESSION_ID set      -> use it verbatim (caller owns reuse across steps).
#   - CLAIM_RUN_ID set          -> reuse a persisted auto-generated ID for the WHOLE
#                                  run (no expiry) so the Step 1 claim and every Step 2
#                                  / Nth re-check of the SAME run share it; the ID file
#                                  is namespaced by the run id. Treating a shared
#                                  CLAIM_RUN_ID as shared ownership is deliberate: a
#                                  stale persisted ID that outlives any reuse window must
#                                  still be reused or a long running Step 2 would mint a
#                                  fresh ID, see its own Step 1 claim as foreign, and
#                                  RESULT=SKIP (abandoning the run to the TTL).
#   - neither set               -> fresh per-invocation ID, no shared persistence,
#                                  because without a caller-supplied namespace we
#                                  cannot tell two concurrent runs of the same
#                                  agent apart; an unnamespaced shared file would
#                                  let the second run treat the first run's claim
#                                  as its own (duplicate work).
# gen_session_id -> a collision-resistant random session identifier. `$$` + epoch
# is NOT unique: two sessions with the same agent that start in separate
# containers during the same second can share a PID (both often 1 inside a
# container) and an identical epoch, producing the same id. A random UUID avoids
# matching another session's claim as our own (duplicate work).
gen_session_id() {
  local id
  if command -v uuidgen >/dev/null 2>&1; then
    id="$(uuidgen)"
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    id="$(< /proc/sys/kernel/random/uuid)"
  else
    id="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  fi
  [ -n "$id" ] || id="session-$$-$(date +%s%N)"
  printf 'session-%s' "$id"
}

SESSION_ID=""
if [ -n "${CLAIM_SESSION_ID:-}" ]; then
  SESSION_ID="$CLAIM_SESSION_ID"
elif [ -n "${CLAIM_RUN_ID:-}" ]; then
  STATE_DIR="${CLAIM_SESSION_STATE_DIR:-${TMPDIR:-/tmp}}"
  STATE_FILE="${STATE_DIR}/cabros-claim-session-$(printf '%s' "$REPO" | tr '/:' '-')-${AGENT_ID}-${CLAIM_RUN_ID}"
  # The run-scoped ID is stable for the WHOLE run, no expiry. A time-based reuse
  # window would mint a fresh ID for a Step 2 re-check that outlives ~30 min, which
  # would then see the Step 1 claim as a foreign session and RESULT=SKIP (the bug
  # the mtime window introduced). Only a genuinely missing/empty file gets a mint.
  if [ -f "$STATE_FILE" ]; then
    SESSION_ID="$(cat "$STATE_FILE" 2>/dev/null || true)"
  fi
  if [ -z "$SESSION_ID" ]; then
    SESSION_ID="$(gen_session_id)"
    mkdir -p "$STATE_DIR" 2>/dev/null || true
    printf '%s' "$SESSION_ID" > "$STATE_FILE" 2>/dev/null || true
  fi
else
  SESSION_ID="$(gen_session_id)"
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

# has_agent_working -> prints "true" | "false". Returns 1 when the label lookup
# fails so callers can fail closed (a transient `gh issue view` failure must not
# be interpreted as a missing label — that would let a session "claim" an issue
# that is actually owned by another active session).
has_agent_working() {
  local out rc=0
  out="$(gh issue view "$ISSUE_NUMBER" --json labels \
    --jq '[.labels[].name] | index("agent-working") != null' 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    return 1
  fi
  printf '%s\n' "$out"
}

# Read failures must never be mistaken for "no claims" (fail-closed): this
# global records the latest read failure so callers can return RESULT=ERROR
# instead of claiming based on a phantom-empty comment set.
READ_FAILED=""

# claim_comments_rest -> TSV "id<TAB>created_at<TAB>body" for ALL claim comments
# via the REST API (numeric ids, creation order). `created_at` is the comment's
# SERVER-side timestamp (authoritative for legacy/label ordering); the body still
# carries the client's startup NOW_TS but that is NOT used for freshness/ordering
# decisions because it can predate the label event by a second (which would
# corrupt LEGACY_DECIDES). Empty (clean exit, status 0) when no claims exist.
# Paginated so comment pages past the first still reach arbitration. On a read
# failure (nonzero gh exit) it prints nothing and returns 1; callers MUST wrap
# the invocation with `|| READ_FAILED="1"` because the command substitution runs
# in a subshell and cannot rely on the parent global being set inside it.
claim_comments_rest() {
  local out rc=0
  out="$(gh api --paginate "repos/${REPO}/issues/${ISSUE_NUMBER}/comments" --jq '
    [.[] | select(.body | startswith("**agent-claim**"))]
    | .[] | "\(.id)\t\(.created_at)\t\(.body)"' 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    return 1
  fi
  [ -n "$out" ] && printf '%s\n' "$out"
  return 0
}

# newest_claim -> single line "id<TAB>agent<TAB>session<TAB>created_at" for the
# newest claim comment (largest numeric id), or empty when no claim comments
# exist. The returned timestamp is the comment's SERVER-side `created_at`, which
# is the authoritative lifecycle source for the LEGACY_DECIDES comparison —
# comparing against the client-supplied body NOW_TS would falsely mark a normal
# claim as a fresh legacy owner when the claim took >1s. Returns 1 when the
# read fails so callers can fail closed via `|| READ_FAILED=1`.
newest_claim() {
  local newest
  newest="$(claim_comments_rest | awk -F '\t' '{ if (max == "" || $1+0 > max+0) { max=$1; line=$0 } } END { print line }')" || READ_FAILED="1"
  if [ "$READ_FAILED" == "1" ]; then return 1; fi
  if [ -z "$newest" ]; then return 0; fi
  local created_at rest agent session
  created_at="$(echo "$newest" | cut -f2)"
  rest="$(echo "$newest" | cut -f3 | sed 's/^\*\*agent-claim\*\*:[[:space:]]*//')"
  agent="$(echo "$rest" | awk '{print $1}')"
  session="$(echo "$rest" | awk '{print $2}')"
  printf '%s\t%s\t%s\t%s\n' "$(echo "$newest" | cut -f1)" "$agent" "$session" "$created_at"
  return 0
}

# last_labeled_event_ts -> timestamp of the most recent agent-working labeled
# event (fallback for legacy claims made before claim comments existed). Returns
# 1 when the read fails so legacy handling can fail closed. Uses --slurp so the
# max is computed across ALL paginated pages, never `max`-per-page (which would
# yield multi-line output and make age_minutes return 99999 on fresh claims).
last_labeled_event_ts() {
  local out rc=0
  out="$(gh api --paginate --slurp "repos/${REPO}/issues/${ISSUE_NUMBER}/events" --jq '
    [.[] | .[] | select(.event == "labeled" and .label.name == "agent-working") | .created_at]
    | max // empty' 2>/dev/null)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    return 1
  fi
  [ -n "$out" ] && printf '%s\n' "$out"
  return 0
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
# Echoes "FAIL_CLOSED" when a read-back fails, so a transient read outage never
# turns into a phantom win. Reads back up to 3 times so concurrent claims
# surface despite API lag.
arbitrate_race() {
  local snapshot_id="$1" our_id="$2"
  local winner="$our_id" newer min_id rc
  for _ in 1 2 3; do
    newer="$(claim_comments_rest | awk -F '\t' -v snap="$snapshot_id" '$1+0 > snap+0 { print $1 }')" || READ_FAILED="1"
    if [ "$READ_FAILED" == "1" ]; then
      echo "FAIL_CLOSED"
      return 0
    fi
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
SNAPSHOT_ID="$(newest_claim | cut -f1)" || READ_FAILED="1"
if [ "$READ_FAILED" == "1" ]; then
  echo "RESULT=ERROR"
  echo "Error: could not read claim comments to snapshot the claim state (fail-closed)." >&2
  exit 1
fi
SNAPSHOT_ID="${SNAPSHOT_ID:-0}"

# ---------------------------------------------------------------------------
# 1) Issue already carries the agent-working label -> resolve the claim.
# ---------------------------------------------------------------------------
LABELED=""
LABELED="$(has_agent_working)" || READ_FAILED="1"
if [ "$READ_FAILED" == "1" ]; then
  echo "RESULT=ERROR"
  echo "Error: could not read the labels of issue #${ISSUE_NUMBER} to check for an active agent-working claim (fail-closed)." >&2
  exit 1
fi
if [ "$LABELED" == "true" ]; then
  NEWEST="$(newest_claim)" || READ_FAILED="1"
  if [ "$READ_FAILED" == "1" ]; then
    echo "RESULT=ERROR"
    echo "Error: issue #${ISSUE_NUMBER} is labeled agent-working but claim comments could not be read (fail-closed)." >&2
    exit 1
  fi

  # The label may have been re-attached AFTER the newest claim comment (a
  # legacy lifecycle re-claims by re-labeling without a new comment). When the
  # newest labeled event post-dates the newest comment, the comment belongs to
  # an earlier lifecycle and the labeled event is the authoritative freshness
  # source; otherwise a stale historical comment would trigger a premature
  # takeover of a fresh legacy claim.
  LEGACY_TS="$(last_labeled_event_ts)" || READ_FAILED="1"
  if [ "$READ_FAILED" == "1" ]; then
    echo "RESULT=ERROR"
    echo "Error: could not read the labeled-event history for issue #${ISSUE_NUMBER} (fail-closed)." >&2
    exit 1
  fi
  LEGACY_DECIDES=""
  if [ -n "$NEWEST" ] && [ -n "$LEGACY_TS" ]; then
    NEWEST_E="$(epoch_of "$(echo "$NEWEST" | cut -f4)")"
    LEGACY_E="$(epoch_of "$LEGACY_TS")"
    if [ -n "$NEWEST_E" ] && [ -n "$LEGACY_E" ] && [ "$LEGACY_E" -gt "$NEWEST_E" ]; then
      LEGACY_DECIDES="1"
    fi
  fi

  if [ -n "$NEWEST" ] && [ -z "$LEGACY_DECIDES" ]; then
    NEWEST_ID="$(echo "$NEWEST" | cut -f1)"
    NEWEST_AGENT="$(echo "$NEWEST" | cut -f2)"
    NEWEST_SESSION="$(echo "$NEWEST" | cut -f3)"
    NEWEST_TS="$(echo "$NEWEST" | cut -f4)"

    if [ "$NEWEST_AGENT" == "$AGENT_ID" ] && [ "$NEWEST_SESSION" == "$SESSION_ID" ]; then
      # Our own claim: renew, then arbitrate the renewal against any concurrent
      # takeover. Post-and-arbitrate keeps the protocol uniform: if a taker
      # lands its comment first (lower id), the renewal loses and we skip.
      RENEWAL_ID="$(post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS}")"
      if [ -z "$RENEWAL_ID" ]; then
        echo "RESULT=ERROR"
        echo "Error: failed to post the renewal claim comment on issue #${ISSUE_NUMBER}." >&2
        exit 1
      fi
      WINNER="$(arbitrate_race "$NEWEST_ID" "$RENEWAL_ID")"
      if [ "$WINNER" == "FAIL_CLOSED" ]; then
        echo "RESULT=ERROR"
        echo "Error: could not re-read claim comments to confirm the renewal (fail-closed)." >&2
        exit 1
      fi
      if [ "$WINNER" != "$RENEWAL_ID" ]; then
        delete_claim_comment "$RENEWAL_ID"
        echo "RESULT=SKIP"
        echo "Issue #${ISSUE_NUMBER}: renewal raced by a concurrent takeover (comment ${WINNER} won). Skipping — zero-work, no budget consumed."
        exit 2
      fi
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
    if [ "$WINNER" == "FAIL_CLOSED" ]; then
      echo "RESULT=ERROR"
      echo "Error: could not re-read claim comments to arbitrate the takeover (fail-closed)." >&2
      exit 1
    fi
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

  # Legacy lifecycle: no claim comments OR the newest labeled event post-dates
  # the newest claim comment (LEGACY_DECIDES above). The labeled event is the
  # authoritative freshness source for both cases.
  if [ -n "$LEGACY_TS" ]; then
    AGE="$(age_minutes "$LEGACY_TS")"
    if [ "$AGE" -le "$TTL_MINUTES" ]; then
      echo "RESULT=SKIP"
      echo "Issue #${ISSUE_NUMBER} carries agent-working (legacy claim, ${AGE} min ago). Skipping — zero-work, no budget consumed."
      exit 2
    fi
  fi

  # Legacy takeover: arbitrate from SNAPSHOT_ID (the newest claim id at the
  # start, 0 when none existed) so a stale historical comment from an earlier
  # lifecycle can never win the race that follows; only comments posted DURING
  # this takeover participate.
  OUR_LEGACY_ID="$(post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS} (takeover of legacy agent-working)")"
  if [ -z "$OUR_LEGACY_ID" ]; then
    echo "RESULT=ERROR"
    echo "Error: failed to post the takeover claim comment on issue #${ISSUE_NUMBER}." >&2
    exit 1
  fi
  WINNER="$(arbitrate_race "$SNAPSHOT_ID" "$OUR_LEGACY_ID")"
  if [ "$WINNER" == "FAIL_CLOSED" ]; then
    echo "RESULT=ERROR"
    echo "Error: could not re-read claim comments to arbitrate the legacy takeover (fail-closed)." >&2
    exit 1
  fi
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
  # When the read fails we cannot prove no rival claimed, so we keep the label
  # and fail closed instead of silently removing a concurrent claim.
  NEWER_COUNT="$(claim_comments_rest | awk -F '\t' -v snap="$SNAPSHOT_ID" '$1+0 > snap+0 { print $1 }')" || READ_FAILED="1"
  if [ "$READ_FAILED" == "1" ]; then
    echo "RESULT=ERROR"
    echo "Error: failed to post the claim comment and could not re-read comments to roll back safely (fail-closed)." >&2
    exit 1
  fi
  if [ -z "$NEWER_COUNT" ]; then
    remove_agent_working
  fi
  echo "RESULT=ERROR"
  echo "Error: failed to post the claim comment on issue #${ISSUE_NUMBER}." >&2
  exit 1
fi

WINNER_ID="$(arbitrate_race "$SNAPSHOT_ID" "$OUR_ID")"

if [ "$WINNER_ID" == "FAIL_CLOSED" ]; then
  echo "RESULT=ERROR"
  echo "Error: could not re-read claim comments to arbitrate the claim (fail-closed)." >&2
  exit 1
fi

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
