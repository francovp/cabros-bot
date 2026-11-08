#!/bin/bash
USER="francovp"
DATE="2026-06-27"

echo "--- ALL CREATED (PR & ISSUE) ---"
gh api "search/issues?q=author:$USER+created:$DATE" --jq '.items[] | {number: .number, title: .title, url: .html_url, state: .state, type: (if .pull_request then "pr" else "issue" end), repo: .repository_url}'
sleep 15

echo "--- ALL MERGED (PR) ---"
gh api "search/issues?q=author:$USER+type:pr+is:merged+merged:$DATE" --jq '.items[] | {number: .number, title: .title, url: .html_url, state: .state, type: "pr", repo: .repository_url}'
sleep 15

echo "--- ALL CLOSED (PR & ISSUE) ---"
gh api "search/issues?q=author:$USER+is:closed+closed:$DATE" --jq '.items[] | {number: .number, title: .title, url: .html_url, state: .state, type: (if .pull_request then "pr" else "issue" end), repo: .repository_url}'
