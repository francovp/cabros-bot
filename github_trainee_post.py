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
    # First, get the installation ID for the repo
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    res = requests.get(f"https://api.github.com/repos/{REPO}/installation", headers=headers)
    res.raise_for_status()
    installation_id = res.json()["id"]
    
    # Now get the installation access token
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    res = requests.post(url, headers=headers)
    res.raise_for_status()
    return res.json()["token"]

def post_comment(token, item_type, item_id, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    if item_type == "issue":
        url = f"https://api.github.com/repos/{REPO}/issues/{item_id}/comments"
    elif item_type == "pr":
        url = f"https://api.github.com/repos/{REPO}/issues/{item_id}/comments" # PRs use the issues API for comments
    else:
        raise ValueError("Unsupported item type")
        
    res = requests.post(url, headers=headers, json={"body": body})
    res.raise_for_status()
    print(f"Successfully posted to {item_type} #{item_id}")

if __name__ == "__main__":
    jwt_token = get_jwt()
    token = get_installation_token(jwt_token)
    
    comments = [
        {
            "type": "issue",
            "id": 941,
            "body": "Hi @francovp! I'm curious about the `demo` environment vs the `testnet` one. Are there specific API behaviors or data streams in the demo environment that make it preferable for certain tests compared to the testnet? I'm still learning how Binance segments these, so any insight would be great! Thanks! 😊"
        },
        {
            "type": "pr",
            "id": 940,
            "body": "Hello! I see we're recording signal outcomes for async TradingView jobs now. Since these are async, do we have to worry about the order of events when recording the outcome? Like, could a 'closed' signal arrive before the 'open' signal is fully processed in the database? I'd love to understand how we ensure the outcome is attributed to the right signal. Thanks!"
        },
        {
            "type": "pr",
            "id": 938,
            "body": "Hi @francovp and @gigachad-senior-dev! This PR looks really impactful. I noticed the part about 'short-circuiting deterministic misses'—I'm wondering, how does the system actually distinguish between a 'deterministic miss' (where the data simply doesn't exist) and a 'transient miss' (like a timeout or a temporary API glitch)? Is there a specific error code or a pattern in the MCP response that we're looking for? Thanks for the help! 🤖"
        }
    ]
    
    for c in comments:
        try:
            post_comment(token, c["type"], c["id"], c["body"])
        except Exception as e:
            print(f"Failed to post to {c['type']} #{c['id']}: {e}")
