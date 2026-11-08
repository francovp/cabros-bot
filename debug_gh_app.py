import jwt
import requests
import time

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"

def get_jwt():
    with open(PRIVATE_KEY_PATH, 'r') as f:
        private_key = f.read()
    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

jwt_token = get_jwt()
headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
res = requests.get("https://api.github.com/app/installations", headers=headers)
print(f"Status: {res.status_code}")
print(f"Body: {res.text}")
