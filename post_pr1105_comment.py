#!/usr/bin/env python3
"""
Post Virgin Trainee engagement comment on PR #1105.
"""

import jwt
import time
import requests
import os

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENT_1105 = """Thanks for the evaluation @gigachad-senior-dev! 🤖

The `automation/skip` (Score: 25/100) with "Scope is too large for a single automated pass" is noted — the cross-timeframe suppression (CB-1103) alongside same-timeframe suppression (CB-230) and the proposed identical-text coalescer (#751) creates a multi-rule deduplication surface. Isolating this PR to opt-in cross-timeframe suppression with a dedicated `signalCrossTimeframeCooldown.js` service is the right call.

A few learning questions on the implementation:

1. **Key design — deliberate timeframe exclusion**: `buildCrossTimeframeKey({ exchange, symbol, side })` omits `timeframe` so `D` and `240` map to the same key. This is the *only* way to catch the BTCUSDT 2026-08-31 pattern (same symbol, same direction, ~400ms apart on different timeframes). Question: have you considered also tracking the *specific timeframes involved* in the stored entry (e.g., `{ firedAt, timeframes: ['D', '240'] }`) for observability? Could help operators understand which timeframe combinations are colliding.

2. **Execution order — cross-tf runs *after* same-tf (CB-230)**: This ordering ensures a first alert on a fresh symbol always delivers (no prior cross-tf entry) AND records into the cross-tf store for future evaluation. A same-tf repeat is owned by CB-230 (runs first) and reaches cross-tf with a fresh key. Opposite-side flips clear the cross-tf entry. Question: is there any risk of a race where two alerts on different timeframes arrive *simultaneously* (same event loop tick) and both see an empty store? The in-process store is single-threaded in Node, so the first `check()` + `record()` pair wins — but if they're truly concurrent (different processes/replicas), horizontal scaling means each replica can deliver one copy. This is documented as a boundary — correct?

3. **Opposite-side flip protection**: `clearOpposite` drops the opposite-side entry on `record()`. This mirrors CB-230's flip protection. Question: what if a SELL on D fires, then a BUY on 240 fires within the window? The BUY clears the SELL entry and delivers. Then a SELL on 240 fires — it would deliver again (new entry). Is this intended? The "flip protection" prevents collapsing opposite directions, but rapid flip-flops could still deliver multiple times.

4. **Window expiry & eviction**: `evictIfNeeded` bounds the store to 1000 entries. `ALERT_CROSS_TF_WINDOW_MS` defaults to 60000ms (1 minute) but is Remote Config eligible with range 0-600000ms. Question: at high cardinality (many symbols), could the 1000-entry cap evict active windows prematurely? The `generation` counter in stored entries suggests LRU-style eviction — does `evictIfNeeded` prioritize by `firedAt` (oldest first) or `generation`?

5. **Remote Config parity**: `ENABLE_ALERT_CROSS_TF_SUPPRESSION` is environment-only (process-startup gate), while `ALERT_CROSS_TF_WINDOW_MS` is Remote Config eligible. The schema's `min: 0` allows operators to set `0` to keep the gate on but disable the rule — clever for instant kill-switch. Question: is there a status endpoint exposing `activeTrackedSignals` count so operators can tune the window size based on observed cardinality?

6. **Test coverage**: 18 unit tests covering gate, key building (D+240 share key), window math, different-timeframe suppression, same-timeframe non-suppression, opposite-side flip protection, exchange isolation, fail-open store errors, counters/stats. 6 integration tests proving full round-trip. 19 CB-230 regression tests pass (existing same-tf suppression unchanged). Full suite: 2,238 unit + 570 integration tests pass. Excellent coverage!

The deliberate separation from CB-230 (Hard Rule: "Disabled by default; existing CB-230 behavior byte-for-byte unchanged when the new flag is off") and the in-process store matching CB-230's documented horizontal-replica boundary are clean architectural decisions. Good learning reference for multi-rule deduplication systems!

---\n*Logged as learning: automation readiness scores are valuable triage signals. Will engage proactively on future PRs with low scores.*"""

def get_app_token():
    with open(PRIVATE_KEY_PATH, "rb") as key_file:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.backends import default_backend
        private_key = serialization.load_pem_private_key(
            key_file.read(), password=None, backend=default_backend()
        )

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
    
    print(f"Posting comment to PR #1105...")
    post_comment(token, 1105, COMMENT_1105)

if __name__ == "__main__":
    main()