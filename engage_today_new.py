#!/usr/bin/env python3
"""Post Virgin Trainee engagement comments on TODAY's new issues/PRs."""

import jwt
import time
import requests
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend

APP_ID = "4766306"
KEY_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_token():
    with open(KEY_PATH, "rb") as key_file:
        private_key = serialization.load_pem_private_key(
            key_file.read(), password=None, backend=default_backend()
        )
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + (10 * 60), "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    headers = {"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    res = requests.get("https://api.github.com/app/installations", headers=headers)
    installation_id = res.json()[0]["id"]
    token_res = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens", headers=headers
    )
    return token_res.json()["token"]

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

# New items from today (2026-09-27) not yet engaged
COMMENTS = {
    1216: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1216: feat(news-monitor): add classifier.dev fallback — great resilience addition for the news-monitor pipeline!

1. **Fallback trigger**: When does the fallback activate? Is it on classifier HTTP 5xx, timeout, malformed response, or all of the above? The `area/observability` label suggests this should be well-instrumented.

2. **Classifier contract**: What's the expected response schema from classifier.dev? Does it return the same `{ classification, confidence, reasoning }` shape as the primary classifier? A shared TypeScript interface or Zod schema would prevent drift.

3. **Circuit breaker**: Is there a circuit breaker around the primary classifier so we don't hammer a failing service? The fallback should be fast-path, not "try primary, wait for timeout, then try fallback."

4. **Telemetry**: Will `/api/status` or `/api/news-monitor/status` expose which classifier is active? Operators need to know if they're running on fallback (potentially lower accuracy).

5. **Cost/latency budget**: classifier.dev might have different SLAs — is there a max latency budget before fallback? What's the cost difference per call?

This pairs well with #1177 (news-monitor never runs) — once the scheduler is fixed, this fallback ensures classification resilience!""",

    1215: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1215: docs(learnings): codify PR review guardrails — this is meta-learning at its finest! 📚

1. **Guardrail scope**: The learnings cover deduplication, duplicate PR check, proactive engagement, and test hygiene. Are these meant to be enforced by CI (e.g., a `engagement-guardrails` job that checks for trainee comments on assigned PRs), or are they conventions for human reviewers?

2. **Automation opportunity**: The duplicate-comment issue (LRN-20260920-002) and duplicate-PR engagement (LRN-20260921-001) could be detected automatically. A pre-comment check: "Has virgin-trainee-dev[bot] already commented on this issue?" and "Is this PR a duplicate of another open PR?" would prevent both classes of error.

3. **Test hygiene rule**: LRN-20260927-001 (test mutates working tree) is a great candidate for a lint rule or CI check. Could a `test:verify-no-worktree-mutation` script run after test suite to detect `git status --porcelain` changes?

4. **Review checklist**: Should the PR template include a "Trainee Guardrails" checklist? E.g., ✅ No existing trainee comments, ✅ Not a duplicate PR, ✅ Tests don't mutate repo.

5. **Promotion to AGENTS.md**: These guardrails are broadly applicable — should they be promoted to `AGENTS.md` under a "Virgin Trainee Engagement Protocol" section so all agents inherit them?

Codifying trainee learnings into enforceable guardrails is exactly how the system improves!""",

    1214: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1214: docs: add triage prefilter guidance — improving the issue intake funnel!

1. **Prefilter criteria**: What are the prefilter questions? E.g., "Is this a bug in deployed code?", "Does it have reproduction steps?", "Is it a duplicate of an existing issue?" A structured triage form (GitHub issue template) could enforce this.

2. **Automation vs. human**: The `automation/skip` label on many issues suggests manual triage. Could a GitHub Action run the prefilter checks (has repro steps, has version, not duplicate) and auto-label `triage/ready` or `triage/needs-info`?

3. **Classifier integration**: With #1216 adding classifier.dev fallback, could the classifier also categorize incoming issues (bug, feature, question, duplicate) to route to the right team/labels?

4. **Triage SLA**: Is there a target time for first triage response? The `status/triage` label suggests a workflow state — adding a "time in triage" metric to `/api/status` would surface bottlenecks.

5. **Connection to #1177**: The "news-monitor never runs" issue sat for 90 days — a prefilter that flags "no activity in 30 days on configured feature" could have caught it earlier.

Triage prefilter guidance reduces noise and ensures high-signal issues get attention faster!""",

    1211: """Hi @francovp and @gigachad-senior-dev! 🤖

PR #1211: feat(admin): replace JSON with visual controls — huge UX upgrade for the admin console!

1. **Component library**: Are these custom components or a library (e.g., shadcn/ui, Radix, Headless UI)? The `area/auth` label suggests these might interact with auth state (admin/operator roles).

2. **State synchronization**: The admin console has had state sync issues (LRN-20260927-001, #1161, #1163). Do the new visual controls use the same `previousDefinition` cache pattern, or a new state management approach (React Query, Zustand, Redux Toolkit)?

3. **Form validation**: JSON editors allowed invalid payloads to be sent. Visual controls can enforce schema at the component level (required fields, enum selects, numeric ranges). Is validation on blur, on change, or on submit?

4. **Backward compatibility**: Can operators still paste JSON if they prefer? A "raw JSON" toggle preserves power-user workflows while guiding newcomers.

5. **Test coverage**: Visual components need interaction tests (React Testing Library / Playwright). Are there e2e tests for the critical flows: create operation, edit with dirty state, filter + auto-select, save + verify persistence?

This addresses the root cause of several admin console bugs — moving from "JSON as UI" to purpose-built controls is a major quality leap!""",

    1213: """Hi @francovp and @gigachad-senior-dev! 🤖

Issue #1213: feat(news-monitor): add opt-in classifier.dev fallback — pairs with PR #1216!

1. **Opt-in gate**: Is the fallback gated by `ENABLE_CLASSIFIER_DEV_FALLBACK` env var, or a Firebase Remote Config flag? The `agent-working` label suggests active development — Remote Config would allow instant rollout/rollback.

2. **Classifier selection strategy**: Primary → fallback on failure, or parallel with consensus? Primary-only with fallback is simpler; parallel allows "best of both" but doubles latency/cost.

3. **Accuracy comparison**: How will you measure if classifier.dev is better/worse than the primary? A shadow mode (run both, log both, serve primary) would build confidence before switching.

4. **Schema alignment**: Both classifiers should return identical shapes. A shared validation schema (Zod/JSON Schema) enforced at the adapter boundary prevents silent mismatches.

5. **Cost control**: Two classifiers = 2x API calls. Is there a daily budget or per-alert cost cap? The `area/observability` label suggests metrics — consider exposing `classifierCalls: { primary: N, fallback: M }` in `/api/news-monitor/status`.

This completes the resilience story for news classification — excited to see it land!""",
}

def main():
    print("Getting GitHub App token...")
    token = get_token()
    
    print("Posting engagement comments on TODAY's new items...")
    for issue_num, comment in COMMENTS.items():
        post_comment(token, issue_num, comment)
        time.sleep(2)  # Rate limit courtesy
    
    print("Done!")

if __name__ == "__main__":
    main()