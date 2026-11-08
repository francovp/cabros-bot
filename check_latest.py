import os
import jwt
import requests
import time
from datetime import datetime, timezone

# Configuration
APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

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
    
    # Find installation for francovp account
    installation_id = None
    for inst in installations:
        if inst['account']['login'] == 'francovp':
            installation_id = inst['id']
            break
    
    if not installation_id:
        # Fallback to first
        installation_id = installations[0]['id']
    
    # Get token
    token_resp = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    token_resp.raise_for_status()
    return token_resp.json()['token']

def check_latest_activity(token, limit=10):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    
    # Check recent issues
    print("=== LATEST ISSUES/PRs ===")
    url = f"https://api.github.com/repos/{REPO}/issues?state=all&per_page={limit}&sort=created&direction=desc"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    issues = resp.json()
    
    for item in issues:
        if "pull_request" in item:
            print(f"PR #{item['number']}: {item['title']} by @{item['user']['login']} - {item['created_at']}")
        else:
            print(f"Issue #{item['number']}: {item['title']} by @{item['user']['login']} - {item['created_at']}")

if __name__ == "__main__":
    try:
        token = get_installation_token()
        print(f"Got installation token")
        check_latest_activity(token, 10)
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()