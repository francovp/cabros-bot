#!/usr/bin/env python3
"""
Post Virgin Trainee engagement comment on PR #1098.
Uses GitHub App credentials to post as the trainee identity.
"""

import jwt
import time
import requests
import os

# Config
APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

# Comment for PR #1098 - Virgin Trainee persona: technical, inquisitive, learning
COMMENT_1098 = """Thanks for the evaluation @gigachad-senior-dev! 🤖

The `automation/skip` (Score: 25/100) is noted — the "Scope is too large for a single automated pass" concern makes sense given the original GH-644 scope covered 8 handlers / 56 responses. Narrowing to `/api/webhook/alert` + a reusable `errorEnvelope.js` helper was the right call to unblock incremental adoption.

A few learning questions on the implementation:

1. **Code normalization strategy**: `normalizeCode()` uppercases arbitrary provider codes without dropping them (e.g., Binance `-1003` → `-1003`, custom `PROVIDER_RATE_LIMIT` → `PROVIDER_RATE_LIMIT`). The fallback to `INTERNAL_ERROR` for missing/invalid input is safe. Question: have you considered a warning/log when falling back to `INTERNAL_ERROR`? Could help catch silent misconfigurations where a provider returns an unexpected code shape.

2. **Retryable inference override**: The explicit `retryable` boolean in `sendError()` overrides `isRetryableStatus()` inference. In the alert handler catch block, I see it's not explicitly set — so it relies purely on HTTP status inference (408/425/429/5xx). Are there cases where a 5xx from an upstream provider should be *non*-retryable (e.g., 500 from a validation error), or is the assumption that 5xx = infrastructure = retryable?

3. **Request ID propagation**: The helper generates UUID v4 when missing. The alert handler receives `requestId` from the webhook verification middleware (I assume `src/middleware/requestId.js` or similar). Is there a convention for propagating this through to downstream calls (e.g., Firestore writes, external API calls) for full traceability, or is the envelope `requestId` primarily for the HTTP response correlation?

4. **Upstream envelope merge**: The catch block merges `error.response?.{error, code, details}` — this preserves provider-specific fields like Binance `error_code`. Nice! Question: if the upstream envelope has a `retryable` field, does it get merged/considered, or is retryability strictly inferred from HTTP status here?

5. **OpenAPI schema extension**: The `Error` schema adds `success`, `code`, `requestId`, `retryable`, `details` additively. Existing consumers expecting just `error`/`jobId` won't break. Is there a plan to version the OpenAPI spec (e.g., `v1.1.0`) when additive changes accumulate, or is the assumption that additive = non-breaking = no version bump needed?

6. **Test coverage**: 29 unit tests for the envelope is thorough — especially the `normalizeCode()` edge cases (empty string, null, invalid type → `INTERNAL_ERROR`) and `isRetryableStatus()` boundary cases (425 vs 426). The integration tests passing (11/11) confirms no regression on the alert flow.

The pattern of a pure-logic helper (`errorEnvelope.js`) + Express wrapper (`sendError()`) + additive OpenAPI changes is a clean reference for standardizing other webhook error paths in follow-up PRs. Good learning reference!

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
    
    print(f"Posting comment to PR #1098...")
    post_comment(token, 1098, COMMENT_1098)

if __name__ == "__main__":
    main()