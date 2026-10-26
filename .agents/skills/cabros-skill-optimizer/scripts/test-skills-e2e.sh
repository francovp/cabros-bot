#!/usr/bin/env bash
# ==============================================================================
# test-skills-e2e.sh - Zero-dependency E2E test suite for Cabros Bot agent skills
#
# Validates all agent skills under .agents/skills/ against repository rules:
#   Tier 1: Frontmatter & Metadata Integrity (YAML frontmatter, name, description)
#   Tier 2: Size & Bloat Limits (SKILL.md strictly <= 500 lines)
#   Tier 3: Script Permissions & Syntax (bash -n syntax validity, executable bit)
#   Tier 4: Secret & Credential Safety (No unredacted live keys or API tokens)
#
# Usage:
#   bash test-skills-e2e.sh --all
#   bash test-skills-e2e.sh --tier <1|2|3|4>
#   bash test-skills-e2e.sh --skill <skill-name>
#   bash test-skills-e2e.sh --skills-dir <custom-path> [--all]
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILLS_DIR="${SKILLS_DIR:-$DEFAULT_SKILLS_DIR}"

SELECTED_TIER=""
SELECTED_SKILL=""
RUN_ALL=false

print_usage() {
    cat <<EOF
Usage: $(basename "$0") [OPTIONS]

Options:
  --all                 Run all validation tiers across all skills
  --tier <1|2|3|4>      Run only a specific validation tier
  --skill <name>        Validate only the specified skill
  --skills-dir <path>   Override root skills directory (default: .agents/skills)
  -h, --help            Show this help message and exit
EOF
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --all)
            RUN_ALL=true
            shift
            ;;
        --tier)
            SELECTED_TIER="${2:-}"
            if [[ ! "$SELECTED_TIER" =~ ^[1-4]$ ]]; then
                echo "Error: --tier must be 1, 2, 3, or 4" >&2
                exit 1
            fi
            shift 2
            ;;
        --skill)
            SELECTED_SKILL="${2:-}"
            if [[ -z "$SELECTED_SKILL" ]]; then
                echo "Error: --skill requires a skill name" >&2
                exit 1
            fi
            shift 2
            ;;
        --skills-dir)
            SKILLS_DIR="${2%/}"
            if [[ ! -d "$SKILLS_DIR" ]]; then
                echo "Error: skills directory not found: $SKILLS_DIR" >&2
                exit 1
            fi
            shift 2
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            print_usage >&2
            exit 1
            ;;
    esac
done

if [[ "$RUN_ALL" != "true" && -z "$SELECTED_TIER" && -z "$SELECTED_SKILL" ]]; then
    # Default to running all if no flags provided
    RUN_ALL=true
fi

if [[ ! -d "$SKILLS_DIR" ]]; then
    echo "Error: skills directory not found at $SKILLS_DIR" >&2
    exit 1
fi

TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
ERRORS=()

record_pass() {
    local msg="$1"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    PASSED_TESTS=$((PASSED_TESTS + 1))
    echo "  [PASS] $msg"
}

record_fail() {
    local msg="$1"
    local reason="$2"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    FAILED_TESTS=$((FAILED_TESTS + 1))
    echo "  [FAIL] $msg: $reason" >&2
    ERRORS+=("$msg: $reason")
}

should_run_tier() {
    local tier="$1"
    if [[ "$RUN_ALL" == "true" ]]; then
        return 0
    fi
    if [[ "$SELECTED_TIER" == "$tier" ]]; then
        return 0
    fi
    if [[ -n "$SELECTED_SKILL" && -z "$SELECTED_TIER" ]]; then
        return 0
    fi
    return 1
}

# Collect target skills
SKILLS=()
if [[ -n "$SELECTED_SKILL" ]]; then
    if [[ -d "$SKILLS_DIR/$SELECTED_SKILL" ]]; then
        SKILLS=("$SELECTED_SKILL")
    else
        echo "Error: skill '$SELECTED_SKILL' not found in $SKILLS_DIR" >&2
        exit 1
    fi
else
    for item in "$SKILLS_DIR"/*; do
        if [[ -d "$item" ]]; then
            SKILLS+=("$(basename "$item")")
        fi
    done
fi

if [[ ${#SKILLS[@]} -eq 0 ]]; then
    echo "Error: no skills found to validate in $SKILLS_DIR" >&2
    exit 1
fi

echo "=== Cabros Bot Agent Skill Validation Suite (#1220) ==="
echo "Skills directory: $SKILLS_DIR"
echo "Skills discovered: ${#SKILLS[@]}"
echo ""

# ------------------------------------------------------------------------------
# Tier 1: Frontmatter & Metadata Validation
# ------------------------------------------------------------------------------
if should_run_tier "1"; then
    echo "--- Running Tier 1: Frontmatter & Metadata Validation ---"
    for skill in "${SKILLS[@]}"; do
        skill_dir="$SKILLS_DIR/$skill"
        skill_md="$skill_dir/SKILL.md"

        if [[ ! -f "$skill_md" ]]; then
            record_fail "$skill" "SKILL.md missing"
            continue
        fi

        # Check frontmatter structure: begins with --- and has closing ---
        first_line="$(awk 'NR==1 { sub(/\r$/, ""); print; exit }' "$skill_md")"
        if [[ "$first_line" != "---" ]]; then
            record_fail "$skill" "malformed frontmatter: missing opening '---'"
            continue
        fi

        # Find line number of closing ---
        closing_line_idx="$(awk '{ sub(/\r$/, ""); if (NR>1 && $0 == "---") { print NR; exit } }' "$skill_md")"
        if [[ -z "$closing_line_idx" || "$closing_line_idx" -gt 40 ]]; then
            record_fail "$skill" "malformed frontmatter: missing or out-of-bounds closing '---'"
            continue
        fi

        frontmatter_text="$(sed -n "2,$((closing_line_idx - 1))p" "$skill_md")"

        # Check name field
        name_val="$(echo "$frontmatter_text" | grep -E '^name:[[:space:]]*' | head -n 1 | sed -E 's/^name:[[:space:]]*//' | tr -d '\r"' | tr -d "'" || true)"
        if [[ -z "$name_val" ]]; then
            record_fail "$skill" "frontmatter missing 'name:' field"
            continue
        fi

        if [[ "$name_val" != "$skill" ]]; then
            record_fail "$skill" "frontmatter name mismatch: declared '$name_val' vs directory '$skill'"
            continue
        fi

        # Check description field
        desc_val="$(echo "$frontmatter_text" | grep -E '^description:[[:space:]]*' | head -n 1 | sed -E 's/^description:[[:space:]]*//' | tr -d '\r' || true)"
        if [[ -z "$desc_val" ]]; then
            record_fail "$skill" "frontmatter missing or empty 'description:' field"
            continue
        fi

        record_pass "$skill (frontmatter & metadata valid)"
    done
    echo ""
fi

# ------------------------------------------------------------------------------
# Tier 2: Size & Bloat Limits
# ------------------------------------------------------------------------------
if should_run_tier "2"; then
    echo "--- Running Tier 2: Size & Bloat Limits ---"
    for skill in "${SKILLS[@]}"; do
        skill_md="$SKILLS_DIR/$skill/SKILL.md"
        if [[ -f "$skill_md" ]]; then
            line_count="$(wc -l < "$skill_md" | tr -d ' ')"
            if [[ "$line_count" -gt 500 ]]; then
                record_fail "$skill" "exceeds 500-line limit ($line_count lines)"
            else
                record_pass "$skill (line count: $line_count <= 500 lines)"
            fi
        else
            record_fail "$skill" "SKILL.md missing"
        fi
    done
    echo ""
fi

# ------------------------------------------------------------------------------
# Tier 3: Script Permissions & Syntax Integrity
# ------------------------------------------------------------------------------
if should_run_tier "3"; then
    echo "--- Running Tier 3: Script Permissions & Syntax Integrity ---"
    for skill in "${SKILLS[@]}"; do
        skill_dir="$SKILLS_DIR/$skill"
        sh_scripts=()
        while IFS= read -r -d '' script_file; do
            sh_scripts+=("$script_file")
        done < <(find "$skill_dir" -type f -name "*.sh" -print0 2>/dev/null || true)

        if [[ ${#sh_scripts[@]} -eq 0 ]]; then
            record_pass "$skill (no shell scripts)"
            continue
        fi

        for script in "${sh_scripts[@]}"; do
            rel_script="${script#$SKILLS_DIR/}"
            # Check executable permission
            if [[ ! -x "$script" ]]; then
                record_fail "$rel_script" "script is not executable (missing +x permission)"
                continue
            fi

            # Check bash syntax
            if ! bash -n "$script" 2>/dev/null; then
                record_fail "$rel_script" "syntax error in script (bash -n failed)"
                continue
            fi

            record_pass "$rel_script (syntax OK, executable)"
        done
    done
    echo ""
fi

# ------------------------------------------------------------------------------
# Tier 4: Secret & Credential Safety
# ------------------------------------------------------------------------------
if should_run_tier "4"; then
    echo "--- Running Tier 4: Secret & Credential Safety ---"
    for skill in "${SKILLS[@]}"; do
        skill_dir="$SKILLS_DIR/$skill"
        leak_found=false
        leak_detail=""

        # Scan all text files in skill dir for live credentials / patterns
        while IFS= read -r -d '' file; do
            # Skip git or binary files if any
            if [[ -f "$file" ]]; then
                # Check for sensitive patterns:
                # - GitHub PAT (classic: ghp_36chars, fine-grained: github_pat_82chars)
                # - Google API key (AIzaSy + 33 chars)
                # - OpenAI API key (sk- + 32+ chars, including sk-proj-...)
                # - JWT token (eyJ... . eyJ...)
                # Note: Exclude common dummy/redacted placeholders like [REDACTED], ghp_xxx, YOUR_API_KEY
                if grep -EqI 'ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}|AIzaSy[A-Za-z0-9_-]{33}|sk-[A-Za-z0-9_-]{32,}|eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}' "$file" 2>/dev/null; then
                    leak_found=true
                    rel_path="${file#$SKILLS_DIR/}"
                    leak_detail="detected unredacted secret or live API key pattern in $rel_path"
                    break
                fi
            fi
        done < <(find "$skill_dir" -type f -print0 2>/dev/null || true)

        if [[ "$leak_found" == "true" ]]; then
            record_fail "$skill" "$leak_detail"
        else
            record_pass "$skill (zero leaked secret patterns)"
        fi
    done
    echo ""
fi

# ------------------------------------------------------------------------------
# Summary & Exit
# ------------------------------------------------------------------------------
echo "=========================================================="
echo "Validation Summary: $PASSED_TESTS/$TOTAL_TESTS test cases passed"
if [[ $FAILED_TESTS -gt 0 ]]; then
    echo "FAILED: $FAILED_TESTS test(s) failed:" >&2
    for err in "${ERRORS[@]}"; do
        echo "  - $err" >&2
    done
    exit 1
else
    echo "SUCCESS: All skill validations passed across checked tiers."
    exit 0
fi
