import jwt
import requests
import time
import os
import sys

# Configuration
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_jwt():
    with open(PRIVATE_KEY_PATH, 'r') as f:
        private_key = f.read()
    
    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_id(jwt_token):
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json"
    }
    url = "https://api.github.com/app/installations"
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    installations = response.json()
    
    if not isinstance(installations, list):
        return None

    # We found installation 157621095 in debug. 
    # To be robust, we just return the first one if it matches the target account
    # or we can just return it if only one exists.
    if len(installations) == 1:
        return installations[0]['id']
    
    for inst in installations:
        # Check if this installation is for the user who owns the repo
        if inst.get('account', {}).get('login') == 'francovp':
            return inst['id']
    return None

def get_installation_token(jwt_token, installation_id):
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json"
    }
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    return response.json()['token']

def post_comment(token, pr_number, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json"
    }
    url = f"https://api.github.com/repos/{REPO}/issues/{pr_number}/comments"
    data = {"body": body}
    response = requests.post(url, headers=headers, json=data)
    response.raise_for_status()
    return response.json()

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python script.py <pr_number> <comment_body>")
        sys.exit(1)
    
    pr_num = sys.argv[1]
    comment = sys.argv[2]
    
    try:
        jwt_token = get_jwt()
        inst_id = get_installation_id(jwt_token)
        if not inst_id:
            print("Could not find installation for repo")
            sys.exit(1)
        token = get_installation_token(jwt_token, inst_id)
        post_comment(token, pr_num, comment)
        print(f"Successfully posted comment to PR #{pr_num}")
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)
