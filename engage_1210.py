import jwt
import time
import requests

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_app_token():
    with open(PRIVATE_KEY_PATH, "r") as key_file:
        private_key = key_file.read()

    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")

    headers = {"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    
    res = requests.get("https://api.github.com/app/installations", headers=headers)
    res.raise_for_status()
    installations = res.json()
    installation_id = installations[0]['id']
    
    token_res = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers=headers
    )
    token_res.raise_for_status()
    return token_res.json()['token']

def post_comment(token, issue_number, body):
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json",
    }
    url = f"https://api.github.com/repos/{REPO}/issues/{issue_number}/comments"
    res = requests.post(url, headers=headers, json={"body": body})
    if res.status_code == 201:
        print(f"✅ Posted to #{issue_number}")
        return True
    else:
        print(f"❌ Failed #{issue_number}: {res.status_code} - {res.text}")
        return False

def main():
    print("Getting GitHub App token...")
    token = get_app_token()
    
    # PR #1210 - NEW since last run
    comment_1210 = """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1210: fix(htf): normalize contradictory direction and object recommendation payloads (GH-717) — HTF alignment hardening!

1. **Precedence rule**: `net_score` → explicit direction (side known) → normalized `status` → direction alone. This is a clear, documented hierarchy — great for determinism. The removal of the early-return on `normalizedStatus === 'unknown'` was the key fix.

2. **Object recommendation support**: `{ recommendation: { action: "BUY" } }` and nested under `alignment` now both work. Was the legacy string `{ recommendation: "BUY" }` path tested for regression? The PR says "legacy string recommendation preserved" — good.

3. **Side-aware classification**: `classifyByDirection()` with BUY+bullish→aligned, BUY+bearish→counter-trend, mirrored for SELL. The "unknown side falls back to status verdict" guard caught a real defect — explicit direction should NOT be authoritative when side is unknown.

4. **Reuses existing helpers**: `normalizeConfluenceStatus` / `normalizeTrendDirection` from `marketScannerScoring.js` — HTF alignment and scanner ranking now share vocabulary. Consistency win.

5. **Pure helpers exported for testing**: `resolveDirectionalToken` and `classifyByDirection` are pure/total — enables 6 new unit tests (32/32 passing). Test-first approach confirmed failing before fix.

6. **No API/Remote Config change**: Internal formatter only, `ENABLE_ALERT_HTF_RENDER` gate unchanged. Fail-open contract preserved.

Questions:
- The contradictory payload example shows `status: 'aligned'` with `direction: 'bearish'` for a BUY — was this a real production payload shape or a synthetic test case?
- Any plans to add telemetry/metrics for how often the precedence rule falls through to each tier (net_score vs direction vs status)?

Clean, surgical fix with tests — exactly what GH-717 needed!"""

    post_comment(token, 1210, comment_1210)
    print("Done!")

if __name__ == "__main__":
    main()