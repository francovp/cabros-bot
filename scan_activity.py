#!/usr/bin/env python3
"""Scan francovp/cabros-bot for activity since last run."""

import os
import sys
import json
import time
from datetime import datetime, timezone

sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')
from github_app_client import GitHubAppClient, GitHubAppError

REPO = "francovp/cabros-bot"
LAST_RUN_FILE = "/home/ubuntu/.openclaw/workspace/github-last-run.txt"
ENGAGED_FILE = "/home/ubuntu/.openclaw/workspace/.trainee-engaged.json"
LEARNINGS_FILE = "/home/ubuntu/.openclaw/workspace/.learnings/LEARNINGS.md"

def load_last_run():
    try:
        with open(LAST_RUN_FILE, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return None

def load_engaged():
    try:
        with open(ENGAGED_FILE, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        return {"lastRun": None, "engagedIssues": []}

def save_engaged(data):
    with open(ENGAGED_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def append_learning(entry):
    with open(LEARNINGS_FILE, 'a') as f:
        f.write(entry + "\n\n")

def iso_to_dt(iso_str):
    """Parse ISO timestamp to datetime."""
    return datetime.fromisoformat(iso_str.replace('Z', '+00:00'))

def main():
    client = GitHubAppClient()
    last_run_str = load_last_run()
    engaged = load_engaged()
    
    if last_run_str:
        last_run = iso_to_dt(last_run_str)
        print(f"Last run: {last_run}")
    else:
        last_run = datetime.now(timezone.utc)
        print("No last run found, using current time")
    
    # Fetch issues updated since last run
    print("Fetching issues...")
    try:
        issues = client.list_issues(REPO, state="all", per_page=100)
    except GitHubAppError as e:
        print(f"Error fetching issues: {e}")
        return 1
    
    new_engagements = []
    corrections_found = []
    
    for issue in issues:
        if "pull_request" in issue:
            continue  # Skip PRs, handle separately
        
        issue_num = issue.get("number")
        updated_at = iso_to_dt(issue.get("updated_at"))
        
        if issue_num in engaged["engagedIssues"]:
            continue
        
        if last_run_str and updated_at <= last_run:
            continue
        
        # New issue or updated issue we haven't engaged with
        print(f"Found new/updated issue #{issue_num}: {issue.get('title')}")
        
        # Fetch comments to check for corrections from @francovp or @gigachad-senior-dev
        try:
            comments = client.get_issue_comments(REPO, issue_num)
        except GitHubAppError as e:
            print(f"Error fetching comments for #{issue_num}: {e}")
            continue
        
        for comment in comments:
            author = comment.get("user", {}).get("login", "")
            body = comment.get("body", "")
            comment_time = iso_to_dt(comment.get("updated_at"))
            
            if last_run_str and comment_time <= last_run:
                continue
            
            # Check for corrections/negative feedback from the two personas
            if author.lower() in ["francovp", "gigachad-senior-dev"]:
                # Check if it's a correction/negative feedback
                body_lower = body.lower()
                negative_indicators = [
                    "correction", "negative feedback", "no", "wrong", "incorrect",
                    "mistake", "error", "not right", "disagree", "reject",
                    "skip", "low score", "automation/skip", "p1 issue",
                    "blocker", "needs revision", "revision needed"
                ]
                
                if any(indicator in body_lower for indicator in negative_indicators):
                    corrections_found.append({
                        "issue": issue_num,
                        "author": author,
                        "comment": body[:500],
                        "time": comment.get("updated_at"),
                        "url": comment.get("html_url")
                    })
                    
                    # Log to learnings
                    learning_entry = f"""## [LRN-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')[:-3]}] correction

**Logged**: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @{author} on {REPO}#{issue_num}

### Details
@{author} provided feedback that may indicate a correction or negative response to the trainee's engagement:

> {body[:500]}

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: {REPO}#{issue_num}
- Tags: correction, feedback, trainee, engagement, {author.lower().replace('-', '')}
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}
- Last-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"""
                    
                    append_learning(learning_entry)
                    print(f"  -> Logged correction from @{author} on #{issue_num}")
        
        new_engagements.append(issue_num)
        engaged["engagedIssues"].append(issue_num)
    
    # Also check PRs for review comments
    print("Fetching PRs...")
    try:
        prs = client.list_issues(REPO, state="all", per_page=100)
        prs = [p for p in prs if "pull_request" in p]
    except GitHubAppError as e:
        print(f"Error fetching PRs: {e}")
        prs = []
    
    for pr in prs:
        pr_num = pr.get("number")
        updated_at = iso_to_dt(pr.get("updated_at"))
        
        if pr_num in engaged["engagedIssues"]:
            continue
        
        if last_run_str and updated_at <= last_run:
            continue
        
        print(f"Found new/updated PR #{pr_num}: {pr.get('title')}")
        
        # Check PR reviews
        try:
            reviews = client.get_pr_reviews(REPO, pr_num)
        except GitHubAppError as e:
            print(f"Error fetching reviews for PR #{pr_num}: {e}")
            reviews = []
        
        for review in reviews:
            author = review.get("user", {}).get("login", "")
            body = review.get("body", "")
            review_time = iso_to_dt(review.get("submitted_at"))
            
            if last_run_str and review_time <= last_run:
                continue
            
            if author.lower() in ["francovp", "gigachad-senior-dev"]:
                body_lower = body.lower()
                negative_indicators = [
                    "correction", "negative feedback", "no", "wrong", "incorrect",
                    "mistake", "error", "not right", "disagree", "reject",
                    "skip", "low score", "automation/skip", "p1 issue",
                    "blocker", "needs revision", "revision needed", "not merged"
                ]
                
                if any(indicator in body_lower for indicator in negative_indicators):
                    corrections_found.append({
                        "pr": pr_num,
                        "author": author,
                        "comment": body[:500],
                        "time": review.get("submitted_at"),
                        "url": review.get("html_url")
                    })
                    
                    learning_entry = f"""## [LRN-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')[:-3]}] correction

**Logged**: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @{author} on {REPO} PR #{pr_num}

### Details
@{author} provided feedback that may indicate a correction or negative response to the trainee's engagement:

> {body[:500]}

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: {REPO}/pull/{pr_num}
- Tags: correction, feedback, trainee, engagement, {author.lower().replace('-', '')}
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}
- Last-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"""
                    
                    append_learning(learning_entry)
                    print(f"  -> Logged correction from @{author} on PR #{pr_num}")
        
        # Check PR comments too
        try:
            comments = client.get_issue_comments(REPO, pr_num)
        except GitHubAppError as e:
            print(f"Error fetching PR comments for #{pr_num}: {e}")
            comments = []
        
        for comment in comments:
            author = comment.get("user", {}).get("login", "")
            body = comment.get("body", "")
            comment_time = iso_to_dt(comment.get("updated_at"))
            
            if last_run_str and comment_time <= last_run:
                continue
            
            if author.lower() in ["francovp", "gigachad-senior-dev"]:
                body_lower = body.lower()
                negative_indicators = [
                    "correction", "negative feedback", "no", "wrong", "incorrect",
                    "mistake", "error", "not right", "disagree", "reject",
                    "skip", "low score", "automation/skip", "p1 issue",
                    "blocker", "needs revision", "revision needed", "not merged"
                ]
                
                if any(indicator in body_lower for indicator in negative_indicators):
                    corrections_found.append({
                        "pr": pr_num,
                        "author": author,
                        "comment": body[:500],
                        "time": comment.get("updated_at"),
                        "url": comment.get("html_url")
                    })
                    
                    learning_entry = f"""## [LRN-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')[:-3]}] correction

**Logged**: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @{author} on {REPO} PR #{pr_num}

### Details
@{author} provided feedback that may indicate a correction or negative response to the trainee's engagement:

> {body[:500]}

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: {REPO}/pull/{pr_num}
- Tags: correction, feedback, trainee, engagement, {author.lower().replace('-', '')}
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}
- Last-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"""
                    
                    append_learning(learning_entry)
                    print(f"  -> Logged correction from @{author} on PR #{pr_num} comment")
        
        new_engagements.append(pr_num)
        engaged["engagedIssues"].append(pr_num)
    
    # Update last run time
    new_last_run = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    with open(LAST_RUN_FILE, 'w') as f:
        f.write(new_last_run)
    
    engaged["lastRun"] = new_last_run
    save_engaged(engaged)
    
    print(f"\nScan complete.")
    print(f"New engagements: {len(new_engagements)}")
    print(f"Corrections logged: {len(corrections_found)}")
    print(f"Last run updated to: {new_last_run}")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())