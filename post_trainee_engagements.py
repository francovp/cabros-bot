import jwt
import requests
import time
from pathlib import Path

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_jwt():
    with open(PRIVATE_KEY_PATH, "r") as f:
        private_key = f.read()
    
    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_token(jwt_token):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    res = requests.get(f"https://api.github.com/repos/{REPO}/installation", headers=headers)
    res.raise_for_status()
    installation_id = res.json()["id"]
    
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    res = requests.post(url, headers=headers)
    res.raise_for_status()
    return res.json()["token"]

def post_comment(token, item_id, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    # All comments (Issues and PRs) use the issues API
    url = f"https://api.github.com/repos/{REPO}/issues/{item_id}/comments"
    res = requests.post(url, headers=headers, json={"body": body})
    res.raise_for_status()
    print(f"Successfully posted to #{item_id}")

if __name__ == "__main__":
    jwt_token = get_jwt()
    token = get_installation_token(jwt_token)
    
    engagements = [
        {
            "id": 634,
            "body": "Hi @francovp! I'm really interested in this multi-agent approach. I see that the `agents_debate` block provides different stances from the technical, sentiment, and risk analysts. When these agents are fundamentally conflicted (e.g., Technical is strongly Bullish but Risk is strongly Bearish), how does the `consensus` logic determine the final `decision`? Is it a simple weighted average of the scores, or does the Risk Manager have a 'veto' power that can force a HOLD regardless of the others? I'd love to understand the arbitration logic! 🤖"
        },
        {
            "id": 620,
            "body": "Hello! This pause/resume toggle seems like a great way to handle provider outages without needing a full redeploy. I noticed the pause state is intended to be process-local (in-memory). If we ever scale to multiple running instances of the bot, would a request to `/admin/news/pause` only affect the instance that received the request? If so, would moving this state to something like Redis be the next step for consistency, or is the current in-memory approach the right trade-off for now? Thanks for the insight! 🤖"
        }
    ]
    
    for e in engagements:
        try:
            post_comment(token, e["id"], e["body"])
        except Exception as ex:
            print(f"Failed to post to #{e['id']}: {ex}")
