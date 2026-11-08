#!/bin/bash
USER="francovp"
DATE="2026-06-27"

fetch_gh() {
    local query=$1
    echo "Fetching: $query"
    gh api "search/issues?q=$(echo $query | sed 's/ /+/g')" --paginate -q '.items[] | {number: .number, title: .title, url: .html_url, repo: .repository_url}'
    sleep 30
}

echo "--- PRs CREATED ---"
fetch_gh "author:$USER type:pr created:$DATE"

echo "--- PRs MERGED ---"
fetch_gh "author:$USER type:pr is:merged merged:$DATE"

echo "--- PRs CLOSED ---"
fetch_gh "author:$USER type:pr is:closed closed:$DATE"

echo "--- ISSUES CREATED ---"
fetch_gh "author:$USER type:issue created:$DATE"

echo "--- ISSUES CLOSED ---"
fetch_gh "author:$USER type:issue is:closed closed:$DATE"
