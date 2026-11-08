import os
import jwt
import requests
import time
from datetime import datetime, timezone

# Configuration
APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
SINCE = "2026-09-30T14:21:18Z"  # From last run

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

def check_recent_activity(token):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    
    # Check issues since last run
    print("=== CHECKING ISSUES SINCE LAST RUN ===")
    url = f"https://api.github.com/repos/{REPO}/issues?since={SINCE}&state=all"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    issues = resp.json()
    
    print(f"Found {len(issues)} issues/PRs since {SINCE}")
    for item in issues:
        if "pull_request" in item:
            print(f"PR #{item['number']}: {item['title']} by @{item['user']['login']}")
        else:
            print(f"Issue #{item['number']}: {item['title']} by @{item['user']['login']}")
    
    # Check if any are new (not in the engaged list)
    engaged_file = "/home/ubuntu/.openclaw/workspace/.trainee-engaged.json"
    if os.path.exists(engaged_file):
        import json
        with open(engaged_file, 'r') as f:
            engaged_data = json.load(f)
        engaged_numbers = set(engaged_data.get('engagedIssues', []))
        
        print("\n=== NEW ITEMS NOT YET ENGAGED ===")
        new_items = []
        for item in issues:
            item_num = item['number']
            if item_num not in engaged_numbers:
                new_items.append(item)
                if "pull_request" in item:
                    print(f"NEW PR #{item['number']}: {item['title']} by @{item['user']['login']}")
                else:
                    print(f"NEW Issue #{item['number']}: {item['title']} by @{item['user']['login']}")
        
        return new_items
    else:
        print("No engagement file found, treating all as new")
        return issues

if __name__ == "__main__":
    try:
        token = get_installation_token()
        print(f"Got installation token")
        new_items = check_recent_activity(token)
        print(f"\nTotal new items to engage: {len(new_items)}")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()