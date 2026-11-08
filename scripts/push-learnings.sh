#!/bin/bash
# Push any local commits to .learnings/ to GitHub
# Safe to run multiple times - only pushes if there are unpushed commits

set -euo pipefail

cd /home/ubuntu/.openclaw/workspace

# Check if there are commits on master not on origin/master
UNPUSHED=$(git log origin/master..HEAD --oneline 2>/dev/null | wc -l)

if [ "$UNPUSHED" -gt 0 ]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Pushing $UNPUSHED unpushed commit(s) to origin/master..."
    git push origin HEAD:master
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Push complete."
else
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] No unpushed commits."
fi