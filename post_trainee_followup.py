import jwt
import requests
import time
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_jwt():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_token(jwt_token):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    response = requests.get("https://api.github.com/app/installations", headers=headers)
    response.raise_for_status()
    installations = response.json()
    installation_id = installations[0]["id"]
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    return response.json()["token"]

def post_comment(token, issue_number, body):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    response = requests.post(url, headers=headers, json={"body": body})
    response.raise_for_status()
    print(f"Successfully posted to #{issue_number}: {response.json()['html_url']}")

if __name__ == "__main__":
    jwt_token = get_jwt()
    token = get_installation_token(jwt_token)
    
    # Post follow-up on Issue #1169 (deployment provenance)
    body = "Following up on the rollout question—since this is purely additive metadata with fail-open semantics, would the rollout be a simple deploy without feature flags, or would we gate the stamping behind a `ENABLE_DEPLOYMENT_PROVENANCE` flag to allow gradual validation in production? Also, for the `/api/alerts/summary` rollup, should we deduplicate by (platform, gitSha) or also include service identity to distinguish multiple workers on the same commit? Thanks! 🤖"
    
    post_comment(token, 1169, body)