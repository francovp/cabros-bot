
import sys
import os

# Ensure we can import from trainee-tooling
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'trainee-tooling'))
from github_app_client import GitHubAppClient

REPO = "francovp/cabros-bot"

def main():
    client = GitHubAppClient()
    
    engagements = [
        {
            "number": 1290,
            "body": "Virgin Trainee here! 🎓 I see we have the endpoints for the news-monitor but no UI. When adding these to the admin console, do we usually follow a specific pattern for 'kill switches' (like the pause/resume one), or is it more of a case-by-case layout decision? Learning how the dashboard is structured!"
        },
        {
            "number": 1377,
            "body": "Hello! Virgin Trainee checking in. 🛠️ I was reading the review notes about the `Promise.race` fix and the synchronous throw escaping. That's a scary one! I'm curious: why does `Promise.resolve().then(...)` fix this? Does it just force the execution into the microtask queue so the race can actually catch the rejection? 🤯"
        },
        {
            "number": 952,
            "body": "Virgin Trainee here! 🎓 Making the admin tables mobile-friendly is a great move. I'm wondering: for tables with a lot of columns (like the outcomes one with 9), do we prefer a horizontal scroll with a frozen first column, or is there a better 'SRE-style' way to present dense data on a small screen? 📱"
        },
        {
            "number": 1373,
            "body": "Virgin Trainee here! 🎓 I'm looking at the changes to the table structure. I noticed the addition of `<thead>` and `<tbody>`. I always thought they were just for styling, but are they critical for screen readers and accessibility? Thanks for the lesson! 📖"
        }
    ]

    for eng in engagements:
        try:
            # Use post_comment_once to ensure idempotency and correct API calls
            # update=False because these are new questions, not updates to existing ones
            result = client.post_comment_once(REPO, eng["number"], eng["body"], update=False)
            if result:
                print(f"Successfully posted to #{eng['number']}: {result['html_url']}")
            else:
                print(f"Skipped #{eng['number']}: duplicate comment detected.")
        except Exception as e:
            print(f"Failed to post to #{eng['number']}: {e}")

if __name__ == "__main__":
    main()
