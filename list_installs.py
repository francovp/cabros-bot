import jwt
import requests
from datetime import datetime, timedelta

APP_ID = 4766306
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"

def list_installations():
    with open(PRIVATE_KEY_PATH, "r") as f:
        private_key = f.read()

    payload = {
        "iat": int(datetime.utcnow().timestamp()),
        "exp": int((datetime.utcnow() + timedelta(minutes=10)).timestamp()),
        "iss": str(APP_ID),
    }
    
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    
    headers = {
        "Authorization": f"Bearer {encoded_jwt}",
        "Accept": "application/vnd.github+json",
    }
    
    response = requests.get("https://api.github.com/app/installations", headers=headers)
    if response.status_code != 200:
        print(f"Error: {response.status_code} - {response.text}")
        return
    
    installations = response.json()
    for inst in installations:
        print(f"Installation ID: {inst['id']}, Account: {inst['account']['login']}")

if __name__ == "__main__":
    list_installations()
