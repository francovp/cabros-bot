#!/usr/bin/env python3
"""
Comprehensive GitHub activity scanner for Virgin Trainee cron job.
Scans for activity since last run, detects corrections from @francovp/@gigachad-senior-dev,
logs to LEARNINGS.md, commits and pushes changes.
"""

import os
import sys
import time
import json
import re
import subprocess
from datetime import datetime, timezone

# Add trainee-tooling to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'trainee-tooling'))

from github_app_fetcher import GitHubAppClient, GitHubAppError

# Configuration
REPO = "francovp/cabros-bot"
LAST_RUN_FILE = os.path.join(os.path.dirname(__file__), "github-last-run.txt")
LEARNINGS_FILE = os.path.join(os.path.dirname(__file__), ".learnings", "LEARNINGS.md")
TARGET_USERS = {"francovp", "gigachad-senior-dev"}

# Correction detection patterns
CORRECTION_INDICATORS = [
    "correction", "corrected", "wrong", "incorrect", "no,", "no.",
    "that's not", "that is not", "actually", "you're wrong",
    "this is wrong", "this isn't", "not right", "mistake",
    "fix this", "change this", "should be", "must be",
    "incorrectly", "misunderstand", "misunderstood",
    "that's incorrect", "that is incorrect", "you misunderstood",
    "not correct", "doesn't work", "won't work", "will not work",
    "invalid", "invalid approach", "bad idea", "don't do",
    "should not", "must not", "never", "avoid", "revert",
    "rollback", "undo", "remove this", "delete this"
]

# Patterns that indicate positive/neutral feedback (not corrections)
POSITIVE_INDICATORS = [
    "looks good", "lgtm", "approved", "good job", "nice work",
    "thanks", "thank you", "great", "awesome", "perfect",
    "exactly", "agreed", "yes,", "correct", "right"
]


def read_last_run():
    """Read the last run timestamp."""
    try:
        with open(LAST_RUN_FILE, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        # Default to 24 hours ago if no file
        return (datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)).isoformat().replace('+00:00', 'Z')


def write_last_run(timestamp):
    """Write the current run timestamp."""
    with open(LAST_RUN_FILE, 'w') as f:
        f.write(timestamp)


def is_correction(text, review_state=None):
    """Detect if a comment/review body contains a correction or negative feedback."""
    if not text:
        return False
    
    text_lower = text.lower()
    
    # Check for explicit CHANGES_REQUESTED review
    if review_state == "CHANGES_REQUESTED":
        return True
    
    # Check for positive indicators first (to avoid false positives)
    for indicator in POSITIVE_INDICATORS:
        if indicator in text_lower:
            # But still check if there's a correction mixed in
            pass
    
    # Check for correction indicators
    for indicator in CORRECTION_INDICATORS:
        if indicator in text_lower:
            # Additional context check: make sure it's not just mentioning the word
            # in a non-corrective context
            return True
    
    return False


def generate_learning_id():
    """Generate a unique learning ID."""
    return f"LRN-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}-{os.urandom(2).hex()}"


def format_learning_entry(activity, correction_text):
    """Format a learning entry for LEARNINGS.md."""
    learning_id = generate_learning_id()
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    
    # Determine priority based on review state vs comment
    priority = "high" if activity.get("type") == "review" and activity.get("state") == "CHANGES_REQUESTED" else "medium"
    
    # Determine area from context
    context = activity.get("context", "")
    area = "backend"
    if "frontend" in context.lower() or "admin" in context.lower() or "ui" in context.lower():
        area = "frontend"
    elif "infra" in context.lower() or "deploy" in context.lower() or "ci" in context.lower():
        area = "infra"
    
    # Truncate correction text for summary
    summary = correction_text[:200] + ("..." if len(correction_text) > 200 else "")
    
    entry = f"""## [{learning_id}] correction

**Logged**: {now}
**Priority**: {priority}
**Status**: pending
**Area**: {area}

### Summary
{summary}

### Details
Correction from @{activity['user']} on {activity['context']}:

> {correction_text}

**Source URL**: {activity['url']}

### Suggested Action
Review the feedback and implement necessary changes.

### Metadata
- Source: user_feedback
- Related Files: TBD
- Tags: correction, feedback
- See Also: {activity['url']}
- Pattern-Key: harden.feedback_response

---
"""
    return entry


def append_to_learnings(entry):
    """Append a learning entry to LEARNINGS.md."""
    with open(LEARNINGS_FILE, 'a') as f:
        f.write(entry)


def scan_activity_since(client, since):
    """Scan for all activity since the given timestamp."""
    print(f"Scanning activity since {since}...")
    
    all_activity = []
    
    # Fetch issues updated since last run
    try:
        issues = client.get_issues(REPO, state="all", since=since, per_page=100)
        issues = [i for i in issues if "pull_request" not in i]
        print(f"Found {len(issues)} issues updated since last run")
        
        for issue in issues:
            issue_num = issue['number']
            # Get comments on this issue
            comments = client.get_issue_comments(REPO, issue_num, per_page=100)
            for comment in comments:
                comment_time = comment.get('updated_at') or comment.get('created_at')
                if comment_time and comment_time > since:
                    all_activity.append({
                        "type": "comment",
                        "context": f"Issue #{issue_num}",
                        "user": comment["user"]["login"],
                        "body": comment.get("body", ""),
                        "created_at": comment_time,
                        "url": comment["html_url"]
                    })
    except GitHubAppError as e:
        print(f"Error fetching issues: {e}")
    
    # Fetch PRs updated since last run
    try:
        pulls = client.get_pulls(REPO, state="all", per_page=100)
        # Filter by updated_at since the API doesn't support 'since' for PRs
        pulls = [p for p in pulls if p.get('updated_at', '') > since]
        print(f"Found {len(pulls)} PRs updated since last run")
        
        for pr in pulls:
            pr_num = pr['number']
            # Get comments on this PR
            comments = client.get_issue_comments(REPO, pr_num, per_page=100)
            for comment in comments:
                comment_time = comment.get('updated_at') or comment.get('created_at')
                if comment_time and comment_time > since:
                    all_activity.append({
                        "type": "comment",
                        "context": f"PR #{pr_num}",
                        "user": comment["user"]["login"],
                        "body": comment.get("body", ""),
                        "created_at": comment_time,
                        "url": comment["html_url"]
                    })
            
            # Get reviews on this PR
            reviews = client.get_pr_reviews(REPO, pr_num, per_page=100)
            for review in reviews:
                submitted_at = review.get("submitted_at")
                if submitted_at and submitted_at > since:
                    all_activity.append({
                        "type": "review",
                        "context": f"PR #{pr_num}",
                        "user": review["user"]["login"],
                        "state": review["state"],
                        "body": review.get("body", ""),
                        "created_at": submitted_at,
                        "url": review["html_url"]
                    })
    except GitHubAppError as e:
        print(f"Error fetching PRs: {e}")
    
    return all_activity


def main():
    print("=" * 60)
    print("Virgin Trainee GitHub Activity Scanner")
    print("=" * 60)
    
    # Read last run timestamp
    since = read_last_run()
    print(f"Last run: {since}")
    
    # Current timestamp for this run
    current_run = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    print(f"Current run: {current_run}")
    
    # Initialize client
    client = GitHubAppClient()
    
    # Scan for activity
    all_activity = scan_activity_since(client, since)
    
    if not all_activity:
        print("No new activity found.")
        write_last_run(current_run)
        return 0
    
    print(f"\nTotal new activity items: {len(all_activity)}")
    
    # Filter for target users and corrections
    corrections = []
    for activity in all_activity:
        user = activity["user"].lower()
        if user in TARGET_USERS:
            body = activity.get("body", "")
            review_state = activity.get("state")
            if is_correction(body, review_state):
                corrections.append(activity)
                print(f"\n⚠️  CORRECTION DETECTED:")
                print(f"   @{activity['user']} on {activity['context']}")
                print(f"   Type: {activity['type']}")
                if review_state:
                    print(f"   State: {review_state}")
                print(f"   Time: {activity['created_at']}")
                print(f"   Body: {body[:300]}...")
                print(f"   URL: {activity['url']}")
    
    if not corrections:
        print("\nNo corrections detected from target users.")
        write_last_run(current_run)
        return 0
    
    print(f"\n{'=' * 60}")
    print(f"LOGGING {len(corrections)} CORRECTION(S) TO LEARNINGS.MD")
    print(f"{'=' * 60}")
    
    # Log each correction
    for correction in corrections:
        entry = format_learning_entry(correction, correction.get("body", ""))
        append_to_learnings(entry)
        print(f"Logged: {entry.split(']')[0][3:]}")
    
    # Update last run timestamp
    write_last_run(current_run)
    print(f"\nUpdated last run timestamp to: {current_run}")
    
    # Commit and push changes
    print("\nCommitting and pushing changes...")
    try:
        # Check if there are changes
        result = subprocess.run(
            ["git", "status", "--porcelain", ".learnings/LEARNINGS.md"],
            capture_output=True, text=True, cwd=os.path.dirname(__file__)
        )
        
        if result.stdout.strip():
            # There are changes
            subprocess.run(["git", "add", ".learnings/LEARNINGS.md"], check=True, cwd=os.path.dirname(__file__))
            commit_msg = f"learnings: log {len(corrections)} correction(s) from GitHub activity scan\n\nAuto-committed by Virgin Trainee cron job at {current_run}"
            subprocess.run(["git", "commit", "-m", commit_msg], check=True, cwd=os.path.dirname(__file__))
            subprocess.run(["git", "push"], check=True, cwd=os.path.dirname(__file__))
            print("Changes committed and pushed successfully.")
        else:
            print("No changes to commit.")
    except subprocess.CalledProcessError as e:
        print(f"Error committing/pushing: {e}")
        return 1
    
    return 0


if __name__ == "__main__":
    sys.exit(main())