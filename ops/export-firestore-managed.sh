#!/usr/bin/env bash
set -euo pipefail

# export-firestore-managed.sh
# Performs a managed Firestore export to Google Cloud Storage (GCS) for disaster recovery.

project="${FIREBASE_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-${GCLOUD_PROJECT:-}}}"
if [[ -z "$project" ]]; then
	echo "Error: Set FIREBASE_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or GCLOUD_PROJECT." >&2
	exit 1
fi

bucket="${GCS_BACKUP_BUCKET:-}"
if [[ -z "$bucket" ]]; then
	echo "Error: Set GCS_BACKUP_BUCKET (e.g. 'gs://my-bucket' or 'my-bucket')." >&2
	exit 1
fi

if ! command -v gcloud >/dev/null 2>&1; then
	echo "Error: gcloud CLI is required for managed Firestore exports." >&2
	exit 1
fi

# Ensure gs:// prefix
if [[ ! "$bucket" =~ ^gs:// ]]; then
	bucket="gs://${bucket}"
fi

timestamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
export_uri="${bucket}/firestore-backups/${timestamp}"
collections="${COLLECTION_IDS:-alerts,alertReplays,signalOutcomes,scannerPresets}"

echo "Starting managed Firestore export for project '${project}' to '${export_uri}'..."
echo "Collections: ${collections}"

gcloud firestore export "$export_uri" \
	--collection-ids="$collections" \
	--project="$project"

echo "Managed export completed successfully: ${export_uri}"
