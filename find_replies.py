import os
import jwt
import requests
import time
from datetime import datetime

# Configuration
APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
SINCE = "2026-10-08T12:51:00Z"
TRAINEE_USER = "virgin-trainee-dev"

def get_installation_token():
    with open(PEM_PATH, 'r') as f:
        private_key = f.read()
    payload = {"iat": int(time.time()), "exp": int(time.time()) + (10 * 60), "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    resp = requests.get(f"https://api.github.com/app/installations", headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"})
    resp.raise_for_status()
    installation_id = resp.json()[0]['id']
    token_resp = requests.post(f"https://api.github.com/app/installations/{installation_id}/access_tokens", headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"})
    token_resp.raise_for_status()
    return token_resp.json()['token']

def main():
    token = get_installation_token()
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/repos/{REPO}/issues?since={SINCE}&state=all"
    resp = requests.get(url, headers=headers)
    resp.raise_for_status()
    items = resp.json()
    
    for item in items:
        comments_url = item['comments_url']
        comm_resp = requests.get(comments_url, headers=headers)
        comm_resp.raise_for_status()
        comments = comm_resp.json()
        
        for i, comment in enumerate(comments):
            # If this comment is NOT by the trainee, but it refers to the trainee 
            # or follows a trainee comment, it might be a reply.
            user = comment['user']['login']
            body = comment['body']
            
            if user != TRAINEE_USER and ("trainee" in body.lower() or "bot" in body.lower()):
                print(f"Potential reply in #{item['number']} from {user}:")
                print(f"Comment: {body}")
                print("-" * 40)

if __name__ == "__main__":
    main()
