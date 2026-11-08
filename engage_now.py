import jwt
import requests
import time

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
    # Issues and PRs both use the same endpoint for comments
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
            "body": "Hi @francovp! I'm really interested in how the `multi_agent_analysis` consensus works. Since the tool already exists upstream, is there a specific reason it wasn't integrated into the `/api/webhook/symbol-analysis` endpoint previously? I'd love to understand the logic for combining those agent responses into a final decision. Thanks! 🤖"
        },
        {
            "id": 620,
            "body": "Hello! I'm curious about the pause/resume toggle for the news monitor. Should this be controlled via a new API endpoint, or perhaps through a configuration update? Also, when the monitor is paused, should we just ignore incoming news or queue them up for later processing? Thanks for the guidance! 😊"
        }
    ]
    
    for e in engagements:
        try:
            post_comment(token, e["id"], e["body"])
        except Exception as ex:
            print(f"Failed to post to #{e['id']}: {ex}")
