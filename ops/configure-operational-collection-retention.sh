#!/usr/bin/env bash
# configure-operational-collection-retention.sh
#
# Enables Firestore native TTL deletion on the `expiresAt` field for the
# operational collections that accumulate expired documents indefinitely:
#
#   - idempotency_keys  (ENABLE_FIRESTORE_IDEMPOTENCY)
#   - news-monitor-dedup (ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP)
#   - notificationDeadLetters (ENABLE_NOTIFICATION_REDRIVE)
#
# Run once per Firebase project. Safe to re-run: enabling TTL on a field that
# already has TTL enabled is a no-op.
#
# Usage:
#   FIREBASE_PROJECT_ID=my-project bash ops/configure-operational-collection-retention.sh
#
# Optional: also backfill legacy documents that pre-date the expiresAt field
# (these collections always write expiresAt on creation, so this is a safety
# measure for documents written by an older version of the service):
#
#   BACKFILL=true FIREBASE_PROJECT_ID=my-project bash ops/configure-operational-collection-retention.sh
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

BACKFILL="${BACKFILL:-false}"

if [[ "$BACKFILL" == "true" ]]; then
	echo "Running backfill for legacy documents without expiresAt..."
	FIREBASE_PROJECT_ID="$project" node ops/backfill-operational-collection-retention.js
fi

for collection_group in idempotency_keys news-monitor-dedup notificationDeadLetters; do
	echo "Enabling TTL on expiresAt for collection group: $collection_group"
	gcloud firestore fields ttls update expiresAt \
		--collection-group="$collection_group" \
		--enable-ttl \
		--project="$project"
done

echo "Done. Firestore will now auto-delete expired documents in idempotency_keys, news-monitor-dedup, and notificationDeadLetters."
