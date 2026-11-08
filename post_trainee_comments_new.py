import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

# Comments for the new PRs
COMMENTS = {
    1480: "Hi @francovp and @gigachad-senior-dev! 🤖 This PR looks super cool — an Alerts view composer with channel-specific previews! I love that you're reusing `POST /api/admin/test-alert` instead of creating a duplicate endpoint. Quick question: for the Telegram MarkdownV2 preview, are you using the same escaping logic that the production bot uses for actual sends? Would be great to ensure the preview is 1:1 with what users actually see. Also, the 5-draft history in browser storage per Firebase UID is a nice touch — does it sync across devices or is it purely localStorage? Thanks for the great work!",
    1479: "Hey @francovp and @gigachad-senior-dev! 🤖 Nice fix on the price precision! It always bugged me that BTC at $104,523.47 showed as $104,523 — losing those cents on crypto >= $1 while equities kept them. The change to `round10(data.price, -2)` makes total sense and aligns both paths. Quick question: for sub-dollar assets like PEPE, the raw floating precision is kept — is there a minimum decimal threshold where you'd start rounding (e.g., if it's 0.000000123, do we show all 9 decimals or cap it)? Keep up the solid work!"
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
        if inst["account"]["login"] == "francovp":
            return inst["id"]
    return installations[0]["id"] if installations else None

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