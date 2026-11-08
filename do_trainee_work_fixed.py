#!/usr/bin/env python3

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
import time
import requests
import jwt

# Configuration
REPO = "francovp/cabros-bot"
ENGAGED_FILE = ".trainee-engaged.json"
LEARNINGS_FILE = ".learnings/LEARNINGS.md"
POST_SCRIPT = "post_github_comment.py"
TARGET_USERS = {"francovp", "gigachad-senior-dev"}
CORRECTION_INDICATORS = [
    "correction", "corrected", "wrong", "incorrect", "no,", "no.",
    "that's not", "that is not", "actually", "you're wrong",
    "this is wrong", "this isn't", "not right", "mistake",
    "fix this", "change this", "should be", "must be",
    "incorrectly", "misunderstand", "misunderstood"
]

def run_cmd(cmd):
    """Run a command and return stdout, stderr, and return code."""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, check=False)
        return result.stdout, result.stderr, result.returncode
    except Exception as e:
        return "", str(e), 1

def load_engaged_data():
    """Load the engaged data from the JSON file."""
    if not os.path.exists(ENGAGED_FILE):
        return {"lastRun": None, "engagedIssues": []}
    with open(ENGAGED_FILE, 'r') as f:
        return json.load(f)

def save_engaged_data(data):
    """Save the engaged data to the JSON file."""
    with open(ENGAGED_FILE, 'w') as f:
        json.dump(data, f, indent=2)

def get_last_run_time(engaged_data):
    """Get the last run time as a datetime object."""
    last_run_str = engaged_data.get("lastRun")
    if last_run_str:
        # Parse the ISO string
        return datetime.fromisoformat(last_run_str.replace("Z", "+00:00"))
    else:
        # If no last run, use a long time ago
        return datetime(2020, 1, 1, tzinfo=timezone.utc)

def get_installation_token():
    """Get an installation token for the GitHub App."""
    with open("/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem", "r") as f:
        private_key = f.read()

    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": "4766306",
    }
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")

    resp = requests.get(
        f"https://api.github.com/app/installations",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    resp.raise_for_status()
    installations = resp.json()
    
    installation_id = None
    for inst in installations:
        if inst['account']['login'] == 'francovp':
            installation_id = inst['id']
            break
    
    if not installation_id:
        installation_id = installations[0]['id']
    
    token_resp = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    token_resp.raise_for_status()
    return token_resp.json()["token"]

def get_updated_items(token, since_dt):
    """Get issues and PRs updated since the given datetime."""
    # Format the datetime for the GitHub API
    since_str = since_dt.isoformat(timespec='seconds')
    if since_str.endswith('+00:00'):
        since_str = since_str.replace('+00:00', 'Z')
    
    # Get issues and PRs (the issues API returns both)
    url = f"https://api.github.com/repos/{REPO}/issues?since={since_str}&state=all"
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    
    resp = requests.get(url, headers=headers)
    if resp.status_code != 200:
        print(f"Error fetching updated items: {resp.status_code} {resp.text}", file=sys.stderr)
        return []
    
    items = resp.json()
    
    activity = {
        "new_or_updated": [],
        "mentions": []
    }
    
    for item in items:
        # Check for mentions in comments
        comments_url = item['comments_url']
        comm_resp = requests.get(comments_url, headers=headers)
        if comm_resp.status_code != 200:
            print(f"Error fetching comments for {item['number']}: {comm_resp.status_code} {comm_resp.text}", file=sys.stderr)
            continue
        comments = comm_resp.json()
        
        for comment in comments:
            # Trainee identity: typically the app name or a specific handle. 
            # Since the prompt says "mentions of the GitHub App (or the 'trainee' identity)",
            # I'll check for "trainee" or "cabros-bot-trainee".
            body = comment['body'].lower()
            if "trainee" in body or "cabros-bot-trainee" in body:
                activity["mentions"].append({
                    "item_id": item['id'],
                    "item_number": item['number'],
                    "item_type": "pull_request" if "pull_request" in item else "issue",
                    "comment_id": comment['id'],
                    "comment_body": comment['body'],
                    "user": comment['user']['login']
                })
        
        activity["new_or_updated"].append({
            "number": item['number'],
            "title": item['title'],
            "type": "pull_request" if "pull_request" in item else "issue",
            "url": item['html_url'],
            "body": item['body']
        })
    
    return activity

def post_comment(item_number, item_type, body):
    """Post a comment using the post_github_comment.py script."""
    # The script expects: issue_number and body
    # It works for both issues and PRs because PR comments are via the issues API
    # Use subprocess with list args to avoid shell quoting issues
    try:
        result = subprocess.run(
            ["python3", POST_SCRIPT, str(item_number), body],
            capture_output=True,
            text=True,
            check=False
        )
        if result.returncode != 0:
            print(f"Failed to post comment to {item_type} #{item_number}: {result.stderr}", file=sys.stderr)
            return False
        else:
            print(f"Posted comment to {item_type} #{item_number}")
            return True
    except Exception as e:
        print(f"Error posting comment to {item_type} #{item_number}: {e}", file=sys.stderr)
        return False

def get_comments_since(token, item_number, since_dt):
    """Get comments on an issue or PR since the given datetime."""
    since_str = since_dt.isoformat(timespec='seconds')
    if since_str.endswith('+00:00'):
        since_str = since_str.replace('+00:00', 'Z')
    
    # Use the GitHub API via gh to get comments
    cmd = f"gh api repos/{REPO}/issues/{item_number}/comments?since={since_str} --paginate"
    stdout, stderr, rc = run_cmd(cmd)
    if rc != 0:
        print(f"Error fetching comments for {item_number}: {stderr}", file=sys.stderr)
        return []
    
    try:
        comments = json.loads(stdout)
        return comments
    except json.JSONDecodeError:
        print(f"Error parsing comments JSON for {item_number}: {stderr}", file=sys.stderr)
        return []

def is_correction_comment(comment):
    """Check if a comment is a correction, negative feedback, or 'No' from target users."""
    user = comment.get("user", {}).get("login", "")
    if user not in TARGET_USERS:
        return False
    body = comment.get("body", "").lower()
    # Check for exact "no" or "no." or "no,"
    if body.strip() in ["no", "no.", "no,"]:
        return True
    # Check for indicators
    for indicator in CORRECTION_INDICATORS:
        if indicator in body:
            return True
    return False

def main():
    print("Loading engaged data...")
    engaged_data = load_engaged_data()
    last_run = get_last_run_time(engaged_data)
    engaged_set = set(engaged_data.get("engagedIssues", []))
    
    print(f"Last run: {last_run.isoformat()}")
    print(f"Engaged items count: {len(engaged_set)}")
    
    # Get installation token
    try:
        token = get_installation_token()
        print("Got installation token")
    except Exception as e:
        print(f"Failed to get installation token: {e}", file=sys.stderr)
        return
    
    # Get updated items since last run
    print("Fetching updated items since last run...")
    activity = get_updated_items(token, last_run)
    updated_items = activity["new_or_updated"]
    print(f"Found {len(updated_items)} updated items.")
    
    # Filter out items we've already engaged with
    new_items = []
    for item in updated_items:
        if item["number"] not in engaged_set:
            new_items.append(item)
    
    print(f"New items to engage: {len(new_items)}")
    
    # Engage with each new item
    commented_items = []
    for item in new_items:
        print(f"Engaging with {item['type']} #{item['number']}: {item['title']}")
        body = "Hello! I'm the Virgin Trainee bot. I've noticed this new issue/PR and I'm here to help. Please let me know if you need any assistance."
        if post_comment(item["number"], item["type"], body):
            commented_items.append(item)
            engaged_set.add(item["number"])
    
    # Update engaged data
    engaged_data["engagedIssues"] = list(engaged_set)
    engaged_data["lastRun"] = datetime.now(timezone.utc).isoformat()
    save_engaged_data(engaged_data)
    print(f"Updated engaged data with {len(engaged_set)} items.")
    
    # Now check for corrections from target users on the commented items since last run
    print("\nChecking for corrections from target users...")
    corrections = []
    for item in commented_items:
        comments = get_comments_since(token, item["number"], last_run)
        for comment in comments:
            if is_correction_comment(comment):
                corrections.append({
                    "item": item,
                    "comment": comment
                })
    
    print(f"Found {len(corrections)} correction comments.")
    
    # Log corrections to LEARNINGS.md
    if corrections:
        # Ensure the directory exists
        os.makedirs(os.path.dirname(LEARNINGS_FILE), exist_ok=True)
        
        # Read existing content
        existing_content = ""
        if os.path.exists(LEARNINGS_FILE):
            with open(LEARNINGS_FILE, 'r') as f:
                existing_content = f.read()
        
        # Append new corrections
        new_entries = []
        for corr in corrections:
            item = corr["item"]
            comment = corr["comment"]
            timestamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
            user = comment["user"]["login"]
            body = comment["body"].replace('\n', ' ').strip()
            entry = f"- [{timestamp}] @{user} on {item['type']} #{item['number']} ({item['title']}): {body}\n"
            new_entries.append(entry)
        
        new_content = existing_content + "".join(new_entries)
        
        # Write back
        with open(LEARNINGS_FILE, 'w') as f:
            f.write(new_content)
        
        print(f"Appended {len(new_entries)} corrections to {LEARNINGS_FILE}")
    else:
        print("No corrections to log.")
    
    # Check if LEARNINGS_FILE changed and commit if needed
    # We'll check if we appended anything
    if corrections:
        print("Committing and pushing learnings...")
        # Configure git for the app identity
        run_cmd("git config user.name 'Virgin Trainee'")
        run_cmd("git config user.email 'virgin.trainee@users.noreply.github.com'")
        
        # Add the learnings file
        stdout, stderr, rc = run_cmd(f"git add {LEARNINGS_FILE}")
        if rc != 0:
            print(f"Error adding {LEARNINGS_FILE}: {stderr}", file=sys.stderr)
        else:
            # Commit
            commit_msg = f"Add learnings from feedback on {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')} UTC"
            stdout, stderr, rc = run_cmd(f"git commit -m '{commit_msg}'")
            if rc != 0:
                print(f"Error committing: {stderr}", file=sys.stderr)
            else:
                # Push
                stdout, stderr, rc = run_cmd("git push")
                if rc != 0:
                    print(f"Error pushing: {stderr}", file=sys.stderr)
                else:
                    print("Successfully pushed learnings.")
    else:
        print("No changes to learnings, skipping commit and push.")
    
    print("\nDone.")

if __name__ == "__main__":
    main()