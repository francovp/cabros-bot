import jwt
import requests
import time
import sys

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_jwt():
    with open(PRIVATE_KEY_PATH, 'r') as f:
        private_key = f.read()
    payload = {"iat": int(time.time()), "exp": int(time.time()) + (10 * 60), "iss": APP_ID}
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_token(jwt_token):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    installations = requests.get("https://api.github.com/app/installations", headers=headers).json()
    inst_id = next(i['id'] for i in installations if i.get('account', {}).get('login') == 'francovp')
    token_resp = requests.post(f"https://api.github.com/app/installations/{inst_id}/access_tokens", headers=headers)
    return token_resp.json()['token']

def fetch_pr(token, pr_num):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    return requests.get(f"https://api.github.com/repos/{REPO}/pulls/{pr_num}", headers=headers).json()

if __name__ == "__main__":
    pr_num = sys.argv[1]
    token = get_installation_token(get_jwt())
    print(fetch_pr(token, pr_num))
