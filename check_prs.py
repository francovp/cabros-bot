#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')

from github_app_fetcher import GitHubAppClient

client = GitHubAppClient()

# Check key PRs for comments from francovp or gigachad-senior-dev
prs_to_check = [1476, 1381, 1488, 1445, 1257, 1479, 1463]

for pr_num in prs_to_check:
    print(f"\n=== PR #{pr_num} ===")
    try:
        pr = client.get_pr("francovp/cabros-bot", pr_num)
        print(f"Title: {pr['title']}")
        print(f"State: {pr['state']}")
        print(f"Author: {pr['user']['login']}")
        
        # Get comments
        comments = client.get_issue_comments("francovp/cabros-bot", pr_num)
        for c in comments:
            if c['user']['login'] in ['francovp', 'gigachad-senior-dev']:
                print(f"  Comment by {c['user']['login']} at {c['updated_at']}: {c['body'][:200]}...")
        
        # Get reviews
        reviews = client.get_pr_reviews("francovp/cabros-bot", pr_num)
        for r in reviews:
            if r['user']['login'] in ['francovp', 'gigachad-senior-dev']:
                print(f"  Review by {r['user']['login']} at {r['submitted_at']}: {r['state']} - {r['body'][:200] if r['body'] else 'No body'}...")
                
    except Exception as e:
        print(f"  Error: {e}")