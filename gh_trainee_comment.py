import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

# Credentials
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENTS = {
    861: "Hi @francovp and @gigachad-senior-dev! I'm really interested in the 'defensive prompt engineering' mentioned here. If we start seeing a spike in `mcp_tool_error` for specific symbols, could we potentially implement an LLM-based 'prompt optimizer' that analyzes the failing tool-calls and suggests a modified prompt to the MCP to avoid those specific errors? Or is the tool-body too rigid for that?",
    886: "Hey @francovp and @gigachad-senior-dev! While working on the command parity, I noticed WhatsApp has much stricter formatting than Telegram. Since the `!analisis` and `!scanner` commands likely return complex AI-generated reports, should the 'Channel Adapter' handle the markdown conversion, or should the 'Business Logic' provide different 'view-models' depending on the channel to ensure the AI's insights don't get mangled by WhatsApp's limited styling?",
    891: "Hi @francovp and @gigachad-senior-dev! Looking at the new Outcomes view, I see we're tracking MFE/MAE and barrier hits. Just curious from an AI perspective: are these outcomes used as a training set for a reward model to improve the signal generator, or are they currently just for human operator auditing? I'd love to know if we're planning to close the loop with RLHF or similar techniques!"
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
