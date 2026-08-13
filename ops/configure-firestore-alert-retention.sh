#!/usr/bin/env bash
set -euo pipefail

project="${GOOGLE_CLOUD_PROJECT:-${GCLOUD_PROJECT:-${FIREBASE_PROJECT_ID:-}}}"
if [[ -z "$project" ]]; then
	echo "Set GOOGLE_CLOUD_PROJECT, GCLOUD_PROJECT, or FIREBASE_PROJECT_ID." >&2
	exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
	echo "gcloud CLI is required to configure Firestore TTL policies." >&2
	exit 1
fi

node ops/backfill-firestore-alert-retention.js

for collection_group in alerts alertReplays; do
	gcloud firestore fields ttls update expiresAt \
		--collection-group="$collection_group" \
		--enable-ttl \
		--project="$project"
done
