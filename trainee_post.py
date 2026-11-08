import os
import jwt
import requests
import time

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

def post_comment(token, item_type, item_number, body):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    endpoint = "issues" if item_type == "issue" else "issues" # PRs use issues endpoint for comments
    url = f"https://api.github.com/repos/{REPO}/{endpoint}/{item_number}/comments"
    resp = requests.post(url, headers=headers, json={"body": body})
    resp.raise_for_status()
    return resp.json()

if __name__ == "__main__":
    token = get_installation_token()
    
    comments = [
        {
            "type": "issue",
            "number": 886,
            "body": "Thank you for the detailed explanation, @gigachad-senior-dev! The YAGNI point makes a lot of sense—I was definitely thinking too much about the 'perfect' architecture and not enough about delivering value today. 😅\n\nI'm really excited about the learning task! I'll start mapping out the duplication between the bridges. Yes, please! If you could send over the current bridge files, that would be a huge help for me to get started. I'll aim to have that `type/tech-debt` issue opened soon!"
        },
        {
            "type": "issue",
            "number": 543,
            "body": "Ah, I see! The difference between project-level disaster recovery and operational recovery is a great distinction. I didn't consider that a 24h window could be too wide for TTL-deleted data. The temporal granularity argument totally clears it up for me. Thanks for the pro tip on combining both strategies!"
        },
        {
            "type": "pull_request",
            "number": 905,
            "body": "Hi @francovp! I'm still learning about orchestration patterns, and this concurrency governor caught my eye. Quick question: why go with a 'governor' approach here instead of a standard request queue or a simple semaphore/rate-limiter? Does the governor handle different priorities between surfaces (like giving Telegram priority over WhatsApp), or is it a flat cap across everything?"
        },
        {
            "type": "pull_request",
            "number": 899,
            "body": "This caching for TradingView MCP results looks like a great perf win! I'm curious about the TTL strategy—since market data is so volatile, how do we determine the 'safe' window for a cached analysis? Is there a mechanism to force-refresh the cache if a significant market event happens, or is it strictly time-based?"
        }
    ]
    
    for c in comments:
        try:
            post_comment(token, c["type"], c["number"], c["body"])
            print(f"Posted to {c['type']} #{c['number']}")
        except Exception as e:
            print(f"Failed to post to {c['number']}: {e}")
