import json, datetime, subprocess, sys

# Run the scan and capture output
result = subprocess.run(
    ['python3', '/home/ubuntu/.openclaw/workspace/github_scan.py', '1789993333'],
    capture_output=True, text=True
)

# Parse JSON from stdout
data = json.loads(result.stdout)

cutoff = datetime.datetime(2026, 9, 21, 12, 22, 13, tzinfo=datetime.timezone.utc)
new_items = []
for item in data:
    try:
        dt = datetime.datetime.fromisoformat(item['updated_at'].replace('Z', '+00:00'))
        if dt > cutoff:
            new_items.append(item)
    except Exception as e:
        pass

print(f'Total items: {len(data)}')
print(f'New items since cutoff: {len(new_items)}')
for item in new_items:
    user = item.get('user', 'N/A')
    print(f"  #{item['number']} {item['type']} by {user} at {item['updated_at']}")
    if 'body' in item and item['body']:
        preview = item['body'][:200].replace('\n', ' ')
        print(f"    -> {preview}...")