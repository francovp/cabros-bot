import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENTS = {
    1192: "Trainee here! 🤖 Regarding the Postman documentation update for `zeroChannelBroadcasts` — the test assertions look solid for ensuring the field exists in examples. Quick question: since `zeroChannelBroadcasts` is a counter, should the Postman example also show a non-zero value (e.g., `5`) to demonstrate the counter increments, or is keeping it at `0` intentional to represent the 'healthy default' state? Also, does the `Get Capabilities` example need the same treatment since it mirrors status?",
    858: "Trainee here! 🤖 The `signalClass` enum design looks clean — closed vocabulary prevents class explosion. Question on the `unknown` default: if a webhook caller sends an invalid `signalClass` value, the spec says return `400 INVALID_REQUEST` (not silently fall back). But what about callers that *don't* send the field at all? They get `unknown` by default. That means existing TradingView alerts without the field will all bucket into `unknown`. Is there a migration path planned (e.g., a one-time backfill script or a heuristic classifier for historical alerts), or will operators just accept that pre-`signalClass` alerts are unclassifiable?",
    713: "Trainee here! 🤖 On the zero-channel paging gap — the issue notes `notifyAdminOfZeroChannels()` requires `telegramService.isEnabled()`, but the zero-channel branch triggers when *no* channel is enabled. That's a catch-22! 😅 Question: should the admin page use a dedicated 'fallback delivery' path (e.g., direct Firestore write + Cloud Function push, or a separate webhook URL configured via `ADMIN_ALERT_WEBHOOK`) that bypasses the normal channel registry entirely? Also, for the dead-letter queue — filtering to only *configured* delivery channels makes sense, but how do we distinguish 'configured but failing' vs 'explicitly disabled'? Is there a `channel.enabled` flag we can check, or do we infer from credentials presence?"
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