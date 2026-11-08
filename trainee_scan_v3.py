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
    resp = requests.get(
        f"https://api.github.com/app/installations",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    resp.raise_for_status()
    installations = resp.json()
    installation_id = installations[0]['id']
    token_resp = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    token_resp.raise_for_status()
    return token_resp.json()['token']

def scan_activity(token, since):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    # Use 'issues' endpoint (covers both issues and PRs)
    url = f"https://api.github.com/repos/{REPO}/issues?since={since}&state=all"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    items = resp.json()
    
    results = {
        "activity": [],
        "feedback": []
    }
    
    seniors = ["francovp", "gigachad-senior-dev"]
    
    for item in items:
        item_number = item['number']
        item_type = "pull_request" if "pull_request" in item else "issue"
        
        comments_url = item['comments_url']
        comm_resp = requests.get(comments_url, headers=headers)
        comm_resp.raise_for_status()
        comments = comm_resp.json()
        
        has_trainee_comment = False
        for comment in comments:
            user = comment['user']['login']
            body = comment['body']
            
            if "virgin-trainee-dev" in user:
                has_trainee_comment = True
            
            if user in seniors:
                # Check if it's a response to the trainee
                # Simple check: does it mention "trainee" or is it after a trainee comment?
                # For now, we'll collect all senior comments on items the trainee touched.
                results["feedback"].append({
                    "item_number": item_number,
                    "item_type": item_type,
                    "user": user,
                    "body": body,
                    "comment_id": comment['id']
                })
        
        results["activity"].append({
            "number": item_number,
            "type": item_type,
            "title": item['title'],
            "url": item['html_url'],
            "has_trainee_comment": has_trainee_comment
        })
        
    return results

if __name__ == "__main__":
    with open(LAST_RUN_FILE, 'r') as f:
        since = f.read().strip()
        
    token = get_installation_token()
    data = scan_activity(token, since)
    
    print("--- ACTIVITY ---")
    for a in data["activity"]:
        status = "[X]" if a["has_trainee_comment"] else "[ ]"
        print(f"{status} {a['type']} #{a['number']}: {a['title']}")
        
    print("\n--- SENIOR FEEDBACK ---")
    for f in data["feedback"]:
        print(f"{f['user']} in {f['item_type']} #{f['item_number']}: {f['body'][:200]}...")
