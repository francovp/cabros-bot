import os
import jwt
import requests
import time
from datetime import datetime

# Configuration
APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
LAST_RUN_FILE = "/home/ubuntu/.openclaw/workspace/github-last-run.txt"

def get_installation_token():
    with open(PEM_PATH, 'r') as f:
        private_key = f.read()

    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID,
    }
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")

    # Find installation ID for the repo
    resp = requests.get(
        f"https://api.github.com/app/installations",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    resp.raise_for_status()
    installations = resp.json()
    
    # We assume the first installation is the correct one for this repo for simplicity, 
    # or we search for the one that has access to the repo.
    # In a real scenario, we'd filter by account.
    installation_id = installations[0]['id']
    
    # Get token
    token_resp = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    token_resp.raise_for_status()
    return token_resp.json()['token']

def scan_activity(token, since):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    
    # Issues and PRs
    url = f"https://api.github.com/repos/{REPO}/issues?since={since}&state=all"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    items = resp.json()
    
    activity = {
        "new_or_updated": [],
        "mentions": []
    }
    
    for item in items:
        # Check for mentions in comments
        comments_url = item['comments_url']
        comm_resp = requests.get(comments_url, headers=headers)
        comm_resp.raise_for_status()
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

if __name__ == "__main__":
    with open(LAST_RUN_FILE, 'r') as f:
        since = f.read().strip()
        
    token = get_installation_token()
    activity = scan_activity(token, since)
    
    print("--- NEW OR UPDATED ---")
    for item in activity["new_or_updated"]:
        print(f"{item['type']} #{item['number']}: {item['title']}")
        print(f"URL: {item['url']}")
        print("-" * 20)
        
    print("\n--- MENTIONS ---")
    for m in activity["mentions"]:
        print(f"User {m['user']} mentioned trainee in {m['item_type']} #{m['item_number']}")
        print(f"Comment: {m['comment_body']}")
        print("-" * 20)
