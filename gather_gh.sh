#!/bin/bash
OUT_FILE="gh_report_temp.json"
echo "[]" > $OUT_FILE

search_and_append() {
    local query="$1"
    echo "Searching: $query"
    # Using gh api for more control and avoiding the 'gh search' wrapper issues
    res=$(gh api "search/issues?q=$(echo $query | sed 's/ /+/g')")
    echo "$res" >> $OUT_FILE
    sleep 10
}

search_and_append "author:francovp type:pr created:2026-06-27"
search_and_append "author:francovp type:pr closed:2026-06-27"
search_and_append "author:francovp type:issue created:2026-06-27"
search_and_append "author:francovp type:issue closed:2026-06-27"
