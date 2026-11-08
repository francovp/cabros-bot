#!/usr/bin/env python3
"""
Scan recent PRs/Issues for activity since last run.
"""
import sys
import os

sys.path.insert(0, "/home/ubuntu/.openclaw/workspace/trainee-tooling")

from github_app_client import GitHubAppClient, IdempotencyStore

def main():
    client = GitHubAppClient()
    store = IdempotencyStore()
    repo = "francovp/cabros-bot"
    
    print(f"Scanning {repo} for recent activity...")
    
    # Get open issues (which includes PRs)
    try:
        issues = client.list_issues(repo, state="open", per_page=50)
        print(f"Found {len(issues)} open issues/PRs")
        
        # Filter for PRs (have pull_request key) and regular issues
        prs = [i for i in issues if "pull_request" in i]
        regular_issues = [i for i in issues if "pull_request" not in i]
        
        print(f"  PRs: {len(prs)}")
        print(f"  Issues: {len(regular_issues)}")
        
        # Check recent PRs for unseen reviews/comments
        for pr in prs[:10]:  # Limit to 10 most recent
            pr_number = pr.get("number")
            print(f"\n--- Checking PR #{pr_number}: {pr.get('title', '')[:60]} ---")
            
            # Check unseen comments
            try:
                unseen_comments = client.get_unseen_comments(repo, pr_number, store=store)
                if unseen_comments:
                    print(f"  Found {len(unseen_comments)} unseen comments")
                    for comment in unseen_comments:
                        author = comment.get("user", {}).get("login", "unknown")
                        body = comment.get("body", "")[:200]
                        print(f"    @{author}: {body}...")
                        
                        if author.lower() in ["francovp", "gigachad-senior-dev"]:
                            body_lower = body.lower()
                            if any(phrase in body_lower for phrase in ["no", "wrong", "incorrect", "don't", "dont", "stop", "bad", "reject", "skip"]):
                                print(f"    ⚠️  NEGATIVE FEEDBACK from @{author}!")
                                log_negative_feedback(f"{repo}#{pr_number}", author, comment.get("body", ""))
                else:
                    print(f"  No new comments")
            except Exception as e:
                print(f"  Error checking comments: {e}")
            
            # Check unseen reviews
            try:
                unseen_reviews = client.get_unseen_reviews(repo, pr_number, store=store)
                if unseen_reviews:
                    print(f"  Found {len(unseen_reviews)} unseen reviews")
                    for review in unseen_reviews:
                        author = review.get("user", {}).get("login", "unknown")
                        body = review.get("body", "")[:200]
                        state = review.get("state", "unknown")
                        print(f"    @{author} ({state}): {body}...")
                        
                        if author.lower() in ["francovp", "gigachad-senior-dev"]:
                            body_lower = body.lower()
                            if state == "CHANGES_REQUESTED" or any(phrase in body_lower for phrase in ["no", "wrong", "incorrect", "don't", "dont", "stop", "bad", "reject", "skip"]):
                                print(f"    ⚠️  NEGATIVE REVIEW from @{author}!")
                                log_negative_feedback(f"{repo}#{pr_number}", author, review.get("body", ""))
                else:
                    print(f"  No new reviews")
            except Exception as e:
                print(f"  Error checking reviews: {e}")
        
        # Also check recent regular issues
        for issue in regular_issues[:10]:
            issue_number = issue.get("number")
            print(f"\n--- Checking Issue #{issue_number}: {issue.get('title', '')[:60]} ---")
            
            try:
                unseen_comments = client.get_unseen_comments(repo, issue_number, store=store)
                if unseen_comments:
                    print(f"  Found {len(unseen_comments)} unseen comments")
                    for comment in unseen_comments:
                        author = comment.get("user", {}).get("login", "unknown")
                        body = comment.get("body", "")[:200]
                        print(f"    @{author}: {body}...")
                        
                        if author.lower() in ["francovp", "gigachad-senior-dev"]:
                            body_lower = body.lower()
                            if any(phrase in body_lower for phrase in ["no", "wrong", "incorrect", "don't", "dont", "stop", "bad", "reject", "skip"]):
                                print(f"    ⚠️  NEGATIVE FEEDBACK from @{author}!")
                                log_negative_feedback(f"{repo}#{issue_number}", author, comment.get("body", ""))
                else:
                    print(f"  No new comments")
            except Exception as e:
                print(f"  Error checking comments: {e}")
                
    except Exception as e:
        print(f"Error listing issues: {e}")
        import traceback
        traceback.print_exc()

def log_negative_feedback(thread_key, author, body):
    """Log negative feedback to .learnings/LEARNINGS.md"""
    import datetime
    import hashlib
    
    today = datetime.datetime.utcnow().strftime("%Y%m%d")
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