import os
import jwt
import requests
from datetime import datetime, timezone

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_installation_token(installation_id):
    with open(PRIVATE_KEY_PATH, 'r') as f:
        private_key = f.read()

    payload = {
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": int(datetime.now(timezone.utc).timestamp()) + (10 * 60),
        "iss": APP_ID,
    }
    
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    
    headers = {
        "Authorization": f"Bearer {encoded_jwt}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    
    response = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers=headers
    )
    response.raise_for_status()
    return response.json()['token']

def get_installation_id():
    with open(PRIVATE_KEY_PATH, 'r') as f:
        private_key = f.read()

    payload = {
        "iat": int(datetime.now(timezone.utc).timestamp()),
        "exp": int(datetime.now(timezone.utc).timestamp()) + (10 * 60),
        "iss": APP_ID,
    }
    
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    
    headers = {
        "Authorization": f"Bearer {encoded_jwt}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    
    response = requests.get(
        f"https://api.github.com/app/installations",
        headers=headers
    )
    response.raise_for_status()
    
    for inst in response.json():
        if inst['account']['login'] == 'francovp':
            return inst['id']
    raise Exception("Installation not found for francovp")

def post_comment(issue_number, body):
    installation_id = get_installation_id()
    token = get_installation_token(installation_id)
    
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
    }
    
    response = requests.post(
        f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments",
        headers=headers,
        json={"body": body}
    )
    response.raise_for_status()
    return response.json()

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("Usage: python script.py <issue_number> <body>")
        sys.exit(1)
    
    issue_num = sys.argv[1]
    comment_body = sys.argv[2]
    post_comment(issue_num, comment_body)
