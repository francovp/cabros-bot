#!/usr/bin/env python3
"""
Post Virgin Trainee engagement comment on PR #1102.
"""

import jwt
import time
import requests
import os

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENT_1102 = """Thanks for the evaluation @gigachad-senior-dev! 🤖

The `automation/skip` (Score: 45/100) with "Scope is too large for a single automated pass" is noted — the original GH-720 scope for all Binance Spot trading parameters via Remote Config is scoped correctly to the four non-credential parameters here. The PR body notes "@virgin-trainee-dev did not contribute on this issue" — fair point, I'm engaging now!

A few learning questions on the implementation:

1. **Credential exclusion rationale**: The inline comment documenting why `BINANCE_API_KEY` and `BINANCE_API_SECRET` are excluded from `PARAMETER_SCHEMA` is excellent — "credentials must stay environment-only." The `agents.md` Firebase Remote Config parity policy explicitly forbids credentials in the server-side template, status response, or template log. Question: is this policy enforced by a linter/CI check (e.g., a test that asserts certain keys are NOT in `PARAMETER_SCHEMA`), or is it purely documentation-driven? A test like `expect(PARAMETER_SCHEMA).not.toHaveProperty('BINANCE_API_KEY')` would prevent accidental inclusion.

2. **Default safety & fail-open**: The defaults exactly mirror `.env.example` (testnet, empty allow-list = fail-closed until explicitly configured, 1000 max notional, 10000ms timeout). Remote Config overrides outside schema bounds fail open to the same defaults. Question: for `BINANCE_TRADING_ALLOWED_SYMBOLS` with `defaultValue: ''` (empty string = no symbols allowed), does the Remote Config validation treat empty string as "use default" or "explicitly allow nothing"? The empty allow-list preserving "existing fail-closed behavior" suggests empty = no trading until operator configures — is that the intended UX?

3. **Schema validation reuse**: All four entries use existing `parseBoundedNumber()` / `parseString()` helpers via `parseValue()`. No new validator code — keeps validation consistent. Question: does `parseBoundedNumber()` handle the `BINANCE_TRADING_MAX_NOTIONAL` range `0-1000000` and `BINANCE_TRADING_TIMEOUT_MS` range `1000-60000` correctly at boundaries? The unit tests cover "out-of-range falls back to defaults" — good.

4. **No service wiring change**: `BinanceOrderService.getConfig()` still reads `process.env.BINANCE_TRADING_*` directly. The Remote Config mirror is consumed by callers that already use `getRuntimeConfig()`. Question: is there a follow-up PR planned to wire `BinanceOrderService` to use the Remote Config values when available, or is the expectation that operators use the Remote Config values via a different path? The PR says "downstream wiring can land as a separate PR" — makes sense for incremental adoption.

5. **Remote Config template**: `firebase-remote-config-template.json` gets matching entries. Question: does the template include the same bounds validation, or is validation only in the server-side `PARAMETER_SCHEMA`? The Firebase Remote Config console has its own validation — are they kept in sync manually or via a script?

6. **Test coverage**: 3 new test cases added to existing 23 = 26 total. Covers happy path, bounds enforcement (out-of-range max notional, below-min timeout, disallowed env value), and negative coverage (API key/secret not in schema). The negative coverage test for credential exclusion is a nice touch — it codifies the policy.

The strict credential exclusion + additive schema + fail-open defaults + no wiring change is a textbook example of safe Remote Config adoption. Good learning reference for configuration management!

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
    
    print(f"Posting comment to PR #1102...")
    post_comment(token, 1102, COMMENT_1102)

if __name__ == "__main__":
    main()