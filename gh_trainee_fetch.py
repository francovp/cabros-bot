import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
SINCE = "2026-08-30T02:01:42Z"

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

def fetch_comments(token, issue_number):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    response = requests.get(url, headers=headers)
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
                for item in items:
                    print(f"--- ITEM #{item['number']} ---")
                    print(f"Title: {item['title']}")
                    print(f"URL: {item['html_url']}")
                    print(f"Body: {item['body']}")
                    print("\nComments:")
                    comments = fetch_comments(token, item['number'])
                    for c in comments:
                        print(f"{c['user']['login']}: {c['body']}")
                    print("\n" + "="*40 + "\n")
        else:
            print("No installations found.")
    except Exception as e:
        print(f"Error: {e}")
