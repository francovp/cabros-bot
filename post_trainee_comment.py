import os
import time
import jwt
import requests
from datetime import datetime, timedelta

# Configuration
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_jwt():
    with open(PRIVATE_KEY_PATH, "r") as f:
        private_key = f.read()
    
    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + (10 * 60),
        "iss": APP_ID,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_token(jwt_token):
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json",
    }
    # Find the installation for the repo
    # We can just list installations and pick the one for the org/user
    res = requests.get("https://api.github.com/app/installations", headers=headers)
    res.raise_for_status()
    installations = res.json()
    
    # In this case, we expect only one installation or we search for the right one.
    # Usually for this setup, there's only one relevant installation.
    installation_id = installations[0]["id"]
    
    # Get token for that installation
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    res = requests.post(url, headers=headers)
    res.raise_for_status()
    return res.json()["token"]

def post_comment(token, pr_number, body):
    url = f"https://api.github.com/repos/{REPO}/issues/{pr_number}/comments"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    data = {"body": body}
    res = requests.post(url, headers=headers, json=data)
    res.raise_for_status()
    print(f"Successfully posted comment to PR #{pr_number}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python post_trainee_comment.py <pr_number> <comment_body>")
        sys.exit(1)
    
    pr_num = sys.argv[1]
    comment_body = sys.argv[2]
    
    try:
        jwt_token = get_jwt()
        token = get_installation_token(jwt_token)
        post_comment(token, pr_num, comment_body)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
