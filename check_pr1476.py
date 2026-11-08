#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')

from github_app_fetcher import GitHubAppClient

client = GitHubAppClient()

# Check PR #1476 in detail
print("=== PR #1476 (learnings: log corrections from GitHub activity scan) ===")
pr = client.get_pr("francovp/cabros-bot", 1476)
print(f"Title: {pr['title']}")
print(f"State: {pr['state']}")
print(f"Author: {pr['user']['login']}")
print(f"Body: {pr['body'][:500] if pr['body'] else 'No body'}")

# Get all comments
comments = client.get_issue_comments("francovp/cabros-bot", 1476)
for c in comments:
    print(f"\nComment by {c['user']['login']} at {c['updated_at']}:")
    print(f"  {c['body'][:500]}")

# Get reviews
reviews = client.get_pr_reviews("francovp/cabros-bot", 1476)
for r in reviews:
    print(f"\nReview by {r['user']['login']} at {r['submitted_at']}: {r['state']}")
    if r['body']:
        print(f"  {r['body'][:500]}")