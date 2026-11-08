#!/usr/bin/env python3
"""Scan francovp/cabros-bot for activity since last run, including comments on engaged issues."""

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

def check_comments_for_corrections(client, item_num, is_pr, last_run_dt):
    """Check comments on an issue/PR for corrections from target users."""
    corrections = []
    try:
        comments = client.get_issue_comments(REPO, item_num)
    except GitHubAppError as e:
        print(f"Error fetching comments for #{item_num}: {e}")
        return corrections
    
    for comment in comments:
        author = comment.get("user", {}).get("login", "")
        body = comment.get("body", "")
        comment_time = iso_to_dt(comment.get("updated_at"))
        
        if last_run_dt and comment_time <= last_run_dt:
            continue
        
        if author.lower() in ["francovp", "gigachad-senior-dev"]:
            body_lower = body.lower()
            negative_indicators = [
                "correction", "negative feedback", "no", "wrong", "incorrect",
                "mistake", "error", "not right", "disagree", "reject",
                "skip", "low score", "automation/skip", "p1 issue",
                "blocker", "needs revision", "revision needed", "not merged",
                "won't fix", "wont fix", "not planned", "out of scope"
            ]
            
            if any(indicator in body_lower for indicator in negative_indicators):
                corrections.append({
                    "type": "pr" if is_pr else "issue",
                    "number": item_num,
                    "author": author,
                    "comment": body[:500],
                    "time": comment.get("updated_at"),
                    "url": comment.get("html_url")
                })
    
    # Also check PR reviews if it's a PR
    if is_pr:
        try:
            reviews = client.get_pr_reviews(REPO, item_num)
        except GitHubAppError as e:
            print(f"Error fetching reviews for PR #{item_num}: {e}")
            reviews = []
        
        for review in reviews:
            author = review.get("user", {}).get("login", "")
            body = review.get("body", "")
            review_time = iso_to_dt(review.get("submitted_at"))
            
            if last_run_dt and review_time <= last_run_dt:
                continue
            
            if author.lower() in ["francovp", "gigachad-senior-dev"]:
                body_lower = body.lower()
                negative_indicators = [
                    "correction", "negative feedback", "no", "wrong", "incorrect",
                    "mistake", "error", "not right", "disagree", "reject",
                    "skip", "low score", "automation/skip", "p1 issue",
                    "blocker", "needs revision", "revision needed", "not merged",
                    "won't fix", "wont fix", "not planned", "out of scope"
                ]
                
                if any(indicator in body_lower for indicator in negative_indicators):
                    corrections.append({
                        "type": "pr_review",
                        "number": item_num,
                        "author": author,
                        "comment": body[:500],
                        "time": review.get("submitted_at"),
                        "url": review.get("html_url")
                    })
    
    return corrections

def log_correction(correction):
    """Log a correction to LEARNINGS.md"""
    now = datetime.now(timezone.utc)
    timestamp = now.strftime('%Y%m%d-%H%M%S-%f')[:-3]
    date_str = now.strftime('%Y-%m-%d')
    
    item_ref = f"{REPO}/pull/{correction['number']}" if correction['type'] in ['pr', 'pr_review'] else f"{REPO}#{correction['number']}"
    author = correction['author']
    body = correction['comment']
    
    learning_entry = f"""## [LRN-{timestamp}] correction

**Logged**: {now.isoformat().replace('+00:00', 'Z')}
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @{author} on {item_ref}

### Details
@{author} provided feedback that may indicate a correction or negative response to the trainee's engagement:

> {body}

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: {item_ref}
- Tags: correction, feedback, trainee, engagement, {author.lower().replace('-', '')}
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: {date_str}
- Last-Seen: {date_str}"""
    
    append_learning(learning_entry)
    print(f"  -> Logged correction from @{author} on {item_ref}")

def main():
    client = GitHubAppClient()
    last_run_str = load_last_run()
    engaged = load_engaged()
    
    if last_run_str:
        last_run_dt = iso_to_dt(last_run_str)
        print(f"Last run: {last_run_dt}")
    else:
        last_run_dt = datetime.now(timezone.utc)
        print("No last run found, using current time")
    
    all_corrections = []
    
    # Check ALL issues (not just new ones) for new comments from target users
    print("Fetching all issues...")
    try:
        issues = client.list_issues(REPO, state="all", per_page=100)
    except GitHubAppError as e:
        print(f"Error fetching issues: {e}")
        return 1
    
    # Separate issues and PRs
    regular_issues = [i for i in issues if "pull_request" not in i]
    prs = [i for i in issues if "pull_request" in i]
    
    print(f"Found {len(regular_issues)} issues and {len(prs)} PRs")
    
    # Check regular issues for new comments
    for issue in regular_issues:
        issue_num = issue.get("number")
        print(f"Checking issue #{issue_num} for new comments...")
        corrections = check_comments_for_corrections(client, issue_num, is_pr=False, last_run_dt=last_run_dt)
        for c in corrections:
            log_correction(c)
            all_corrections.append(c)
    
    # Check PRs for new comments and reviews
    for pr in prs:
        pr_num = pr.get("number")
        print(f"Checking PR #{pr_num} for new comments/reviews...")
        corrections = check_comments_for_corrections(client, pr_num, is_pr=True, last_run_dt=last_run_dt)
        for c in corrections:
            log_correction(c)
            all_corrections.append(c)
    
    # Update last run time
    new_last_run = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    with open(LAST_RUN_FILE, 'w') as f:
        f.write(new_last_run)
    
    engaged["lastRun"] = new_last_run
    save_engaged(engaged)
    
    print(f"\nScan complete.")
    print(f"Corrections logged: {len(all_corrections)}")
    print(f"Last run updated to: {new_last_run}")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())