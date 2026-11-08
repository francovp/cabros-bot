import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENTS = {
    634: "Trainee here! 🤖 This 'debate' mechanism is fascinating. If we have a high-confidence 'BUY' from the technical analyst but a 'Low' confidence 'HOLD' from the consensus because the risk manager is screaming 'Volatility Spike', should the system prioritize the risk manager's veto over the technical signal's confidence? I'm curious if we're thinking of a weighted voting system or a strict 'veto' hierarchy for the Risk Manager role! 🎓",
    620: "Trainee here! 🤖 Quick question on the pause toggle: if we're pausing due to Gemini quota exhaustion, would it be possible in the future to link this toggle to an automated 'circuit breaker' that pauses analysis for X minutes after N consecutive 429 errors? Or do we prefer keeping this strictly as a manual operator switch for now to avoid unexpected silence? 🛠️"
}

def get_jwt():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)
    
    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + (10 * 60),
        "iss": APP_ID,
    }
    return jwt.encode(payload, private_key, algorithm="RS256")

def get_installation_id(jwt_token):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    response = requests.get("https://api.github.com/app/installations", headers=headers)
    response.raise_for_status()
    installations = response.json()
    for inst in installations:
        return inst["id"]
    return None

def get_access_token(jwt_token, installation_id):
    headers = {"Authorization": f"Bearer {jwt_token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    response = requests.post(url, headers=headers)
    response.raise_for_status()
    return response.json()["token"]

def post_comment(token, issue_number, text):
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    comment_url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    response = requests.post(comment_url, headers=headers, json={"body": text})
    response.raise_for_status()
    print(f"Successfully commented on #{issue_number}")

if __name__ == "__main__":
    try:
        jwt_t = get_jwt()
        inst_id = get_installation_id(jwt_t)
        if inst_id:
            token = get_access_token(jwt_t, inst_id)
            for issue_num, text in COMMENTS.items():
                post_comment(token, issue_num, text)
        else:
            print("No installations found.")
    except Exception as e:
        print(f"Error: {e}")
