import jwt, requests, time, sys
from datetime import datetime, timezone, timedelta

APP_ID = '4766306'
PEM_PATH = '/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem'
REPO = 'francovp/cabros-bot'

with open(PEM_PATH) as f:
    pk = f.read()

jwt_token = jwt.encode({'iat': int(time.time()), 'exp': int(time.time())+600, 'iss': APP_ID}, pk, 'RS256')
r = requests.get(f'https://api.github.com/app/installations', headers={'Authorization': f'Bearer {jwt_token}', 'Accept': 'application/vnd.github+json'})
install_id = r.json()[0]['id']
r = requests.post(f'https://api.github.com/app/installations/{install_id}/access_tokens', headers={'Authorization': f'Bearer {jwt_token}', 'Accept': 'application/vnd.github+json'})
token = r.json()['token']

h = {'Authorization': f'token {token}', 'Accept': 'application/vnd.github+json'}
since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat().replace('+00:00', 'Z')

r = requests.get(f'https://api.github.com/repos/{REPO}/issues?since={since}&state=all&per_page=100', headers=h)
items = r.json()

print(f'Items: {len(items)}', file=sys.stderr)

found = False
for item in items:
    t = 'PR' if 'pull_request' in item else 'Issue'
    cr = requests.get(item['comments_url'], headers=h)
    if cr.status_code == 200:
        for c in cr.json():
            b = c['body'].lower()
            if 'trainee' in b or 'cabros-bot-trainee' in b or 'virgin-trainee' in b:
                found = True
                print(f'{t} #{item["number"]} @{c["user"]["login"]}: {c["body"][:300]}')

if not found:
    print('No trainee mentions in last 7 days')