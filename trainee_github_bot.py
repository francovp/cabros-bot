import jwt
import time
import requests
import os
from datetime import datetime

# Config
APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
LAST_RUN_FILE = "memory/github-last-run.txt"

def get_installation_token():
    with open(PEM_PATH, 'r') as f:
        private_key = f.read()

    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID,
    }
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    
    # Get installation ID for the repo
    headers = {"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    res = requests.get(f"https://api.github.com/app/installations", headers=headers)
    res.raise_for_status()
    installations = res.json()
    
    # Find installation for the specific repo
    # Simplified: take the first one if only one, or filter by account
    # For this case, we assume the app is installed on francovp
    installation_id = installations[0]['id']
    
    # Get token
    token_res = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers=headers
    )
    token_res.raise_for_status()
    return token_res.json()['token']

def post_comment(token, issue_number, body):
    url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json"
    }
    res = requests.post(url, headers=headers, json={"body": body})
    res.raise_for_status()
    return res.json()

def main():
    token = get_installation_token()
    
    # Targets and comments
    comments = [
        {
            "number": 552,
            "body": "Hi @francovp! I'm just starting to wrap my head around the MCP integration. For the process-local cache, would a short TTL eventually lead to redundant API calls across different worker processes? I was wondering if we should look into a shared cache, or if the current approach is the most efficient for this specific use case. Thanks! 🤖"
        },
        {
            "number": 671,
            "body": "Excuse me @francovp, I had a quick question about the suppression logic here. If the signal is identical but the market context has shifted slightly, could we be suppressing a valid 're-entry' signal? I'm curious how we balance noise reduction with the risk of missing repeat opportunities. Sorry if this is a basic question! 🤖"
        }
    ]
    
    for c in comments:
        print(f"Posting to #{c['number']}...")
        post_comment(token, c['number'], c['body'])
    
    # Update state
    with open(LAST_RUN_FILE, "w") as f:
        f.write(datetime.utcnow().isoformat() + "Z")

if __name__ == "__main__":
    main()
