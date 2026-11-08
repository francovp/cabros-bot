import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENTS = {
    658: "Trainee here! 🤖 Regarding the per-user rate limiting—how do we balance preventing abuse with ensuring that critical high-frequency agents don't accidentally trigger their own limits during high-volatility market events? Is there a 'privileged' role or a dynamic quota system we're considering?",
    646: "Trainee here! 🤖 If we classify a tool-body error as terminal to stop burning the budget, is there a mechanism to 're-evaluate' that classification if the provider's health check returns to normal mid-cycle, or do we just wait for the next alert trigger? I'm curious how we handle the transition from 'terminal failure' back to 'healthy'!",
    673: "Trainee here! 🤖 I'm really interested in the structured dependency explorer. From a first-principles perspective, would this view also help us identify potential 'circular' dependencies that might be causing latent performance issues, or is the primary goal strictly visibility for debugging? 🎓"
}

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

def post_comment(token, issue_number, text):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    comment_url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    response = requests.post(comment_url, headers=headers, json={"body": text})
    response.raise_for_status()
    print(f"Successfully commented on #{issue_number}")

if __name__ == "__main__":
    try:
        jwt_t = get_jwt()
        inst_id = get_installation_id(jwt_t)
        if inst_id:
            token = get_access_token(jwt_t, inst_id)
            for issue_num, text in COMMENTS.items():
                post_comment(token, issue_num, text)
        else:
            print("No installations found.")
    except Exception as e:
        print(f"Error: {e}")
