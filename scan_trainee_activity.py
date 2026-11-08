#!/usr/bin/env python3
"""
Scan GitHub for trainee engagement activity since last run.
Looks for corrections/negative feedback from @francovp or @gigachad-senior-dev
on issues and PRs where Virgin Trainee engaged.
"""

import os
import sys
import json
import time
import logging
import hashlib
import tempfile
import re
from datetime import datetime, timezone

import jwt
import requests

# Add the trainee-tooling to path for imports
sys.path.insert(0, '/home/ubuntu/.openclaw/workspace/trainee-tooling')
from github_app_client import GitHubAppClient, GitHubAppError, ConfigurationError

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# The accounts whose feedback we track
TRACKED_ACCOUNTS = {"francovp", "gigachad-senior-dev", "gigachad-senior-dev[bot]"}
# Virgin Trainee bot accounts
TRAINEE_ACCOUNTS = {"virgin-trainee-dev", "virgin-trainee-dev[bot]"}

# Patterns that indicate correction/negative feedback
CORRECTION_PATTERNS = [
    r"correction",
    r"negative feedback",
    r"incorrect",
    r"wrong",
    r"not correct",
    r"mistake",
    r"error",
    r"fix this",
    r"needs fixing",
    r"should be",
    r"must be",
    r"don't",
    r"do not",
    r"avoid",
    r"skip",
    r"rejected",
    r"declined",
    r"blocked",
    r"P1",
    r"critical",
    r"unresolved",
    r"prevents merge",
    r"revision needed",
    r"not merged",
    r"automation/skip",
    r"automation readiness",
    r"low score",
    r"too large",
    r"missing acceptance criteria",
    r"scope is too large",
    r"needs user",
    r"NEEDS_USER",
    r"GLOBAL_BLOCKED",
    r"LOCAL_DEADLOCK",
]

# Patterns that indicate positive/neutral feedback (not corrections)
POSITIVE_PATTERNS = [
    r"lgtm",
    r"looks good",
    r"approved",
    r"merge",
    r"thanks",
    r"thank you",
    r"good catch",
    r"nice",
    r"agreed",
    r"correct",
    r"✅",
    r"👍",
]


def load_last_run():
    """Load the last run timestamp."""
    path = "/home/ubuntu/.openclaw/workspace/github-last-run.txt"
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return None


def save_last_run(timestamp):
    """Save the current run timestamp."""
    path = "/home/ubuntu/.openclaw/workspace/github-last-run.txt"
    with open(path, "w") as f:
        f.write(timestamp)


def load_engaged_issues():
    """Load the set of issues/PRs we've already engaged with."""
    path = "/home/ubuntu/.openclaw/workspace/.trainee-engaged.json"
    try:
        with open(path) as f:
            data = json.load(f)
            return set(data.get("engaged", []))
    except FileNotFoundError:
        return set()


def save_engaged_issues(engaged_set):
    """Save the set of engaged issues/PRs."""
    path = "/home/ubuntu/.openclaw/workspace/.trainee-engaged.json"
    with open(path, "w") as f:
        json.dump({"engaged": sorted(list(engaged_set))}, f, indent=2)


def is_correction(text):
    """Check if text contains correction/negative feedback patterns."""
    if not text:
        return False
    lowered = text.lower()
    
    # Check for positive patterns first - if positive, not a correction
    for pattern in POSITIVE_PATTERNS:
        if re.search(pattern, lowered, re.IGNORECASE):
            # But still check if there's a correction pattern too
            has_correction = any(re.search(pat, lowered, re.IGNORECASE) for pat in CORRECTION_PATTERNS)
            if has_correction:
                return True
            return False
    
    # Check for correction patterns
    for pattern in CORRECTION_PATTERNS:
        if re.search(pattern, lowered, re.IGNORECASE):
            return True
    
    return False


def fetch_recent_comments(client, repo, since_iso):
    """Fetch all comments on issues and PRs since the given timestamp."""
    since_dt = datetime.fromisoformat(since_iso.replace('Z', '+00:00'))
    since_ts = since_dt.timestamp()
    
    all_comments = []
    
    # Get all issues (including PRs)
    try:
        issues = client.list_issues(repo, state="all", per_page=100)
    except GitHubAppError as e:
        logger.error(f"Failed to list issues: {e}")
        return []
    
    for issue in issues:
        # Skip PRs in the issues list (they have pull_request key)
        is_pr = "pull_request" in issue
        issue_num = issue.get("number")
        
        if not issue_num:
            continue
        
        # Get comments on this issue/PR
        try:
            comments = client.get_issue_comments(repo, issue_num)
        except GitHubAppError as e:
            logger.warning(f"Failed to get comments for {repo}#{issue_num}: {e}")
            continue
        
        for comment in comments:
            comment_dt = datetime.fromisoformat(comment.get("updated_at", "").replace('Z', '+00:00'))
            if comment_dt.timestamp() > since_ts:
                all_comments.append({
                    "repo": repo,
                    "issue_number": issue_num,
                    "is_pr": is_pr,
                    "comment": comment,
                    "issue_title": issue.get("title", ""),
                    "issue_url": issue.get("html_url", ""),
                })
    
    return all_comments


def fetch_recent_reviews(client, repo, since_iso):
    """Fetch all PR reviews since the given timestamp."""
    since_dt = datetime.fromisoformat(since_iso.replace('Z', '+00:00'))
    since_ts = since_dt.timestamp()
    
    all_reviews = []
    
    try:
        issues = client.list_issues(repo, state="all", per_page=100)
    except GitHubAppError as e:
        logger.error(f"Failed to list issues: {e}")
        return []
    
    for issue in issues:
        if "pull_request" not in issue:
            continue
        
        pr_num = issue.get("number")
        if not pr_num:
            continue
        
        try:
            reviews = client.get_pr_reviews(repo, pr_num)
        except GitHubAppError as e:
            logger.warning(f"Failed to get reviews for {repo}#{pr_num}: {e}")
            continue
        
        for review in reviews:
            review_dt = datetime.fromisoformat(review.get("submitted_at", "").replace('Z', '+00:00'))
            if review_dt.timestamp() > since_ts:
                all_reviews.append({
                    "repo": repo,
                    "pr_number": pr_num,
                    "review": review,
                    "pr_title": issue.get("title", ""),
                    "pr_url": issue.get("html_url", ""),
                })
    
    return all_reviews


def format_learning_entry(repo, item_type, number, title, url, author, body, timestamp, is_pr=True):
    """Format a learning entry for LEARNINGS.md."""
    # Generate unique ID
    entry_id = f"LRN-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S-%f')[:-3]}"
    
    type_label = "PR" if is_pr else "Issue"
    ref = f"{repo}#{number}"
    
    entry = f"""## [{entry_id}] correction

**Logged**: {timestamp}
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Correction/negative feedback from @{author} on {ref}

### Details
@{author} provided feedback that may indicate a correction or negative response to the trainee's engagement:

> {body[:500]}{'...' if len(body) > 500 else ''}

### Suggested Action
Review the feedback and adjust engagement strategy accordingly. If this is a technical correction, update the relevant learnings or code.

### Metadata
- Source: github_review
- Related Files: {ref}
- Tags: correction, feedback, trainee, engagement, {author}
- Pattern-Key: harden.engagement_feedback
- Recurrence-Count: 1
- First-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}
- Last-Seen: {datetime.now(timezone.utc).strftime('%Y-%m-%d')}

"""
    return entry


def append_to_learnings(entry):
    """Append a learning entry to LEARNINGS.md."""
    path = "/home/ubuntu/.openclaw/workspace/.learnings/LEARNINGS.md"
    with open(path, "a") as f:
        f.write(entry)


def main():
    repo = "francovp/cabros-bot"
    
    # Load last run timestamp
    last_run = load_last_run()
    if not last_run:
        logger.info("No last run timestamp found, using 24 hours ago")
        last_run = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    
    logger.info(f"Scanning for activity since: {last_run}")
    
    # Initialize GitHub App client
    try:
        client = GitHubAppClient()
    except ConfigurationError as e:
        logger.error(f"Failed to initialize GitHub App client: {e}")
        return 1
    
    # Load engaged issues
    engaged = load_engaged_issues()
    logger.info(f"Previously engaged issues/PRs: {engaged}")
    
    # Fetch recent comments
    comments = fetch_recent_comments(client, repo, last_run)
    logger.info(f"Found {len(comments)} new comments since last run")
    
    # Fetch recent reviews
    reviews = fetch_recent_reviews(client, repo, last_run)
    logger.info(f"Found {len(reviews)} new reviews since last run")
    
    new_learnings = 0
    
    # Process comments
    for item in comments:
        comment = item["comment"]
        author = (comment.get("user") or {}).get("login", "").lower()
        body = comment.get("body", "")
        issue_num = item["issue_number"]
        is_pr = item["is_pr"]
        title = item["issue_title"]
        url = item["issue_url"]
        
        # Skip if not from tracked accounts
        if author not in TRACKED_ACCOUNTS:
            continue
        
        # Skip if from trainee accounts (our own comments)
        if author in TRAINEE_ACCOUNTS:
            continue
        
        # Check if this is correction/negative feedback
        if not is_correction(body):
            logger.debug(f"Comment from {author} on {repo}#{issue_num} is not a correction")
            continue
        
        # Create a unique key for this engagement
        engagement_key = f"{repo}#{issue_num}-{comment.get('id')}"
        
        if engagement_key in engaged:
            logger.debug(f"Already processed engagement: {engagement_key}")
            continue
        
        # Log the learning
        timestamp = comment.get("updated_at", datetime.now(timezone.utc).isoformat())
        entry = format_learning_entry(
            repo, "comment", issue_num, title, url, author, body, timestamp, is_pr
        )
        append_to_learnings(entry)
        engaged.add(engagement_key)
        new_learnings += 1
        logger.info(f"Logged correction from @{author} on {repo}#{issue_num}")
    
    # Process reviews
    for item in reviews:
        review = item["review"]
        author = (review.get("user") or {}).get("login", "").lower()
        body = review.get("body", "")
        pr_num = item["pr_number"]
        title = item["pr_title"]
        url = item["pr_url"]
        
        # Skip if not from tracked accounts
        if author not in TRACKED_ACCOUNTS:
            continue
        
        # Skip if from trainee accounts
        if author in TRAINEE_ACCOUNTS:
            continue
        
        # Check if this is correction/negative feedback
        if not is_correction(body):
            # Also check review state
            state = review.get("state", "").lower()
            if state not in ("changes_requested", "commented"):
                logger.debug(f"Review from {author} on {repo}#{pr_num} is not a correction (state: {state})")
                continue
        
        engagement_key = f"{repo}#{pr_num}-review-{review.get('id')}"
        
        if engagement_key in engaged:
            logger.debug(f"Already processed review engagement: {engagement_key}")
            continue
        
        timestamp = review.get("submitted_at", datetime.now(timezone.utc).isoformat())
        entry = format_learning_entry(
            repo, "review", pr_num, title, url, author, body, timestamp, is_pr=True
        )
        append_to_learnings(entry)
        engaged.add(engagement_key)
        new_learnings += 1
        logger.info(f"Logged correction review from @{author} on {repo}#{pr_num}")
    
    # Save engaged issues
    save_engaged_issues(engaged)
    
    # Update last run timestamp
    new_timestamp = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    save_last_run(new_timestamp)
    
    logger.info(f"Scan complete. New learnings logged: {new_learnings}")
    logger.info(f"Updated last run to: {new_timestamp}")
    
    return 0


if __name__ == "__main__":
    sys.exit(main())