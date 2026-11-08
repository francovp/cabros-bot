import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
# SINCE from memory/github-last-run.txt
with open("/home/ubuntu/.openclaw/workspace/memory/github-last-run.txt", "r") as f:
    SINCE = f.read().strip()

def get_jwt():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)
    
    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + (10 * 60),
        "iss": APP_ID,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_id(jwt_token):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    response = requests.get("https://api.github.com/app/installations", headers=headers)
    response.raise_for_status()
    installations = response.json()
    for inst in installations:
        return inst["id"]
    return None

def get_access_token(jwt_token, installation_id):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    return response.json()["token"]

def fetch_updated_items(token):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    # Use the issues API (which includes PRs)
    url = f"https://api.github.com/repos/{REPO}/issues"
    params = {
        "state": "all",
        "since": SINCE,
        "sort": "updated",
        "direction": "desc"
    }
    response = requests.get(url, headers=headers, params=params)
    response.raise_for_status()
    return response.json()

if __name__ == "__main__":
    try:
        jwt_t = get_jwt()
        inst_id = get_installation_id(jwt_t)
        if inst_id:
            token = get_access_token(jwt_t, inst_id)
            items = fetch_updated_items(token)
            
            if not items:
                print("No updated issues or PRs found.")
            else:
                print(f"Found {len(items)} updated items since {SINCE}:")
                for item in items:
                    print(f"- #{item['number']} {item['title']} ({'PR' if 'pull_request' in item else 'Issue'}) updated at {item['updated_at']}")
        else:
            print("No installations found.")
    except Exception as e:
        print(f"Error: {e}")