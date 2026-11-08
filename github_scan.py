import requests
import datetime
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import os
import json
import sys

# Credentials
APP_ID = "4766306"
KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_app_token():
    print("Loading private key...", file=sys.stderr)
    with open(KEY_PATH, "rb") as key_file:
        private_key = serialization.load_pem_private_key(
            key_file.read(),
            password=None,
            backend=default_backend()
        )

    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    payload = {
        "iat": now,
        "exp": now + (10 * 60),
        "iss": APP_ID,
    }
    
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    
    headers = {
        "Authorization": f"Bearer {encoded_jwt}",
        "Accept": "application/vnd.github+json",
    }
    
    print("Fetching installations...", file=sys.stderr)
    res = requests.get("https://api.github.com/app/installations", headers=headers)
    res.raise_for_status()
    installations = res.json()
    
    if not installations:
        raise Exception("No installations found for this app.")
    
    installation_id = installations[0]['id']
    print(f"Using installation ID: {installation_id}", file=sys.stderr)
    
    token_res = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers=headers
    )
    token_res.raise_for_status()
    return token_res.json()['token']

def fetch_activity(token, last_run):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    
    print(f"Fetching activity since {last_run}...", file=sys.stderr)
    # Convert unix timestamp to ISO 8601 if needed
    try:
        if int(last_run) > 1000000000:
            last_run_iso = datetime.datetime.fromtimestamp(int(last_run), datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        else:
            last_run_iso = last_run
    except ValueError:
        last_run_iso = last_run

    url = f"https://api.github.com/repos/{REPO}/issues?since={last_run_iso}&state=all"
    res = requests.get(url, headers=headers)
    res.raise_for_status()
    items = res.json()
    
    activity = []
    for item in items:
        type_ = "PR" if "pull_request" in item else "Issue"
        activity.append({
            "number": item["number"],
            "title": item["title"],
            "type": type_,
            "updated_at": item["updated_at"],
            "url": item["html_url"],
            "body": item.get("body", "")
        })
        
        comments_url = f"https://api.github.com/repos/{REPO}/issues/{item['number']}/comments"
        c_res = requests.get(comments_url, headers=headers)
        if c_res.status_code == 200:
            comments = c_res.json()
            for c in comments:
                if c['updated_at'] > last_run:
                    activity.append({
                        "number": item["number"],
                        "type": "Comment",
                        "user": c["user"]["login"],
                        "body": c["body"],
                        "updated_at": c["updated_at"],
                        "url": c["html_url"]
                    })
    
    return activity

def post_comment(token, issue_number, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    res = requests.post(url, headers=headers, json={"body": body})
    res.raise_for_status()
    return res.json()

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 github_scan.py <last_run_timestamp>")
        sys.exit(1)
        
    last_run = sys.argv[1]
    try:
        token = get_app_token()
        activity = fetch_activity(token, last_run)
        print(json.dumps(activity))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
