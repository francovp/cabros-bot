import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
CLIENT_ID = "Iv23liR3I0JFZYWZjtcP"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
COMMENT_TEXT = "🤖 Hello from Cabrobot! Testing GitHub App integration."

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
    # We can list installations for the app
    response = requests.get("https://api.github.com/app/installations", headers=headers)
    response.raise_for_status()
    installations = response.json()
    
    # To be precise, we should check which installation has access to the repo.
    # But often there's only one for the target user.
    # Let's just check the first one or search.
    for inst in installations:
        # We can't easily check repo access from the list, 
        # but we can try to get a token and see if it works.
        return inst["id"]
    return None

def get_access_token(jwt_token, installation_id):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    return response.json()["token"]

def comment_on_last_issue(token):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    # Find last issue
    url = f"https://api.github.com/repos/{REPO}/issues?state=all&sort=created&direction=desc&per_page=1"
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    issues = response.json()
    if not issues:
        print("No issues found.")
        return
    
    issue_number = issues[0]["number"]
    print(f"Commenting on issue #{issue_number}...")
    
    # Post comment
    comment_url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    response = requests.post(comment_url, headers=headers, json={"body": COMMENT_TEXT})
    response.raise_for_status()
    print(f"Successfully commented on issue #{issue_number}!")

if __name__ == "__main__":
    try:
        jwt_t = get_jwt()
        inst_id = get_installation_id(jwt_t)
        if inst_id:
            token = get_access_token(jwt_t, inst_id)
            comment_on_last_issue(token)
        else:
            print("No installations found for this app.")
    except Exception as e:
        print(f"Error: {e}")
