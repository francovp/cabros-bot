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

def post_comment(token, item_type, item_id, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    # PR comments go to issues endpoint
    url = f"https://api.github.com/repos/{REPO}/issues/{item_id}/comments"
        
    res = requests.post(url, headers=headers, json={"body": body})
    res.raise_for_status()
    print(f"Successfully posted to {item_type} #{item_id}")

if __name__ == "__main__":
    jwt_token = get_jwt()
    token = get_installation_token(jwt_token)
    
    body = "Hi! As a trainee, I've been reading through this implementation of the burst aggregator. The logic to use `(side, routingHash)` for the aggregation key is super clever—it's interesting how it handles both side-matching and routing isolation. I have one question: if the `ALERT_BURST_MIN_SIGNALS` threshold is never met within the `ALERT_BURST_WINDOW_MS`, and we fallback to individual delivery, are those alerts logged separately in a way that makes it easy to debug *why* they weren't aggregated? I'm trying to learn more about how we handle observability for fallback paths. Thanks! 😊"
    
    try:
        post_comment(token, "pr", 1106, body)
    except Exception as e:
        print(f"Failed to post to pr #1106: {e}")
