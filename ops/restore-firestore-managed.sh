#!/usr/bin/env bash
set -euo pipefail

# restore-firestore-managed.sh
# Restores Firestore collections from a managed GCS export.

project="${FIREBASE_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-${GCLOUD_PROJECT:-}}}"
if [[ -z "$project" ]]; then
	echo "Error: Set FIREBASE_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCLOUD_PROJECT." >&2
	exit 1
fi

export_uri="${1:-${FIRESTORE_EXPORT_URI:-}}"
if [[ -z "$export_uri" ]]; then
	echo "Usage: ./ops/restore-firestore-managed.sh <gs://bucket/path/to/export> [collection_ids]" >&2
	echo "Example: ./ops/restore-firestore-managed.sh gs://my-bucket/firestore-backups/2026-08-30T00-00-00Z alerts,tradingSignalOutcomes" >&2
	exit 1
fi

collections="${2:-${COLLECTION_IDS:-alerts,alertReplays,tradingSignalOutcomes,scannerPresets}}"

restore_target_mode="${FIRESTORE_RESTORE_TARGET_MODE:-}"
if [[ "$restore_target_mode" != "dedicated" ]]; then
	echo "Error: Set FIRESTORE_RESTORE_TARGET_MODE to 'dedicated' for a dedicated recovery project with TTL disabled." >&2
	exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
	echo "Error: gcloud CLI is required for managed Firestore imports." >&2
	exit 1
fi

if ! command -v node >/dev/null 2>&1; then
	echo "Error: node is required to refresh TTL fields after managed Firestore imports." >&2
	exit 1
fi

echo "Starting managed Firestore import for project '${project}' from '${export_uri}'..."
echo "Collections: ${collections}"

echo "Verifying managed restore target collections are empty before import..."
# ponytail: the preflight/import window is not transactional; use a dedicated empty restore project for strict isolation.
node ops/refresh-firestore-ttl.js \
	--collections="$collections" \
	--project="$project"

gcloud firestore import "$export_uri" \
	--collection-ids="$collections" \
	--project="$project"

echo "Managed import completed; refreshing TTL fields for the configured retention window..."
node ops/refresh-firestore-ttl.js \
	--collections="$collections" \
	--project="$project" \
	--allow-nonempty

echo "Managed import and TTL refresh completed successfully."
