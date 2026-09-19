# Firestore Backup and Restore Runbook

This document details the backup and disaster recovery procedures for Firestore collections in Cabros Bot before automated TTL deletion policies expire historical data.

---

## 1. Background & Collection Scope

Production Firestore uses automatic TTL policies for automated data lifecycle management:
- `alerts` & `alertReplays`: 90-day retention (`ALERT_STORAGE_RETENTION_DAYS`) via `expiresAt`.
- `tradingviewJobs` & operational collections: ~1 hour post-terminal retention via `expiresAt`.
- `tradingSignalOutcomes`: Outcome evaluations for strategy performance tracking.

To prevent permanent loss of analytical, trade performance, and audit history, high-value collections are backed up periodically.

### Target Collections
- **High-Value Analytical Collections (Backed Up)**:
  - `alerts`: Ingested webhook alerts, analysis snapshots, metadata, and token usage.
  - `alertReplays`: Replay audit logs and idempotency traces.
  - `tradingSignalOutcomes`: Win/loss evaluations, MFE/MAE price metrics, and hit-rate history.
  - `scannerPresets`: Custom market scanner configurations.
- **Operational Collections (Excluded from long-term backup)**:
  - `idempotency_keys`: Ephemeral lock documents.
  - `tradingviewJobs`: Short-lived job worker queues.

---

## 2. Backup Methods

### Method A: Managed Google Cloud Storage Export (Recommended for Disaster Recovery)

Performs a point-in-time snapshot directly in Google Cloud Firestore using `gcloud`.

```bash
export FIREBASE_PROJECT_ID="cabros-bot"
export GCS_BACKUP_BUCKET="gs://cabros-bot-backups"
export COLLECTION_IDS="alerts,alertReplays,tradingSignalOutcomes,scannerPresets"

./ops/export-firestore-managed.sh
```

#### Bucket Lifecycle Policy (Recommended)
Configure GCS bucket lifecycle rules to manage storage costs:
1. Transition objects to **Nearline** storage after 30 days.
2. Transition objects to **Coldline** storage after 90 days.
3. Permanently expire/delete backups after **365 days** (1 year retention).

Example `lifecycle.json`:
```json
{
  "rule": [
    {
      "action": { "type": "SetStorageClass", "storageClass": "NEARLINE" },
      "condition": { "age": 30 }
    },
    {
      "action": { "type": "SetStorageClass", "storageClass": "COLDLINE" },
      "condition": { "age": 90 }
    },
    {
      "action": { "type": "Delete" },
      "condition": { "age": 365 }
    }
  ]
}
```
Apply policy with:
```bash
gcloud storage buckets update gs://cabros-bot-backups --lifecycle-file=lifecycle.json
```

---

### Method B: Selective JSONL Node Export (Selective Collection Backups & Local Analysis)

Exports documents directly to JSONL format with lossless Firestore type serialization (`Timestamp`, `GeoPoint`, `DocumentReference`).

```bash
# Export default high-value collections to ./backups/ (gitignored local artifacts)
pnpm run backup:firestore

# Or specify custom options:
node ops/export-firestore-collections.js \
  --collections=alerts,tradingSignalOutcomes \
  --output-dir=./backups/my-backup \
  --page-size=400
```

CLI Options:
- `--collections=<col1,col2>`: Collections to export (default: `alerts,alertReplays,tradingSignalOutcomes,scannerPresets`).
- `--output-dir=<path>`: Destination directory for `.jsonl` files and `manifest.json`.
- `--page-size=<num>`: Page size per read batch (default: 400).
- `--dry-run`: Scans and counts documents without writing files.
- `--project=<projectId>`: Target Google Cloud / Firebase project ID.

---

## 3. Restore Procedures

### Restoring from Managed GCS Export

Restores all or specific collections into Firestore:

```bash
export FIREBASE_PROJECT_ID="cabros-bot"
export FIRESTORE_RESTORE_TARGET_MODE="dedicated"

# Restore all collections in export
./ops/restore-firestore-managed.sh gs://cabros-bot-backups/firestore-backups/2026-08-30T04-00-00Z

# Or restore specific collections
./ops/restore-firestore-managed.sh gs://cabros-bot-backups/firestore-backups/2026-08-30T04-00-00Z alerts,tradingSignalOutcomes
```

Managed restores fail closed unless `FIRESTORE_RESTORE_TARGET_MODE` is `dedicated`. Use a dedicated recovery project with TTL disabled until the import and post-import refresh complete; do not run the managed restore against a stopped production project because expired `expiresAt` values can be deleted before the refresh. The empty-collection preflight remains non-transactional. After import, `alerts` and `alertReplays` receive a refreshed `expiresAt` using `ALERT_STORAGE_RETENTION_DAYS` (or 90 days when unset), while `tradingSignalOutcomes` have `expiresAt` removed and are marked `retentionPolicy: "archive"` so historical outcomes remain queryable and are not removed by native TTL. Other collections keep their source TTL values and are not rewritten with alert retention. The restore runner must have Node.js and the same Firebase Admin credentials available to the `gcloud` import.

---

### Restoring from JSONL Node Export

Restores documents from local JSONL export files with automatic batching (up to 400 items and a conservative estimated 8 MiB request-size budget per commit) and type deserialization:

When `--collections` is omitted, `manifest.json` is required. The restore validates every listed JSONL file, its parseability, and its document count before writing any document. Use `--collections` explicitly to restore a deliberately selected file without manifest discovery.

```bash
# Validate input files and document count without modifying Firestore (Dry Run)
node ops/restore-firestore-collections.js --input-dir=./backups/firestore-export-2026-08-30 --dry-run

# Perform real restore
pnpm run restore:firestore -- --input-dir=./backups/firestore-export-2026-08-30

# Restore only specific collections without overwriting existing fields
node ops/restore-firestore-collections.js \
  --input-dir=./backups/firestore-export-2026-08-30 \
  --collections=tradingSignalOutcomes \
  --no-overwrite
```

CLI Options:
- `--input-dir=<path>`: Directory containing exported `.jsonl` files (Required).
- `--collections=<col1,col2>`: Filter specific collections to restore.
- `--batch-size=<num>`: Number of documents per batch commit (default: 400, max: 500).
- `--dry-run`: Test parse and count documents without writing to Firestore.
- `--no-overwrite`: Skip existing documents to protect live/newer data from being rolled back by older backups.
- `--ttl-policy=<refresh|clear|preserve>`: Policy for historical TTL / `expiresAt` fields (default: `refresh`).
  - `refresh`: For `alerts` and `alertReplays`, computes a new `expiresAt` based on current time + retention window (default 90 days). `tradingSignalOutcomes` are archived as described below; other collections keep their existing `expiresAt` unchanged.
  - `clear`: Removes the `expiresAt` field from restored documents to prevent automated TTL deletion. Restored `alerts`, `alertReplays`, and `tradingSignalOutcomes` are also marked `retentionPolicy: "archive"` so read-time retention filtering does not hide intentionally preserved history.
  - `preserve`: Keeps the exact original `expiresAt` timestamp from the backup.
- Under the default `refresh` policy, restored `tradingSignalOutcomes` are archived in the same collection by removing `expiresAt` and setting `retentionPolicy: "archive"`; `SignalOutcomeService` exempts those records from retention filtering. Use `preserve` only when the source retention behavior is intentional.
- `--retention-days=<num>`: Retention days used when `--ttl-policy=refresh` (default: `ALERT_STORAGE_RETENTION_DAYS` or 90).
- `--project=<projectId>`: Target Firebase project ID.

---

## 4. Automated Scheduled Workflows

The GitHub Actions workflow [`.github/workflows/firestore-backup.yml`](../.github/workflows/firestore-backup.yml) runs weekly on Sundays at 04:00 UTC and can also be triggered manually via `workflow_dispatch`.

It uses the `FIREBASE_SERVICE_ACCOUNT_JSON` repository secret and `GCS_BACKUP_BUCKET` variable. When `GCS_BACKUP_BUCKET` is configured, snapshots export directly to access-controlled GCS buckets.

When `GCS_BACKUP_BUCKET` is unset, the workflow executes the JSONL fallback export and encrypts the archive with AES-256-CBC (PBKDF2) using the `FIRESTORE_BACKUP_PASSPHRASE` (or `BACKUP_ENCRYPTION_KEY`) secret before artifact upload. This prevents exposing sensitive alert text, webhook credentials (`discordWebhookUrl`), and recipient chat IDs in readable GitHub artifacts. If neither `GCS_BACKUP_BUCKET` nor `FIRESTORE_BACKUP_PASSPHRASE` is set, the workflow fails closed.

### Restoring from an Encrypted Backup Artifact

To restore from an encrypted fallback artifact downloaded from GitHub Actions:

```bash
# Decrypt the encrypted archive
openssl enc -d -aes-256-cbc -pbkdf2 -in firestore-backup-<run_id>.tar.gz.enc -out firestore-backup.tar.gz -pass env:FIRESTORE_BACKUP_PASSPHRASE

# Extract the archive into a local directory
mkdir -p ./backups/my-restored-backup
tar -xzf firestore-backup.tar.gz -C ./backups/my-restored-backup

# Restore collections into Firestore
node ops/restore-firestore-collections.js --input-dir=./backups/my-restored-backup
```

