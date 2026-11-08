#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')

from github_app_fetcher import GitHubAppClient

client = GitHubAppClient()

# Check PRs that might need Virgin Trainee engagement
prs_to_check = [1488, 1445, 1479]

for pr_num in prs_to_check:
    print(f"\n=== PR #{pr_num} ===")
    try:
        pr = client.get_pr("francovp/cabros-bot", pr_num)
        print(f"Title: {pr['title']}")
        print(f"State: {pr['state']}")
        print(f"Author: {pr['user']['login']}")
        
        # Get comments
        comments = client.get_issue_comments("francovp/cabros-bot", pr_num)
        has_virgin_trainee = False
        for c in comments:
            if c['user']['login'] in ['francovp', 'gigachad-senior-dev', 'virgin-trainee-dev[bot]']:
                print(f"  Comment by {c['user']['login']} at {c['updated_at']}: {c['body'][:300]}...")
                if c['user']['login'] == 'virgin-trainee-dev[bot]':
                    has_virgin_trainee = True
        
        # Get reviews
        reviews = client.get_pr_reviews("francovp/cabros-bot", pr_num)
        for r in reviews:
            if r['user']['login'] in ['francovp', 'gigachad-senior-dev', 'virgin-trainee-dev[bot]']:
                print(f"  Review by {r['user']['login']} at {r['submitted_at']}: {r['state']} - {r['body'][:300] if r['body'] else 'No body'}...")
        
        print(f"  Has Virgin Trainee engagement: {has_virgin_trainee}")
                
    except Exception as e:
        print(f"  Error: {e}")