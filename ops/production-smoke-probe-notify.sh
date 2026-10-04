#!/usr/bin/env bash
# production-smoke-probe-notify.sh
#
# Decides whether a smoke-probe run warrants paging the Telegram admin chat and
# sends that page.
#
# The probe workflow used to emit one indistinguishable warning for every
# possible problem: a missing repository checkout, an unconfigured secret, a
# stale deploy and a genuinely unreachable production endpoint all looked
# alike. Paging on all of those trains operators to ignore the one signal that
# matters, so only a confirmed outage pages. Everything else is annotated so the
# run log states plainly which kind of failure occurred.
#
# Outcomes and their page policy:
#   ok              healthy; clears the cooldown latch
#   down            production unreachable or unhealthy; PAGES
#   stale           service.commit != expected commit (deploy in flight)
#   degraded        a required dependency is not ready
#   unconfigured    the probe never ran: WEBHOOK_API_KEY secret missing
#   script_missing  the probe never ran: script absent from the workspace
#   invalid_args    the probe was called with bad arguments
#   unknown         unclassified non-zero probe exit
#
# Required env:
#   PROBE_OUTCOME   one of the outcomes above
#
# Optional env:
#   PROBE_DETAIL               safe one-line probe failure detail (never secrets)
#   PROBE_EXIT                 numeric probe exit code, for the operator message
#   PROBE_BASE_URL             probe target, for the operator message
#   PROBE_RUN_URL              workflow run URL
#   PROBE_COOLDOWN_MINUTES     repeat-page suppression window (default 60)
#   PROBE_COOLDOWN_STATE_FILE  path holding `last_page_epoch=<unix seconds>`
#   PROBE_PAGE_TIMEOUT         curl --max-time in seconds (default 15)
#   TELEGRAM_BOT_TOKEN         admin-notifications bot token
#   TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID   target chat id
#
# Status line (stdout and, when set, $GITHUB_OUTPUT):
#   probe_page=not_required | no_page_expected | not_configured |
#              suppressed_cooldown | paged | page_failed
#
# Always exits 0. Paging is a side effect of the probe's own pass/fail decision;
# a page that cannot be delivered must not change whether the job passed. The
# probe step owns job failure, so this script reports through annotations.

set -euo pipefail

OUTCOME="${PROBE_OUTCOME:-}"
DETAIL="${PROBE_DETAIL:-}"
PROBE_EXIT="${PROBE_EXIT:-}"
BASE_URL="${PROBE_BASE_URL:-}"
RUN_URL="${PROBE_RUN_URL:-}"
PAGE_TIMEOUT="${PROBE_PAGE_TIMEOUT:-15}"
DEFAULT_COOLDOWN_MINUTES=60
STATE_FILE="${PROBE_COOLDOWN_STATE_FILE:-}"

report() {
	printf 'probe_page=%s\n' "$1"
	if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
		printf 'probe_page=%s\n' "$1" >>"$GITHUB_OUTPUT"
	fi
}

# The Bot API embeds the token in the request URL, so every byte curl or
# Telegram hands back can carry it. Redact by literal replacement rather than a
# pattern so no credential characters are treated as regex metacharacters.
redact() {
	local text="$1"
	if [[ -n "${TELEGRAM_BOT_TOKEN:-}" ]]; then
		text="${text//"$TELEGRAM_BOT_TOKEN"/[redacted]}"
	fi
	if [[ -n "${TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID:-}" ]]; then
		text="${text//"$TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID"/[redacted]}"
	fi
	printf '%s' "$text"
}

read_latched_epoch() {
	if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
		local raw
		raw="$(sed -n 's/^last_page_epoch=\([0-9]\{1,\}\)$/\1/p' "$STATE_FILE" | head -n 1)"
		if [[ "$raw" =~ ^[0-9]+$ ]]; then
			printf '%s' "$raw"
			return 0
		fi
	fi
	printf '0'
}

write_state() {
	if [[ -z "$STATE_FILE" ]]; then
		return 0
	fi
	mkdir -p "$(dirname "$STATE_FILE")"
	printf 'last_page_epoch=%s\n' "$1" >"$STATE_FILE"
}

annotate_non_outage() {
	case "$1" in
	unconfigured)
		printf '::error title=Probe not configured::probe_unconfigured: %s The probe never reached production, so this is a CI misconfiguration, not a production outage. Set the WEBHOOK_API_KEY repository secret.\n' "${DETAIL:-WEBHOOK_API_KEY is not set.}"
		;;
	script_missing)
		printf '::error title=Probe script missing::probe_script_missing: %s This is a bug in the CI workflow (the repository was not checked out), not a production outage. The availability gate did not run.\n' "${DETAIL:-ops/production-smoke-probe.sh was not found in the workspace.}"
		;;
	invalid_args)
		printf '::error title=Probe invocation invalid::probe_invalid_args: %s This is a bug in the CI workflow, not a production outage.\n' "${DETAIL:-the probe rejected its arguments.}"
		;;
	degraded)
		printf '::warning title=Dependency degraded::probe_degraded: %s Production is reachable but a required dependency is not ready. This is not a page-level outage.\n' "${DETAIL:-a required dependency is not ready.}"
		;;
	stale)
		printf '::warning title=Stale deployment::probe_stale: %s Production is serving a different commit than master. Expected during a rollout; not a page-level outage.\n' "${DETAIL:-service.commit does not match the expected commit.}"
		;;
	*)
		printf '::warning title=Smoke probe failed::probe_unknown: %s The probe exited non-zero with an unclassified outcome; production reachability is unknown.\n' "${DETAIL:-the probe exited non-zero.}"
		;;
	esac
}

build_page_payload() {
	local text="PRODUCTION DOWN - automated smoke probe failed

Outcome: ${OUTCOME}"
	if [[ -n "$PROBE_EXIT" ]]; then
		text="${text}
Probe exit: ${PROBE_EXIT}"
	fi
	if [[ -n "$DETAIL" ]]; then
		text="${text}
Detail: ${DETAIL}"
	fi
	if [[ -n "$BASE_URL" ]]; then
		text="${text}
Target: ${BASE_URL}"
	fi
	if [[ -n "$RUN_URL" ]]; then
		text="${text}
Run: ${RUN_URL}"
	fi
	text="${text}

Alerts are not being delivered while this persists. Treat as an incident."
	jq -rn \
		--arg text "$text" \
		--arg chat_id "$TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID" \
		'{
			chat_id: ($chat_id | tonumber? // $chat_id),
			text: $text,
			disable_web_page_preview: true
		}'
}

send_page() {
	local payload body_file err_file http_code rc
	body_file="$(mktemp -t cabros-page-body-XXXXXX)"
	err_file="$(mktemp -t cabros-page-err-XXXXXX)"
	payload="$(build_page_payload)"

	set +e
	http_code="$(printf '%s' "$payload" | curl \
		--silent \
		--max-time "$PAGE_TIMEOUT" \
		--request POST \
		--output "$body_file" \
		--write-out '%{http_code}' \
		--header 'content-type: application/json' \
		--data-binary @- \
		"https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
		2>"$err_file")"
	rc=$?
	set -e

	if [[ "$rc" -ne 0 ]]; then
		printf '::warning title=Operator page not delivered::page_failed: Bot API request failed (curl exit %s). %s\n' \
			"$rc" "$(redact "$(<"$err_file")")"
		rm -f "$body_file" "$err_file"
		return 1
	fi

	if [[ ! "$(<"$body_file")" =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; then
		printf '::warning title=Operator page not delivered::page_failed: Telegram rejected the request (HTTP %s). %s\n' \
			"${http_code:-unknown}" "$(redact "$(<"$body_file")")"
		rm -f "$body_file" "$err_file"
		return 1
	fi

	rm -f "$body_file" "$err_file"
	return 0
}

if [[ -z "$OUTCOME" ]]; then
	printf '::warning title=Smoke probe notification::probe_outcome_missing: PROBE_OUTCOME was not set; no page was attempted.\n'
	annotate_non_outage unknown
	report no_page_expected
	write_state "$(read_latched_epoch)"
	exit 0
fi

if [[ "$OUTCOME" == "ok" ]]; then
	report not_required
	write_state 0
	exit 0
fi

if [[ "$OUTCOME" != "down" ]]; then
	annotate_non_outage "$OUTCOME"
	report no_page_expected
	write_state "$(read_latched_epoch)"
	exit 0
fi

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID:-}" ]]; then
	printf '::warning title=Paging not configured::paging_not_configured: production is down but TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID are not both configured, so no operator page was sent. The GitHub Actions failure is the only signal.\n'
	if [[ -n "$DETAIL" ]]; then
		printf '::warning title=Production down::%s\n' "$(redact "$DETAIL")"
	fi
	report not_configured
	write_state "$(read_latched_epoch)"
	exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
	printf '::warning title=Operator page not delivered::page_failed: jq is required to build the page payload.\n'
	report page_failed
	write_state 0
	exit 0
fi

COOLDOWN_MINUTES="$DEFAULT_COOLDOWN_MINUTES"
if [[ -n "${PROBE_COOLDOWN_MINUTES:-}" ]]; then
	if [[ "$PROBE_COOLDOWN_MINUTES" =~ ^[0-9]+$ ]]; then
		COOLDOWN_MINUTES="$PROBE_COOLDOWN_MINUTES"
	else
		printf '::warning::PROBE_COOLDOWN_MINUTES=%s is not a non-negative integer; falling back to %s.\n' \
			"$PROBE_COOLDOWN_MINUTES" "$DEFAULT_COOLDOWN_MINUTES"
	fi
fi

LAST_PAGE_EPOCH="$(read_latched_epoch)"
NOW_EPOCH="$(date +%s)"
ELAPSED_MINUTES=$(((NOW_EPOCH - LAST_PAGE_EPOCH) / 60))

if ((LAST_PAGE_EPOCH > 0 && ELAPSED_MINUTES < COOLDOWN_MINUTES)); then
	printf '::warning title=Paging suppressed::paging_suppressed_cooldown: production is down but a page was already sent %s minute(s) ago; the next page is suppressed for another %s minute(s) (PROBE_COOLDOWN_MINUTES=%s).\n' \
		"$ELAPSED_MINUTES" "$((COOLDOWN_MINUTES - ELAPSED_MINUTES))" "$COOLDOWN_MINUTES"
	report suppressed_cooldown
	write_state "$LAST_PAGE_EPOCH"
	exit 0
fi

if send_page; then
	printf 'Paged the Telegram admin chat about the production outage.\n'
	report paged
	write_state "$NOW_EPOCH"
	exit 0
fi

report page_failed
write_state 0
exit 0