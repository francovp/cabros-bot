#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${WEBHOOK_API_KEY:-}" ]]; then
	echo 'AUTH_BLOCKED: WEBHOOK_API_KEY is not set; cannot fetch /api/capabilities.' >&2
	exit 78
fi

curl --fail-with-body --silent --show-error \
	-H 'accept: application/json' \
	-H "x-api-key: ${WEBHOOK_API_KEY}" \
	"${CAPABILITIES_URL:-https://cabros-crypto-bot-telegram.onrender.com/api/capabilities}"
