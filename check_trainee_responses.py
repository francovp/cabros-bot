import os
import jwt
import requests
import time

APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
TRAINEE_LOGIN = "virgin-trainee-dev[bot]"
HUMANS = {"francovp", "gigachad-senior-dev"}

def get_token():
    with open(PEM_PATH, 'r') as f:
        private_key = f.read()
    payload = {"iat": int(time.time()), "exp": int(time.time()) + 600, "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    resp = requests.get(f"https://api.github.com/app/installations", headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"})
    installation_id = resp.json()[0]['id']
    token_resp = requests.post(f"https://api.github.com/app/installations/{installation_id}/access_tokens", headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"})
    return token_resp.json()['token']

def check_item(token, item_number, item_type="issue"):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/repos/{REPO}/issues/{item_number}/comments"
    comments = requests.get(url, headers=headers).json()
    
    # Also check PR reviews if it's a PR
    reviews = []
    if item_type == "pull_request":
        rev_url = f"https://api.github.com/repos/{REPO}/pulls/{item_number}/reviews"
        reviews = requests.get(rev_url, headers=headers).json()

    all_comments = comments + reviews
    
    # We are looking for:
    # 1. Human comment that follows a Trainee comment
    # 2. Human comment that mentions the trainee or corrects them
    
    trainee_comment_found = False
    for c in all_comments:
        user = c.get('user', {}).get('login', '')
        body = c.get('body', '')
        
        if user == TRAINEE_LOGIN:
            trainee_comment_found = True
            continue
        
        if user in HUMANS and trainee_comment_found:
            print(f"Potential response in {item_type} #{item_number} by {user}:")
            print(f"Body: {body}")
            print("-" * 20)

token = get_token()
items = [
    (1384, "pull_request"), (1383, "pull_request"), (1382, "pull_request"), (1381, "pull_request"),
    (1371, "issue"), (1369, "issue"), (1358, "issue"), (1337, "issue"), (1254, "issue"), (1152, "issue"), (955, "issue"), (834, "issue")
]

for num, typ in items:
    check_item(token, num, typ)
