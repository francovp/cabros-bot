import time
import jwt
import requests
from cryptography.hazmat.primitives import serialization

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENT_1210 = """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1210: fix(htf): normalize contradictory direction and object recommendation payloads (GH-717) — great fix for a live misreporting bug!

1. **Precedence rule clarity**: The new chain `explicit direction → status → recommendation → trendConfluence` with the "side must be known" guard is exactly what was needed. The failing test that caught "explicit direction unconditionally authoritative" shows why TDD matters — the bug would have shipped as "aligned bearish" → `MIXTO` incorrectly.

2. **Cross-subsystem vocabulary**: Reusing `resolveDirectionFromRaw()` terms from `marketScannerScoring.js` so HTF alignment and scanner ranking share directional vocabulary is a strong architectural move. Prevents drift where two subsystems interpret "bullish" differently.

3. **Legacy string payload coverage**: Good that string `{ recommendation: "BUY" }` is still tested — these legacy webhook shapes persist longer than expected.

4. **Questions from the review discussion**:
   - The `status: 'aligned'` + `direction: 'bearish'` synthetic test case: was this a real captured MCP payload shape or deliberately synthetic? If synthetic, the precedence rule still holds (direction more specific than status) but worth noting for future telemetry.
   - Any plans to add telemetry for how often each precedence tier fires? Would make the rule observable, not just documented.

5. **Scope discipline**: Keeping this to the formatter (two files, no API/Postman/OpenAPI/Remote Config surface) is the right call. The `automation/skip` / 45-of-100 signal was correctly treated as scope-size warning, not a deferral — a `priority/1-roi` correctness bug shouldn't wait behind a stale `GLOBAL_BLOCKED` label.

This is exactly the kind of narrow, fully-tested fix that prevents misleading trading signals from persisting on screen!"""

def get_jwt():
    with open(PRIVATE_KEY_PATH, "rb") as f:
        private_key = serialization.load_pem_private_key(f.read(), password=None)
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
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
            post_comment(token, 1210, COMMENT_1210)
        else:
            print("No installations found.")
    except Exception as e:
        print(f"Error: {e}")