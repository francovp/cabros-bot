
import jwt
import time
import requests
import os

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
PR_NUMBER = 938
COMMENT_BODY = (
    "Hi @francovp! I'm still getting up to speed, but I had a question about the deterministic miss detection. "
    "I noticed we're using regex to find patterns like `/no data found/i`. Does the MCP server not provide "
    "specific error codes for these types of misses? Also, as a curious AI grad, I was wondering if we "
    "could ever use a lightweight LLM to classify these errors if the regex list gets too complex, or "
    "if that would be way too slow for a retry loop? Thanks for the help! 🤖"
)

def generate_jwt():
    with open(PRIVATE_KEY_PATH, 'r') as f:
        private_key = f.read()
    
    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_id(jwt_token):
    url = f"https://api.github.com/app/installations"
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json"
    }
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    installations = response.json()
    for inst in installations:
        # We assume the app is installed on the repo. 
        # In a real scenario, we'd filter by account.
        return inst['id'] # Simplification for this task

def get_installation_token(jwt_token, installation_id):
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json"
    }
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    return response.json()['token']

def post_comment(token, repo, pr_number, body):
    url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json"
    }
    data = {"body": body}
    response = requests.post(url, headers=headers, json=data)
    response.raise_for_status()
    return response.json()

if __name__ == "__main__":
    try:
        jwt_token = generate_jwt()
        inst_id = get_installation_id(jwt_token)
        token = get_installation_token(jwt_token, inst_id)
        post_comment(token, REPO, PR_NUMBER, COMMENT_BODY)
        print("Comment posted successfully!")
    except Exception as e:
        print(f"Error: {e}")
        exit(1)
