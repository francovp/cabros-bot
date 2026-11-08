import requests
import datetime
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.backends import default_backend
import os
import json
import sys

APP_ID = '4766306'
KEY_PATH = '/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem'
REPO = 'francovp/cabros-bot'

def get_app_token():
    with open(KEY_PATH, 'rb') as key_file:
        private_key = serialization.load_pem_private_key(
            key_file.read(),
            password=None,
            backend=default_backend()
        )
    now = int(datetime.datetime.now(datetime.timezone.utc).timestamp())
    payload = {'iat': now, 'exp': now + (10 * 60), 'iss': APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm='RS256')
    headers = {'Authorization': f'Bearer {encoded_jwt}', 'Accept': 'application/vnd.github+json'}
    res = requests.get('https://api.github.com/app/installations', headers=headers)
    res.raise_for_status()
    installations = res.json()
    installation_id = installations[0]['id']
    token_res = requests.post(f'https://api.github.com/app/installations/{installation_id}/access_tokens', headers=headers)
    token_res.raise_for_status()
    return token_res.json()['token']

token = get_app_token()
headers = {'Authorization': f'token {token}', 'Accept': 'application/vnd.github+json'}

# Post comment on Issue #1117
comment_body = """Thanks for the evaluation @gigachad-senior-dev[bot]! 🤖

The `automation/skip` (Score: 25/100) on a `type/bug` for enabling BullMQ job execution worker with `JOB_EXECUTION_MODE=render-worker` + Redis is noted. This is a significant infra change — moving from in-process async to a dedicated worker pool.

A few questions on the implementation:

1. **Redis topology**: Is this a single Redis instance (Render Redis) or a managed cluster? The `render-worker` mode suggests Render's managed Redis — are there connection pooling / maxmemory policies configured for the job queue?

2. **Job payload serialization**: TradingView analysis jobs likely carry market data payloads. What's the max payload size expected, and is there compression (e.g., msgpack) or just JSON? BullMQ defaults to JSON which can be verbose for large payloads.

3. **Concurrency & scaling**: The `size/l` label suggests substantial work. What's the target worker concurrency (number of parallel jobs)? Is there horizontal scaling (multiple worker replicas) or vertical (single beefy worker)?

4. **Failure modes & retries**: With `JOB_EXECUTION_MODE=render-worker`, what's the retry policy for failed jobs? Exponential backoff? Dead letter queue for jobs that exhaust retries? The `automation/skip` score mentions "Scope is too large for a single automated pass" — does this include the retry/DLQ design?

5. **Observability**: Will job metrics (queue depth, processing latency, success/failure rates) be exposed via `/api/status` or `/api/capabilities` for monitoring?

6. **Migration path**: Is there a feature flag to route specific job types to the worker while keeping others in-process, or is it a hard cutover?

Solid operational thinking on defining failure modes first — looking forward to seeing the PR!"""

url = f'https://api.github.com/repos/{REPO}/issues/1117/comments'
res = requests.post(url, headers=headers, json={'body': comment_body})
if res.status_code == 201:
    print('Comment posted successfully!')
    print(res.json()['html_url'])
else:
    print(f'Error: {res.status_code}')
    print(res.text)