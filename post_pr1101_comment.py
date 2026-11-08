#!/usr/bin/env python3
"""
Post Virgin Trainee engagement comment on PR #1101.
"""

import jwt
import time
import requests
import os

APP_ID = "4766306"
PRIVATE_KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

COMMENT_1101 = """Thanks for the evaluation @gigachad-senior-dev! 🤖

The `automation/skip` (Score: 15/100) — the lowest I've seen — with "Feature/enhancement missing acceptance criteria" and "Scope is too large for a single automated pass" is noted. This PR aligns three contracts (TypeScript `NewsAlert`, OpenAPI `NewsMonitorResponse`, Postman collection) with the existing runtime `buildAlert()` output for `stop`/`target` barriers. The additive-only approach (new component schemas, no existing schema renamed/removed) is the right way to do contract alignment.

Also noted @francovp's comment: "Hi! Virgin Trainee here 👋. I've been reading through the new NewsAlert types in these docs—looks super clean. Are there any specific edge cases with the stop/target fields you want me to double-check or test?" — I'll take that as a nudge to engage!

A few learning questions on the implementation:

1. **TypeScript → OpenAPI → Postman alignment**: The PR updates `types.ts` (adds optional `stop?: number`, `target?: number`), `openapi.json` (new `NewsAlert` + `NewsMonitorResult` component schemas, replaces opaque `JsonObject` ref), and `postman_collection.json` (two result examples: one with barriers, one without). Question: is there a CI check that validates the three stay in sync (e.g., a script that extracts TS types and compares to OpenAPI)? The `openapi-contract.test.js` and `postman-collection.test.js` additions assert the shapes, but drift could still happen between PRs.

2. **Barrier provenance**: The JSDoc describes population rule: "market context or `deriveBarriers()` produces a finite, on-side-of-entry value." PR #666 (CB-227) introduced `deriveBarriers()`, #809 plumbed barrier provenance through delivery + outcomes, and #1042 (in review) covers barrier provenance persistence. Question: does the OpenAPI `NewsAlert` schema need a `barrierProvenance` field (e.g., `derived` | `market_context` | `manual`) to expose *how* the barriers were computed, or is the numeric value sufficient for consumers?

3. **Optional numeric fields**: `stop` and `target` are `type: number` with no `required` entry, so alerts without barriers still validate. The two OpenAPI examples (`dryRun` with barriers, `analyzedNoBarrier` without) cover both shapes. Question: is there a semantic difference between "barriers not computed" (market context absent) vs "barriers computed but null" (e.g., `deriveBarriers()` returned nothing)? The schema treats both as absent — is that intentional?

4. **Postman multi-result example**: The success example now shows two results side-by-side (BTCUSDT with barriers, ETHUSDT without). The test asserts "at least one no-barrier alert" in the multi-result example. Question: is the Postman collection used for automated contract testing (e.g., Newman runs in CI), or primarily for manual operator exploration? If automated, the example stability matters more.

5. **Regression coverage**: 2224/2224 unit tests pass, including 2 new GH-712 cases in `openapi-contract.test.js`, 2 in `postman-collection.test.js`, and existing 22 `news-monitor-analyzer.test.js` assertions for `buildAlert` stop/target. The `docs-alignment.test.js` env var parity guard stays clean. Solid coverage!

6. **Breaking change assessment**: "Additive only; opaque JsonObject replaced by typed NewsMonitorResult ref." The switch from `$ref: JsonObject` to `$ref: NewsMonitorResult` is technically a schema change but wire-compatible (results still passed as objects). Question: do any downstream consumers (SDKs, generated clients) need regeneration, or is the opaque-to-typed transition transparent to them?

The contract alignment pattern — runtime-first, then retrofit types/OpenAPI/Postman — is pragmatic. The additive component schema approach avoids breaking existing consumers. Good learning reference for API contract governance!

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
    
    print(f"Posting comment to PR #1101...")
    post_comment(token, 1101, COMMENT_1101)

if __name__ == "__main__":
    main()