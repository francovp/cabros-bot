#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${WEBHOOK_API_KEY:-}" ]]; then
	echo 'AUTH_BLOCKED: WEBHOOK_API_KEY is not set; cannot fetch /api/capabilities.' >&2
	exit 78
fi

printf 'x-api-key: %s\n' "$WEBHOOK_API_KEY" | curl --fail-with-body --silent --show-error \
	-H 'accept: application/json' \
	-H @- \
	"${CAPABILITIES_URL:-https://cabros-crypto-bot-telegram.onrender.com/api/capabilities}"
