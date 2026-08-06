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
# Renewal behavior (reducing comment noise):
#   When a session re-checks its own claim (periodic renewal, Step 2 re-check,
#   etc.), the existing claim comment is edited **in-place** via REST PATCH
#   rather than posting a new comment. The original comment ID is preserved so
#   the lower-ID-wins arbitration semantic is unaffected. The comment body gains
#   a "(renewed N times, last: ISO-8601)" suffix to retain the audit trail.
#   If the in-place PATCH fails transiently, a new fallback comment is posted
#   and arbitrated normally (same as before) so the run is never blocked on a
#   transient API error. Takeover paths always post new comments (needed for race
#   arbitration against concurrent sessions).
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

# Resolve the authenticated automation user ("francovp" after switching). Claim
# comments MUST be recognized by this author: a body-prefix-only filter would
# let any user who can comment on issues post a forged "**agent-claim**" comment
# that becomes the newest claim, blocking the real owner and every later session
# until the TTL expires (P2 finding: authenticate claim comments). Fail closed
# when the login cannot be resolved — accepting every commenter's claims would
# let human comments derail arbitration.
AUTHOR_LOGIN="$(gh api user --jq .login 2>/dev/null || true)"
if [ -z "$AUTHOR_LOGIN" ]; then
  echo "RESULT=ERROR"
  echo "Error: could not resolve the authenticated gh login to authenticate claim comments (fail-closed)." >&2
  exit 1
fi
export CLAIM_AUTHOR_LOGIN="$AUTHOR_LOGIN"

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
    # The run-scoped session id MUST survive across every Step N invocation of
    # the same run; otherwise the next call would mint a fresh id, see this Step 1
    # claim as a foreign session, and RESULT=SKIP (abandoning the run to the TTL).
    # Fail closed when the id cannot be durably persisted and read back.
    if ! mkdir -p "$STATE_DIR" 2>/dev/null; then
      echo "RESULT=ERROR"
      echo "Error: could not create the run-scoped session state dir ${STATE_DIR} (fail-closed)." >&2
      exit 1
    fi
    if ! printf '%s' "$SESSION_ID" > "$STATE_FILE" 2>/dev/null; then
      echo "RESULT=ERROR"
      echo "Error: could not persist the run-scoped session id to ${STATE_FILE} (fail-closed)." >&2
      exit 1
    fi
    if [ "$(cat "$STATE_FILE" 2>/dev/null || true)" != "$SESSION_ID" ]; then
      echo "RESULT=ERROR"
      echo "Error: run-scoped session id not readable back after persist at ${STATE_FILE} (fail-closed)." >&2
      exit 1
    fi
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
# authored by the automation user (CLAIM_AUTHOR_LOGIN). Only comments whose
# .user.login matches the actor count as claims — a body-prefix-only filter
# would let any issue commenter forge a "**agent-claim**" comment and become
# the newest claim. Enabled via the exported CLAIM_AUTHOR_LOGIN (resolved from
# `gh api user`).
claim_comments_rest() {
  local out rc=0
  out="$(gh api --paginate "repos/${REPO}/issues/${ISSUE_NUMBER}/comments" --jq "
    [.[] | select(.body | startswith(\"**agent-claim**\")) | select(.user.login == \"${CLAIM_AUTHOR_LOGIN}\")]
    | .[] | \"\(.id)\t\(.created_at)\t\(.body)\"" 2>/dev/null)" || rc=$?
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
# newest_claim -> single line "id<TAB>agent<TAB>session<TAB>created_at<TAB>freshness_ts<TAB>body" for the
# newest claim comment (largest numeric id), or empty when no claim comments
# exist. `freshness_ts` is the most recent of created_at and the body's
# "last: ISO-8601" renewal timestamp — used for TTL staleness checks so a
# PATCH-renewed claim is not incorrectly treated as stale. The returned
# created_at is the server-side creation time (authoritative for the
# LEGACY_DECIDES comparison). `body` is the raw comment body (tab-escaped),
# used by extract_renewal_count to read the renewal counter. Returns 1 on error.
newest_claim() {
  local newest
  newest="$(claim_comments_rest | awk -F '\t' '{ if (max == "" || $1+0 > max+0) { max=$1; line=$0 } } END { print line }')" || READ_FAILED="1"
  if [ "$READ_FAILED" == "1" ]; then return 1; fi
  if [ -z "$newest" ]; then return 0; fi
  local created_at rest agent session body_ts freshness_ts raw_body
  created_at="$(echo "$newest" | cut -f2)"
  raw_body="$(echo "$newest" | cut -f3)"
  rest="$(printf '%s' "$raw_body" | sed 's/^\*\*agent-claim\*\*:[[:space:]]*//')"
  agent="$(echo "$rest" | awk '{print $1}')"
  session="$(echo "$rest" | awk '{print $2}')"
  # Extract the "last: ISO-8601" renewal timestamp from the body, if present.
  body_ts="$(printf '%s' "$rest" | sed -n 's/.*last: \([0-9T:Z-]*\).*/\1/p' | head -1)"
  # Use the more recent of created_at and body_ts as the freshness timestamp.
  if [ -n "$body_ts" ]; then
    local ca_e bt_e
    ca_e="$(epoch_of "$created_at")"
    bt_e="$(epoch_of "$body_ts")"
    if [ -n "$ca_e" ] && [ -n "$bt_e" ] && [ "$bt_e" -gt "$ca_e" ]; then
      freshness_ts="$body_ts"
    else
      freshness_ts="$created_at"
    fi
  else
    freshness_ts="$created_at"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(echo "$newest" | cut -f1)" "$agent" "$session" "$created_at" "$freshness_ts" "$raw_body"
  return 0
}

# last_labeled_event_ts -> timestamp of the most recent agent-working labeled
# event (fallback for legacy claims made before claim comments existed). Returns
# 1 when the read fails so legacy handling can fail closed. Uses --slurp so the
# max is computed across ALL paginated pages, never `max`-per-page (which would
# yield multi-line output and make age_minutes return 99999 on fresh claims).
last_labeled_event_ts() {
  local out rc=0
  out="$(gh api --paginate "repos/${REPO}/issues/${ISSUE_NUMBER}/events" 2>/dev/null |
    jq -r -s '[.[][] | select(.event == "labeled" and .label.name == "agent-working") | .created_at]
      | max // empty')" || rc=$?
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

# update_claim_comment <comment_id> <new_body> -> 0 on success, 1 on failure.
# Edits an existing claim comment in-place via PATCH so renewals do not post new
# comments. The comment ID stays the same, so arbitration order is preserved.
update_claim_comment() {
  local cid="$1" new_body="$2"
  gh api -X PATCH "repos/${REPO}/issues/comments/${cid}" -f body="$new_body" &>/dev/null
}

# extract_renewal_count <comment_body> -> integer count of prior renewals (0 if none)
extract_renewal_count() {
  local body="$1" count
  # Match "(renewed N times, ...)"
  count="$(printf '%s' "$body" | sed -n 's/.*renewed \([0-9]*\) time.*/\1/p' | head -1)"
  echo "${count:-0}"
}

# delete_claim_comment <comment_id> — authoritative cleanup of a lost race comment.
# Returns 0 only when the DELETE actually succeeded (after bounded retries).
# When we lose a race we MUST be able to remove our comment: a higher-ID loser left
# in place becomes `newest_claim`, so a later ownership check treats the session
# that already exited RESULT=SKIP as the active owner and the real winner stays
# blocked until the TTL expires. On failure the caller must fail closed
# (RESULT=ERROR) rather than a clean RESULT=SKIP.
delete_claim_comment() {
  local cid="$1" attempt=0
  while [ "$attempt" -lt 3 ]; do
    if gh api -X DELETE "repos/${REPO}/issues/comments/${cid}" &> /dev/null; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  return 1
}

# lose_race <comment_id> <reason...> — handle a lost race: remove our comment
# authoritatively and exit RESULT=SKIP (2). If the loser comment cannot be
# removed after retries, fail closed to RESULT=ERROR (1): leaving the higher-ID
# loser as `newest_claim` would make a later ownership check treat this exited
# SKIP session as the active owner and block the real winner until the TTL.
lose_race() {
  local cid="$1"; shift
  if ! delete_claim_comment "$cid"; then
    echo "RESULT=ERROR"
    echo "Error: lost the race but could not remove our claim comment ${cid} (cleanup fail-closed)." >&2
    exit 1
  fi
  echo "RESULT=SKIP"
  echo "$*"
  exit 2
}

# remove_agent_working — best-effort label removal (used only when this script
# knows no other session holds a valid claim).
remove_agent_working() {
  gh issue edit "$ISSUE_NUMBER" --remove-label "agent-working" &> /dev/null || true
}

# rollback_abandoned_claim <comment_id> <label_was_ours> <snapshot_id> <context...>
# Removes a claim comment we JUST posted when arbitration could not complete
# (FAIL_CLOSED), then safely reconciles the shared agent-working label:
#   - label_was_ours=true  (unclaimed-issue claim: WE added the label this run)
#     -> remove it UNLESS a concurrent claimant's comment (newer than the
#        snapshot) has landed; then the label belongs to that in-progress
#        claimant and stays.
#   - label_was_ours=false (renewal / takeover paths: label pre-existed) -> the
#     label is left untouched; removing it could destroy a claim characteristic
#     of another session. Only the unconfirmed comment is rolled back.
# Best-effort cleanup: the caller still exits RESULT=ERROR (fail-closed), because
# the arbitration read failed and we cannot safely claim ownership.
rollback_abandoned_claim() {
  local cid="$1" label_ours="$2" snap="$3"; shift 3
  local context="$*"
  if ! delete_claim_comment "$cid"; then
    echo "Error: arbitration failed (${context}); could not remove our claim comment ${cid} (rollback fail-closed)." >&2
    return 0
  fi
  if [ "$label_ours" == "true" ]; then
    # Best-effort final read: if a concurrent claimant's comment landed after our
    # snapshot, the shared label is theirs — keep it. Otherwise the label is
    # stale evidence of our abandoned claim; remove it so the issue stays claimable.
    local remaining rc=0
    remaining="$(claim_comments_rest | awk -F '\t' -v snap="$snap" '$1+0 > snap+0 { print $1 }')" || rc=$?
    if [ "$rc" -eq 0 ] && [ -z "$remaining" ]; then
      remove_agent_working
    fi
  fi
  echo "Rolled back abandoned claim comment ${cid} (${context} fail-closed)." >&2
  return 0
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
    NEWEST_TS="$(echo "$NEWEST" | cut -f4)"       # server-side created_at
    FRESHNESS_TS="$(echo "$NEWEST" | cut -f5)"    # most recent of created_at and body last-renewal ts
    # Fall back to created_at when the 5th field is absent (older claim format).
    : "${FRESHNESS_TS:=$NEWEST_TS}"

    if [ "$NEWEST_AGENT" == "$AGENT_ID" ] && [ "$NEWEST_SESSION" == "$SESSION_ID" ]; then
      # Our own claim: renew by editing the existing comment in-place (PATCH).
      # This avoids posting a new comment per renewal, reducing history noise.
      # The original comment ID (NEWEST_ID) is preserved, so arbitration order
      # and the lower-ID-wins semantic are unaffected.
      #
      # Concurrent takeover race (P1): a taker may read the stale comment
      # (FRESHNESS_TS >= TTL), post a new comment with ID > NEWEST_ID, and win
      # arbitration — all while we are between the agent/session match and the
      # PATCH. After a successful PATCH we therefore re-read comments and verify
      # no newer claim comment landed. If one did, the taker won; we exit
      # RESULT=SKIP so the real owner continues without a duplicate claimant.
      NEWEST_BODY="$(echo "$NEWEST" | cut -f6)"
      PRIOR_RENEWALS="$(extract_renewal_count "$NEWEST_BODY")"
      NEW_RENEWAL_COUNT=$(( PRIOR_RENEWALS + 1 ))
      RENEWAL_BODY="${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NEWEST_TS} (renewed ${NEW_RENEWAL_COUNT} time(s), last: ${NOW_TS})"
      if ! update_claim_comment "$NEWEST_ID" "$RENEWAL_BODY"; then
        # In-place update failed (e.g. rate limit, transient API error). Fall
        # back to posting a new comment so the run is not blocked on a transient
        # failure. This is the only path that can still add a new comment during
        # renewal — kept deliberately to ensure the run survives transient errors.
        RENEWAL_ID="$(post_claim_comment "${CLAIM_PREFIX} ${AGENT_ID} ${SESSION_ID} ${NOW_TS} (renewal fallback)")"
        if [ -z "$RENEWAL_ID" ]; then
          echo "RESULT=ERROR"
          echo "Error: failed to renew the claim comment on issue #${ISSUE_NUMBER} (both PATCH and POST failed)." >&2
          exit 1
        fi
        WINNER="$(arbitrate_race "$NEWEST_ID" "$RENEWAL_ID")"
        if [ "$WINNER" == "FAIL_CLOSED" ]; then
          rollback_abandoned_claim "$RENEWAL_ID" "false" "$NEWEST_ID" "renewal-fallback"
          echo "RESULT=ERROR"
          echo "Error: could not confirm the renewal fallback comment; rolled back (fail-closed)." >&2
          exit 1
        fi
        if [ "$WINNER" != "$RENEWAL_ID" ]; then
          lose_race "$RENEWAL_ID" "Issue #${ISSUE_NUMBER}: renewal-fallback raced by a concurrent takeover (comment ${WINNER} won). Skipping — zero-work, no budget consumed."
        fi
      else
        # PATCH succeeded. Re-read comments to detect any concurrent takeover
        # comment that landed after our agent/session match (P1 race). If a
        # comment with ID > NEWEST_ID appeared and belongs to another session,
        # the taker has won — exit RESULT=SKIP so the real owner continues.
        post_patch_newer=""
        rc_pp=0
        post_patch_newer="$(claim_comments_rest | awk -F '\t' -v snap="$NEWEST_ID" '$1+0 > snap+0 { print $1 }')" || rc_pp=1
        if [ "$rc_pp" -ne 0 ]; then
          # Cannot verify — fail closed; the PATCH edit is already applied but
          # we cannot confirm ownership. Exit ERROR so the caller retries.
          echo "RESULT=ERROR"
          echo "Error: PATCH renewal succeeded but post-PATCH comment re-read failed (fail-closed)." >&2
          exit 1
        fi
        if [ -n "$post_patch_newer" ]; then
          # A newer claim comment appeared: a concurrent takeover beat us.
          # The PATCH only updated the body; the taker's higher-ID comment is
          # now the authoritative claim. Yield to the taker.
          echo "RESULT=SKIP"
          echo "Issue #${ISSUE_NUMBER}: concurrent takeover comment appeared during PATCH renewal (comment IDs: ${post_patch_newer}). Skipping — zero-work, no budget consumed."
          exit 2
        fi
      fi
      echo "RESULT=CLAIMED"
      echo "Issue #${ISSUE_NUMBER} already claimed by this session (${AGENT_ID}/${SESSION_ID}); renewed."
      exit 0
    fi

    # Use freshness_ts (body renewal ts or created_at, whichever is newer) for
    # the TTL staleness check so PATCH-renewed claims are not wrongly taken over.
    AGE="$(age_minutes "$FRESHNESS_TS")"
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
      rollback_abandoned_claim "$OUR_TAKEOVER_ID" "false" "$NEWEST_ID" "takeover"
      echo "RESULT=ERROR"
      echo "Error: could not re-read claim comments to arbitrate the takeover; our takeover comment was rolled back (fail-closed)." >&2
      exit 1
    fi
    if [ "$WINNER" != "$OUR_TAKEOVER_ID" ]; then
      lose_race "$OUR_TAKEOVER_ID" "Issue #${ISSUE_NUMBER}: takeover raced by another session (comment ${WINNER} won). Skipping — zero-work, no budget consumed."
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
    rollback_abandoned_claim "$OUR_LEGACY_ID" "false" "$SNAPSHOT_ID" "legacy takeover"
    echo "RESULT=ERROR"
    echo "Error: could not re-read claim comments to arbitrate the legacy takeover; our takeover comment was rolled back (fail-closed)." >&2
    exit 1
  fi
  if [ "$WINNER" != "$OUR_LEGACY_ID" ]; then
    lose_race "$OUR_LEGACY_ID" "Issue #${ISSUE_NUMBER}: legacy takeover raced by another session (comment ${WINNER} won). Skipping — zero-work, no budget consumed."
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
  # Comment failure: the label is already on the issue but our claim comment never
  # landed. We re-read comments up to 3 times (mirroring arbitrate_race's grace
  # window) so a concurrent claimant that is between adding the shared label and
  # posting its own comment surfaces. We then RETAIN the shared agent-working label
  # regardless: a bounded grace window cannot conclusively exclude an in-progress
  # claimant (its comment may land after our window closes), so removing the label
  # could delete that claimant's in-progress claim and let a third session treat
  # the issue as unclaimed. A shared label is the authoritative pending-ownership
  # marker and is reclaimed via the TTL takeover path if it is genuinely abandoned.
  for _ in 1 2 3; do
    NEWER_COUNT="$(claim_comments_rest | awk -F '\t' -v snap="$SNAPSHOT_ID" '$1+0 > snap+0 { print $1 }')" || READ_FAILED="1"
    if [ "$READ_FAILED" != "1" ] && [ -n "$NEWER_COUNT" ]; then
      break
    fi
    sleep 1
  done
  echo "RESULT=ERROR"
  echo "Error: failed to post the claim comment on issue #${ISSUE_NUMBER}; agent-working label retained because a concurrent claimant may be in progress (fail-closed)." >&2
  exit 1
fi

WINNER_ID="$(arbitrate_race "$SNAPSHOT_ID" "$OUR_ID")"

if [ "$WINNER_ID" == "FAIL_CLOSED" ]; then
  rollback_abandoned_claim "$OUR_ID" "true" "$SNAPSHOT_ID" "claim"
  echo "RESULT=ERROR"
  echo "Error: could not re-read claim comments to arbitrate the claim; our claim comment was rolled back (fail-closed)." >&2
  exit 1
fi

if [ "$WINNER_ID" == "$OUR_ID" ]; then
  echo "RESULT=CLAIMED"
  echo "Issue #${ISSUE_NUMBER} claimed by ${AGENT_ID}/${SESSION_ID}."
  exit 0
fi

# Lost the race: another session claimed first. Remove our comment authoritatively
# and skip; if the loser comment cannot be removed, fail closed to ERROR.
lose_race "$OUR_ID" "Issue #${ISSUE_NUMBER} was claimed first by another session (comment ${WINNER_ID}). Skipping — zero-work, no budget consumed."
