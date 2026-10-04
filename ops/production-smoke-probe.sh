#!/usr/bin/env bash
# production-smoke-probe.sh
#
# Smoke-probes a deployed Cabros Bot service after a production deploy.
# Reads the deployment status from `service.commit` (reported by /api/status)
# and verifies the service is reachable, healthy, and reporting the latest
# commit on the configured branch. Optional degraded-dependency and expected-
# commit checks catch stale or broken deployments.
#
# Auth: WEBHOOK_API_KEY is sent via the `x-api-key` header. The script never
# echoes the value in URLs, query strings, logs, or job summaries; it pipes
# the header into curl through stdin (matching the established pattern in
# `.agents/skills/detect-unused-features/scripts/fetch-capabilities.sh`).
#
# Exit codes:
#   0   probe succeeded (service reachable + healthy + commit matches)
#   2   AUTH_BLOCKED — WEBHOOK_API_KEY missing or empty
#   3   HEALTHCHECK_FAILED — /healthcheck did not return HTTP 200
#   4   STATUS_UNREACHABLE — /api/status failed, returned non-JSON, or returned
#                            a non-200 other than 401/403
#   5   COMMIT_MISMATCH — service.commit != expected commit (stale deploy)
#   6   DEGRADED_DEPENDENCY — at least one required dependency degraded
#   7   AUTH_REJECTED — /api/status returned 401/403: the server answered and
#                       rejected this credential, so the secret is rotated or
#                       mismatched. NOT a production outage
#
# The distinction between exit 4 and exit 7 is load-bearing. Exit 4 means
# production did not answer us, which pages the operator chat; exit 7 means
# production answered and rejected us, which is a CI/secret problem. Collapsing
# the two would page "alerts are not being delivered" while they are.
#
# Usage:
#   ops/production-smoke-probe.sh \
#     [--base-url URL] [--expected-commit SHA] \
#     [--require-ready-deps dep1,dep2,...] \
#     [--status-endpoint /api/status] [--healthcheck-endpoint /healthcheck]
#
# Required env:
#   WEBHOOK_API_KEY   header value sent as `x-api-key`
#
# Optional env:
#   PRODUCTION_BASE_URL       override the probe target (default: Railway production)
#   PRODUCTION_EXPECTED_COMMIT override the expected commit SHA
#   PRODUCTION_REQUIRE_READY_DEPS  comma-separated dependency names that must be ready
#   PRODUCTION_PROBE_TIMEOUT   curl --max-time in seconds (default: 15)

set -euo pipefail

BASE_URL="${PRODUCTION_BASE_URL:-https://cabros-bot-production.up.railway.app}"
EXPECTED_COMMIT="${PRODUCTION_EXPECTED_COMMIT:-}"
REQUIRE_READY_DEPS="${PRODUCTION_REQUIRE_READY_DEPS:-}"
HEALTHCHECK_PATH="/healthcheck"
STATUS_PATH="/api/status"
PROBE_TIMEOUT="${PRODUCTION_PROBE_TIMEOUT:-15}"

print_usage() {
	cat <<'EOF'
Usage: production-smoke-probe.sh [--base-url URL] [--expected-commit SHA] \
	[--require-ready-deps dep1,dep2,...] [--status-endpoint /api/status] \
	[--healthcheck-endpoint /healthcheck]

Required env: WEBHOOK_API_KEY
Optional env: PRODUCTION_BASE_URL, PRODUCTION_EXPECTED_COMMIT,
              PRODUCTION_REQUIRE_READY_DEPS, PRODUCTION_PROBE_TIMEOUT
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--base-url)
			BASE_URL="$2"
			shift 2
			;;
		--expected-commit)
			EXPECTED_COMMIT="$2"
			shift 2
			;;
		--require-ready-deps)
			REQUIRE_READY_DEPS="$2"
			shift 2
			;;
		--status-endpoint)
			STATUS_PATH="$2"
			shift 2
			;;
		--healthcheck-endpoint)
			HEALTHCHECK_PATH="$2"
			shift 2
			;;
		-h|--help)
			print_usage
			exit 0
			;;
		*)
			echo "Unknown argument: $1" >&2
			print_usage >&2
			exit 64
			;;
	esac
done

# Sanitize the base URL: never let callers pass secrets in the query string.
case "$BASE_URL" in
	*api-key=*|*x-api-key=*|*token=*)
		echo 'SECRET_LEAK: base URL must not contain credentials.' >&2
		exit 2
		;;
esac

if [[ -z "${WEBHOOK_API_KEY:-}" ]]; then
	echo 'AUTH_BLOCKED: WEBHOOK_API_KEY is not set; cannot probe production.' >&2
	exit 2
fi

# Trim trailing slash so we can safely append endpoint paths.
BASE_URL="${BASE_URL%/}"
HEALTHCHECK_URL="${BASE_URL}${HEALTHCHECK_PATH}"
STATUS_URL="${BASE_URL}${STATUS_PATH}"

PROBE_TMPDIR="$(mktemp -d -t cabros-probe-XXXXXX)"
trap 'rm -rf "$PROBE_TMPDIR"' EXIT

# A failed transfer makes curl exit non-zero *and* still emit its --write-out
# code, so the `|| echo '000'` fallback appends a second 000 and the outage
# renders as "HTTP 000000". Anything not exactly three digits collapses to 000.
normalize_http_code() {
	if [[ ! "$1" =~ ^[0-9]{3}$ ]]; then
		printf '000'
		return
	fi
	printf '%s' "$1"
}

# Step 1: /healthcheck must return HTTP 200. Use -o /dev/null so the body is
# not echoed to job summaries.
HEALTHCHECK_HTTP="$(normalize_http_code "$(printf 'x-api-key: %s\n' "$WEBHOOK_API_KEY" | \
	curl --silent --show-error --max-time "$PROBE_TIMEOUT" \
		--write-out '%{http_code}' --output "$PROBE_TMPDIR/healthcheck.body" \
		-H 'accept: application/json' -H @- "$HEALTHCHECK_URL" || echo '000')")"

if [[ "$HEALTHCHECK_HTTP" != "200" ]]; then
	echo "HEALTHCHECK_FAILED: $HEALTHCHECK_PATH returned HTTP $HEALTHCHECK_HTTP." >&2
	exit 3
fi

# Step 2: /api/status returns the deployment commit and dependency status.
STATUS_HTTP="$(normalize_http_code "$(printf 'x-api-key: %s\n' "$WEBHOOK_API_KEY" | \
	curl --silent --show-error --max-time "$PROBE_TIMEOUT" \
		--write-out '%{http_code}' --output "$PROBE_TMPDIR/status.json" \
		-H 'accept: application/json' -H @- "$STATUS_URL" || echo '000')")"

# A 401/403 means the server is up and answering — it is rejecting *this*
# credential, so the WEBHOOK_API_KEY secret has been rotated or never matched.
# That is a CI/secret problem, and it must not share exit 4 with real
# reachability failures, because exit 4 pages the operator chat.
#
# /healthcheck deliberately has no equivalent branch: it is unauthenticated by
# design, so a 401/403 there is a gateway/server response rather than a
# credential failure and stays a genuine HEALTHCHECK_FAILED.
if [[ "$STATUS_HTTP" == "401" || "$STATUS_HTTP" == "403" ]]; then
	echo "AUTH_REJECTED: $STATUS_PATH returned HTTP $STATUS_HTTP; the WEBHOOK_API_KEY secret does not match the server." >&2
	exit 7
fi

if [[ "$STATUS_HTTP" != "200" ]]; then
	echo "STATUS_UNREACHABLE: $STATUS_PATH returned HTTP $STATUS_HTTP." >&2
	exit 4
fi

if ! command -v jq >/dev/null 2>&1; then
	echo 'STATUS_UNREACHABLE: jq is required to parse the status payload.' >&2
	exit 4
fi

REPORTED_COMMIT="$(jq -r '.service.commit // empty' "$PROBE_TMPDIR/status.json")"
if [[ -z "$REPORTED_COMMIT" ]]; then
	echo 'STATUS_UNREACHABLE: /api/status response did not include service.commit.' >&2
	exit 4
fi

if [[ -n "$EXPECTED_COMMIT" && "$REPORTED_COMMIT" != "$EXPECTED_COMMIT" ]]; then
	echo "COMMIT_MISMATCH: service.commit=$REPORTED_COMMIT expected=$EXPECTED_COMMIT." >&2
	exit 5
fi

if [[ -n "$REQUIRE_READY_DEPS" ]]; then
	DEGRADED_DEPS=""
	OLD_IFS="$IFS"
	IFS=','
	for dep in $REQUIRE_READY_DEPS; do
		dep_trimmed="${dep// /}"
		[[ -z "$dep_trimmed" ]] && continue
		ready="$(jq -r ".dependencies.\"$dep_trimmed\".ready // false" "$PROBE_TMPDIR/status.json")"
		status="$(jq -r ".dependencies.\"$dep_trimmed\".status // \"unknown\"" "$PROBE_TMPDIR/status.json")"
		if [[ "$ready" != "true" ]]; then
			DEGRADED_DEPS="${DEGRADED_DEPS:+$DEGRADED_DEPS,}$dep_trimmed(status=$status)"
		fi
	done
	IFS="$OLD_IFS"
	if [[ -n "$DEGRADED_DEPS" ]]; then
		echo "DEGRADED_DEPENDENCY: $DEGRADED_DEPS" >&2
		exit 6
	fi
fi

echo "OK commit=$REPORTED_COMMIT base_url=$BASE_URL"
exit 0