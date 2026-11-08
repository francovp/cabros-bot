import os
import jwt
import requests
import time
from datetime import datetime, timezone

# Configuration
APP_ID = "4766306"
PEM_PATH = "/home/ubuntu/.config/cabros-bot/cabros-bot-trainee-dev.pem"
REPO = "francovp/cabros-bot"
SINCE = "2026-10-01T16:47:31.000Z"  # From github-last-run.txt

def get_installation_token():
    with open(PEM_PATH, 'r') as f:
        private_key = f.read()

    payload = {
        "iat": int(time.time()),
        "exp": int(time.time()) + (10 * 60),
        "iss": APP_ID,
    }
    encoded_jwt = jwt.encode(payload, private_key, algorithm="RS256")

    resp = requests.get(
        f"https://api.github.com/app/installations",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    resp.raise_for_status()
    installations = resp.json()
    
    installation_id = None
    for inst in installations:
        if inst['account']['login'] == 'francovp':
            installation_id = inst['id']
            break
    
    if not installation_id:
        installation_id = installations[0]['id']
    
    token_resp = requests.post(
        f"https://api.github.com/app/installations/{installation_id}/access_tokens",
        headers={"Authorization": f"Bearer {encoded_jwt}", "Accept": "application/vnd.github+json"}
    )
    token_resp.raise_for_status()
    return token_resp.json()['token']

def check_comments_on_item(token, item_number, item_type):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    
    url = f"https://api.github.com/repos/{REPO}/issues/{item_number}/comments"
    
    resp = requests.get(url, headers=headers, params={"since": SINCE, "per_page": 100})
    resp.raise_for_status()
    comments = resp.json()
    
    new_comments = []
    for comment in comments:
        new_comments.append({
            "user": comment["user"]["login"],
            "body": comment["body"],
            "created_at": comment["created_at"],
            "url": comment["html_url"]
        })
    
    return new_comments

def check_reviews_on_pr(token, pr_number):
    headers = {"Authorization": f"token {token}", "Accept": "application/vnd.github+json"}
    url = f"https://api.github.com/repos/{REPO}/pulls/{pr_number}/reviews"
    resp = requests.get(url, headers=headers, params={"per_page": 100})
    resp.raise_for_status()
    reviews = resp.json()
    
    new_reviews = []
    for review in reviews:
        submitted_at = review.get("submitted_at")
        if submitted_at and submitted_at > SINCE:
            new_reviews.append({
                "user": review["user"]["login"],
                "state": review["state"],
                "body": review["body"],
                "submitted_at": submitted_at,
                "url": review["html_url"]
            })
    
    return new_reviews

if __name__ == "__main__":
    try:
        token = get_installation_token()
        print(f"Got installation token")
        print(f"Checking comments since {SINCE}")
        
        # Items from trainee_analyzer.py output
        recent_items = [
            (1271, "issue"),
            (1270, "pr"),
            (1255, "issue"),
            (1240, "issue"),
        ]
        
        all_new_activity = []
        
        for item_num, item_type in recent_items:
            comments = check_comments_on_item(token, item_num, item_type)
            if comments:
                print(f"\n=== New comments on {item_type.upper()} #{item_num} ===")
                for c in comments:
                    print(f"  @{c['user']} at {c['created_at']}: {c['body'][:300]}")
                    all_new_activity.append({
                        "type": "comment",
                        "context": f"{item_type.upper()} #{item_num}",
                        "user": c["user"],
                        "body": c["body"],
                        "url": c["url"]
                    })
            
            if item_type == "pr":
                reviews = check_reviews_on_pr(token, item_num)
                if reviews:
                    print(f"\n=== New reviews on PR #{item_num} ===")
                    for r in reviews:
                        print(f"  @{r['user']} at {r['submitted_at']}: {r['state']} - {r['body'][:300] if r['body'] else '(no body)'}")
                        all_new_activity.append({
                            "type": "review",
                            "context": f"PR #{item_num}",
                            "user": r["user"],
                            "state": r["state"],
                            "body": r["body"],
                            "url": r["url"]
                        })
        
        # Check for corrections from target users
        target_users = {"francovp", "gigachad-senior-dev"}
        corrections = []
        for activity in all_new_activity:
            if activity["user"] in target_users:
                body_lower = (activity.get("body") or "").lower()
                correction_indicators = [
                    "correction", "corrected", "wrong", "incorrect", "no,", "no.",
                    "that's not", "that is not", "actually", "you're wrong",
                    "this is wrong", "this isn't", "not right", "mistake",
                    "fix this", "change this", "should be", "must be",
                    "incorrectly", "misunderstand", "misunderstood"
                ]
                if activity["type"] == "review" and activity.get("state") == "CHANGES_REQUESTED":
                    corrections.append(activity)
                elif any(indicator in body_lower for indicator in correction_indicators):
                    corrections.append(activity)
        
        if corrections:
            print("\n" + "=" * 60)
            print("CORRECTIONS DETECTED FROM TARGET USERS:")
            print("=" * 60)
            for c in corrections:
                print(f"  @{c['user']} on {c['context']}: {c['body'][:300] if c['body'] else '(no body)'}")
                print(f"    URL: {c['url']}")
        else:
            print("\nNo corrections detected from target users.")
            
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()