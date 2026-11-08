import jwt
import time
import requests
import os

# Config
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENTS = {
    1089: "Hi @francovp! I see we're mounting `idempotencyMiddleware` on the volume-confirmation and symbol-analysis webhooks. I'm wondering, since these webhooks can be high-frequency, does this middleware handle potential race conditions if multiple identical requests arrive exactly at the same time, or is it primarily focused on preventing reprocessing of completed requests? I'd love to learn more about the strategy here. Thanks!"
}

def main():
    with open(PRIVATE_KEY_PATH, 'r') as f:
        private_key = f.read()

    # 1. Create JWT for GitHub App
    payload = {
        "iat": int(time.time()) - 60,
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID,
    }
    jwt_token = jwt.encode(payload, private_key, algorithm="RS256")

    headers = {
        "Authorization": f"Bearer {jwt_token}",
        "Accept": "application/vnd.github+json",
    }

    # 2. Get Installation ID for the repo
    url_install = "https://api.github.com/app/installations"
    resp_install = requests.get(url_install, headers=headers)
    resp_install.raise_for_status()
    installations = resp_install.json()
    
    installation_id = None
    for inst in installations:
        # We can check the installation's account or just try to find one that matches.
        # Since we only have one repo, the first one might be it, or we check the account.
        # For simplicity, let's look for the installation that has access to the repo.
        # Alternatively, list the repos for each installation.
        installation_id = inst['id']
        break

    if not installation_id:
        print("No installations found for this app.")
        return

    # 3. Get Installation Access Token
    url_token = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    resp_token = requests.post(url_token, headers=headers)
    resp_token.raise_for_status()
    token = resp_token.json()['token']

    # 4. Post Comments
    auth_headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }

    for pr_num, body in COMMENTS.items():
        url_comment = f"https://api.github.com/repos/{REPO}/issues/{pr_num}/comments"
        resp = requests.post(url_comment, headers=auth_headers, json={"body": body})
        if resp.status_code == 201:
            print(f"Successfully posted to #{pr_num}")
        else:
            print(f"Failed to post to #{pr_num}: {resp.text}")

if __name__ == "__main__":
    main()
