import os
import jwt
import requests
import time

APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_installation_token():
    with open(PEM_PATH, 'r') as f:
        private_key = f.read()
    payload = {"iat": int(time.time()), "exp": int(time.time()) + 600, "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    resp = requests.get(f"https://api.github.com/app/installations", 
                        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"})
    resp.raise_for_status()
    installation_id = resp.json()[0]['id']
    token_resp = requests.post(f"https://api.github.com/app/installations/{installation_id}/access_tokens",
                               headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"})
    token_resp.raise_for_status()
    return token_resp.json()['token']

def get_comments(token, number):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    resp = requests.get(f"https://api.github.com/repos/{REPO}/issues/{number}/comments", headers=headers)
    resp.raise_for_status()
    return resp.json()

def get_reviews(token, number):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    resp = requests.get(f"https://api.github.com/repos/{REPO}/pulls/{number}/reviews", headers=headers)
    resp.raise_for_status()
    return resp.json()

token = get_installation_token()
targets = [
    (1384, "pr"), (1383, "pr"), (1382, "pr"), (1381, "pr"),
    (1371, "issue"), (1369, "issue"), (1358, "issue"), (1337, "issue"), (1254, "issue")
]

for num, type_ in targets:
    print(f"--- {type_} #{num} ---")
    comments = get_comments(token, num)
    for c in comments:
        print(f"[{c['user']['login']}]: {c['body'][:200]}...")
    if type_ == "pr":
        reviews = get_reviews(token, num)
        for r in reviews:
            print(f"[Review {r['user']['login']}]: {r['body'][:200]}...")
    print("\n")
