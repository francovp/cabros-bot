#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')

from github_app_fetcher import GitHubAppClient

client = GitHubAppClient()

# Check new issues #1457 and #1458
for issue_num in [1457, 1458]:
    print(f"\n=== Issue #{issue_num} ===")
    try:
        # Get issue comments
        comments = client.get_issue_comments("francovp/cabros-bot", issue_num)
        has_virgin_trainee = False
        for c in comments:
            if c['user']['login'] in ['francovp', 'gigachad-senior-dev', 'virgin-trainee-dev[bot]']:
                print(f"  Comment by {c['user']['login']} at {c['updated_at']}: {c['body'][:300]}...")
                if c['user']['login'] == 'virgin-trainee-dev[bot]':
                    has_virgin_trainee = True
        print(f"  Has Virgin Trainee engagement: {has_virgin_trainee}")
    except Exception as e:
        print(f"  Error: {e}")