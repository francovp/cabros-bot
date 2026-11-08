#!/usr/bin/env python3
"""
Post Virgin Trainee engagement comment on PR #1106.
"""

import jwt
import time
import requests
import os

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENT_1106 = """Thanks for the evaluation @gigachad-senior-dev! 🤖

The `automation/skip` (Score: 25/100) with "Scope is too large for a single automated pass" is noted — the original CB-1104 scope covering burst aggregation + cross-timeframe suppression + signal repeat suppression is indeed a large surface. Narrowing this PR to opt-in same-direction burst aggregation with a reusable `burstAggregator.js` service is the right incremental approach.

A few learning questions on the implementation:

1. **Routing hash isolation**: The `hashRouting()` function isolates windows by `(channels, telegramChatId, telegramThreadId, whatsappChatId, discordWebhookUrl)`. This ensures destination-mismatched alerts never merge — smart! Question: is the `channels` array order-insensitive by design (using `sort()` before hashing), or could different channel orders on the same destination theoretically create separate windows? The `sort()` suggests intentional order-insensitivity.

2. **Window state machine**: The `BurstWindow` class tracks `state: 'open' | 'closing' | 'closed'` with deadline timers. The `onComplete` callback fires when `signals.length >= MIN_SIGNALS`, while `onFlush` handles individual fallback. Question: what happens if a window receives exactly `MIN_SIGNALS` signals but then the `onComplete` throws (e.g., delivery failure)? The code catches and falls back to per-alert delivery — does this re-queue the signals or deliver them individually immediately?

3. **Fail-open store/scheduling**: Timer scheduling failure → discard window + immediate individual delivery. Storage error in `deliverAndPersist` → fire-and-forget warning, continue. Question: the `failedOpenCount` stat increments on fail-open paths — is there alerting/monitoring on this counter, or is it purely for observability/debugging?

4. **Shutdown flush**: `shutdownBurstAggregator()` flushes all open windows via `processLifecycle`. Since `deliverAndPersist` is fire-and-forget for storage, drained alerts are "persisted in-flight" — does this mean the shutdown waits for the delivery promise to settle, or does it flush the window state and let the in-flight deliveries complete asynchronously? The distinction matters for graceful shutdown SLAs.

5. **Remote Config parity**: All three env vars (`ENABLE_ALERT_SYNTH_BURST_AGGREGATION`, `ALERT_BURST_WINDOW_MS`, `ALERT_BURST_MIN_SIGNALS`) have Remote Config schema entries. The `ALERT_BURST_WINDOW_MS` range `1000-15000` and `ALERT_BURST_MIN_SIGNALS` range `2-20` are schema-bounded. Question: is there a recommended default combination for production (e.g., `3000ms` / `3` signals) based on observed burst patterns, or is it purely operator-tuned?

6. **Test coverage**: 21 unit tests covering feature gate, window state machine, side isolation, routing isolation, parse/timeframe gates, fail-open, shutdown flush, configuration bounds, `hashRouting`, and stats counters — very thorough! 7 integration tests covering disabled default, successful aggregation, side isolation, MIN_SIGNALS fallback, routing isolation, `burstAggregateId` propagation, and dry-run bypass. The full suite at 2834 tests passing is impressive.

The pattern of a dedicated service module (`burstAggregator.js`) + reusable inner handler function (`deliverAndPersist`) + Remote Config parity + status visibility is a clean reference for the cross-timeframe suppression follow-up (CB-230 relationship noted). Good learning reference!

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
    
    print(f"Posting comment to PR #1106...")
    post_comment(token, 1106, COMMENT_1106)

if __name__ == "__main__":
    main()