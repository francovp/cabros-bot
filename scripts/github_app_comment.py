import os
import jwt
import time
import requests
from datetime import datetime, timedelta

# Configuration
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def generate_jwt():
    with open(PRIVATE_KEY_PATH, "r") as f:
        private_key = f.read()
    
    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + (10 * 60),
        "iss": APP_ID,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_id():
    jwt_token = generate_jwt()
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/app/installations"
    # We search for the installation on the specific repo
    # Since the app is installed on the user/org, we list installations and filter or just assume the first one for this repo
    # Better: list installations for the app and find the one matching the owner
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    installations = response.json()
    for inst in installations:
        # The app might be installed on multiple accounts. We need the one for 'francovp'
        # Note: The API returns installations. We can check the account.login
        # However, simpler for this bot: use the first one if it's a single-user target
        return inst["id"]

def post_comment(issue_number, body):
    installation_id = get_installation_id()
    jwt_token = generate_jwt()
    
    # Get Installation Access Token
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    token = response.json()["token"]
    
    # Post Comment
    auth_headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    comment_url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    res = requests.post(comment_url, headers=auth_headers, json={"body": body})
    res.raise_for_status()
    print(f"Successfully posted comment to #{issue_number}")

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python3 script.py <issue_number> <body>")
        sys.exit(1)
    
    issue_num = sys.argv[1]
    comment_body = sys.argv[2]
    post_comment(issue_num, comment_body)
