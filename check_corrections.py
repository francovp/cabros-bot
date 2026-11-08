import subprocess
import json
from datetime import datetime, timezone

since = '2026-10-20T06:16:54Z'

engaged_issues = [
    1412, 1289, 655, 1424, 1297, 786, 791, 542, 1054, 1056, 1445, 1319,
    1075, 1076, 820, 828, 833, 709, 586, 1227, 1228, 1109, 982, 601,
    1371, 607, 735, 1381, 616, 1257, 1391, 1392, 751, 1394
]

CORRECTION_INDICATORS = [
    "correction", "corrected", "wrong", "incorrect", "no,", "no.",
    "that's not", "that is not", "actually", "you're wrong",
    "this is wrong", "this isn't", "not right", "mistake",
    "fix this", "change this", "should be", "must be",
    "incorrectly", "misunderstand", "misunderstood"
]

TARGET_USERS = {"francovp", "gigachad-senior-dev"}

def is_correction_comment(comment):
    user = comment.get("user", {}).get("login", "")
    if user not in TARGET_USERS:
        return False
    body = comment.get("body", "").lower()
    if body.strip() in ["no", "no.", "no,"]:
        return True
    for indicator in CORRECTION_INDICATORS:
        if indicator in body:
            return True
    return False

print(f"Checking {len(engaged_issues)} engaged items for corrections since {since}...")

corrections = []
for num in engaged_issues:
    jq_filter = '.[] | select(.created_at > "' + since + '" and (.user.login == "francovp" or .user.login == "gigachad-senior-dev")) | {id: .id, author: .user.login, body: .body, created_at: .created_at}'
    result = subprocess.run(['gh', 'api', f'repos/francovp/cabros-bot/issues/{num}/comments', '--paginate', '-q', jq_filter], capture_output=True, text=True)
    if result.stdout.strip():
        for line in result.stdout.strip().split('\n'):
            try:
                comment = json.loads(line)
                if is_correction_comment(comment):
                    corrections.append({
                        "item_number": num,
                        "comment": comment
                    })
            except json.JSONDecodeError:
                pass

if corrections:
    print(f"\nFound {len(corrections)} correction comments:")
    for corr in corrections:
        print(f"  Item #{corr['item_number']}: @{corr['comment']['author']} at {corr['comment']['created_at']}")
        print(f"    {corr['comment']['body'][:200]}...")
else:
    print("\nNo correction comments found from target users.")