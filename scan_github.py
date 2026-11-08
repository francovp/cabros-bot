#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')

from github_app_fetcher import GitHubAppClient

client = GitHubAppClient()

# Fetch issues updated since last run
issues = client.get_issues("francovp/cabros-bot", state="all", since="2026-10-30T17:48:21.344Z")
issues = [i for i in issues if "pull_request" not in i]

print(f"Found {len(issues)} issues updated since last run:")
for issue in issues:
    print(f"#{issue['number']} [{issue['state']}] {issue['title']} - updated: {issue['updated_at']} - author: {issue['user']['login']}")

# Also fetch PRs
pulls = client.get_pulls("francovp/cabros-bot", state="all")
print(f"\nFound {len(pulls)} PRs total:")
for pr in pulls:
    if pr['updated_at'] > '2026-10-30T17:48:21.344Z':
        print(f"#{pr['number']} [{pr['state']}] {pr['title']} - updated: {pr['updated_at']} - author: {pr['user']['login']} - head: {pr['head']['ref']}")