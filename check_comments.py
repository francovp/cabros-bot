import subprocess
import json

since = '2026-10-20T06:16:54Z'

for num in [1445, 1424, 1394, 1371]:
    jq_filter = '.[] | select(.created_at > "' + since + '" and (.user.login == "francovp" or .user.login == "gigachad-senior-dev")) | {number: .id, author: .user.login, body: .body, created_at: .created_at}'
    result = subprocess.run(['gh', 'api', f'repos/francovp/cabros-bot/issues/{num}/comments', '--paginate', '-q', jq_filter], capture_output=True, text=True)
    if result.stdout.strip():
        print(f'Item #{num}:')
        print(result.stdout)
    else:
        print(f'Item #{num}: No new comments from target users')