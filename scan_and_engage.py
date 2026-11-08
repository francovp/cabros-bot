#!/usr/bin/env python3
"""
Scan for GitHub activity since last run and engage as Virgin Trainee.
"""
import sys
import os

# Add the trainee-tooling directory to the path
sys.path.insert(0, "/home/ubuntu/.openclaw/workspace/trainee-tooling")

from github_app_client import GitHubAppClient, IdempotencyStore

def main():
    client = GitHubAppClient()
    store = IdempotencyStore()
    repo = "francovp/cabros-bot"
    
    print(f"Scanning {repo} for activity since last run...")
    
    # Get all tracked threads from the store
    store._load()
    threads = store._data.get("threads", {})
    
    print(f"Found {len(threads)} tracked threads in state")
    
    # For each thread, check for unseen comments and reviews
    for thread_key, thread_data in threads.items():
        if not thread_key.startswith(repo + "#"):
            continue
            
        issue_number = int(thread_key.split("#")[1])
        cursor = thread_data.get("cursor")
        
        print(f"\n--- Checking {thread_key} (cursor: {cursor}) ---")
        
        # Get unseen issue comments
        try:
            unseen_comments = client.get_unseen_comments(repo, issue_number, store=store)
            if unseen_comments:
                print(f"  Found {len(unseen_comments)} unseen comments")
                for comment in unseen_comments:
                    author = comment.get("user", {}).get("login", "unknown")
                    body = comment.get("body", "")[:200]
                    print(f"    @{author}: {body}...")
                    
                    # Check for negative feedback from specific users
                    if author.lower() in ["francovp", "gigachad-senior-dev"]:
                        body_lower = body.lower()
                        if any(phrase in body_lower for phrase in ["no", "wrong", "incorrect", "don't", "dont", "stop", "bad", "reject"]):
                            print(f"    ⚠️  NEGATIVE FEEDBACK from @{author}!")
                            log_negative_feedback(thread_key, author, comment.get("body", ""))
            else:
                print(f"  No new comments")
        except Exception as e:
            print(f"  Error checking comments: {e}")
        
        # If it's a PR, also check for unseen reviews
        # We can't easily know if it's a PR from the issue number alone
        # but we can try to get reviews anyway
        try:
            unseen_reviews = client.get_unseen_reviews(repo, issue_number, store=store)
            if unseen_reviews:
                print(f"  Found {len(unseen_reviews)} unseen reviews")
                for review in unseen_reviews:
                    author = review.get("user", {}).get("login", "unknown")
                    body = review.get("body", "")[:200]
                    state = review.get("state", "unknown")
                    print(f"    @{author} ({state}): {body}...")
                    
                    if author.lower() in ["francovp", "gigachad-senior-dev"]:
                        body_lower = body.lower()
                        if state == "CHANGES_REQUESTED" or any(phrase in body_lower for phrase in ["no", "wrong", "incorrect", "don't", "dont", "stop", "bad", "reject"]):
                            print(f"    ⚠️  NEGATIVE REVIEW from @{author}!")
                            log_negative_feedback(thread_key, author, review.get("body", ""))
            else:
                print(f"  No new reviews")
        except Exception as e:
            print(f"  Error checking reviews: {e}")

def log_negative_feedback(thread_key, author, body):
    """Log negative feedback to .learnings/LEARNINGS.md"""
    import datetime
    import hashlib
    
    # Generate ID
    today = datetime.datetime.utcnow().strftime("%Y%m%d")
    # Use a hash of the content for uniqueness
    content_hash = hashlib.md5(f"{thread_key}{author}{body}".encode()).hexdigest()[:6]
    lr_id = f"LRN-{today}-{content_hash}"
    
    entry = f"""## [{lr_id}] correction

**Logged**: {datetime.datetime.utcnow().isoformat()}Z
**Priority**: high
**Status**: pending
**Area**: process

### Summary
@{author} negative feedback on {thread_key}: {body[:100]}...

### Details
Received negative feedback from @{author} on {thread_key}.

### Suggested Action
Review the feedback and adjust engagement strategy accordingly.

### Metadata
- Source: github_review
- Tags: correction, feedback, virgin-trainee, negative-feedback
- See Also: {thread_key}

---
"""
    
    learnings_path = "/home/ubuntu/.openclaw/workspace/.learnings/LEARNINGS.md"
    with open(learnings_path, "a") as f:
        f.write(entry)
    
    print(f"    📝 Logged to LEARNINGS.md as {lr_id}")

if __name__ == "__main__":
    main()