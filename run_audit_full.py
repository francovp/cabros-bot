#!/usr/bin/env python3
import subprocess
import sys

result = subprocess.run([
    sys.executable,
    "/home/ubuntu/.openclaw/workspace/trainee-tooling/github_app_client.py",
    "audit",
    "--repo", "francovp/cabros-bot",
    "--since", "2026-10-01T00:00:00Z",
    "--dry-run"
], capture_output=True, text=True)

print("STDOUT:")
print(result.stdout)
print("STDERR:")
print(result.stderr)
print("Return code:", result.returncode)