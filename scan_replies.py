import requests
import jwt
import time
import json

APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"

def get_token():
    with open(PEM_PATH, 'r') as f:
        private_key = f.read()
    payload = {"iat": int(time.time()), "exp": int(time.time()) + 600, "iss": APP_ID}
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")
    resp = requests.get(f"https://api.github.com/app/installations", headers={"Authorization": f"Bearer {encoded_jwt}"})
    inst_id = resp.json()[0]['id']
    token_resp = requests.post(f"https://api.github.com/app/installations/{inst_id}/access_tokens", headers={"Authorization": f"Bearer {encoded_jwt}"})
    return token_resp.json()['token']

token = get_token()
headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}

items = [
    ("pulls", "1490"), ("pulls", "1489"), ("pulls", "1488"), 
    ("issues", "1486"), ("issues", "1485"), ("issues", "1484"),
    ("pulls", "1479"), ("pulls", "1476"), ("issues", "1457"),
    ("pulls", "1088"), ("pulls", "1076"), ("issues", "629"),
    ("issues", "619"), ("issues", "610"), ("issues", "587"),
    ("issues", "585"), ("issues", "584"), ("issues", "582"),
    ("issues", "554")
]

corrections = []

for type, num in items:
    url = f"https://api.github.com/repos/{REPO}/issues/{num}/comments"
    resp = requests.get(url, headers=headers)
    if resp.status_code != 200: continue
    comments = resp.json()
    
    for i in range(len(comments)):
        c = comments[i]
        user = c['user']['login']
        if user in ['francovp', 'gigachad-senior-dev']:
            body = c['body'].lower()
            # Heuristic: is it a reply to the trainee?
            # Check if it mentions "trainee" or follows a trainee comment
            is_reply_to_trainee = "trainee" in body or "bot" in body
            if not is_reply_to_trainee and i > 0:
                prev_user = comments[i-1]['user']['login'].lower()
                if "trainee" in prev_user:
                    is_reply_to_trainee = True
            
            if is_reply_to_trainee:
                # Correction keywords
                if any(x in body for x in ["no", "wrong", "incorrect", "actually", "instead", "fix this", "correction", "not right", "should be"]):
                    corrections.append({
                        "item": f"{type} #{num}",
                        "user": user,
                        "body": c['body'],
                        "url": c['html_url']
                    })

print(json.dumps(corrections, indent=2))
