#!/usr/bin/env bash
set -euo pipefail

# scripts/setup-worktree.sh
# Establishes symlinks for node_modules and shared caches from the primary repository
# into secondary git worktrees to eliminate full package re-installation.

print_usage() {
	cat <<'EOF'
Usage: scripts/setup-worktree.sh [OPTIONS] [TARGET_DIR]

Options:
  -n, --dry-run    Show actions that would be taken without modifying filesystem
  -h, --help       Show this help message and exit

Arguments:
  TARGET_DIR       Path to the git worktree (defaults to current directory)

Examples:
  # Run from inside a secondary worktree:
  scripts/setup-worktree.sh

  # Run from primary repo targeting a worktree:
  scripts/setup-worktree.sh /path/to/worktree
EOF
}

DRY_RUN=0
TARGET_PATH=""

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h|--help)
			print_usage
			exit 0
			;;
		-n|--dry-run)
			DRY_RUN=1
			shift
			;;
		-*)
			echo "[setup-worktree] Error: Unknown option '$1'" >&2
			print_usage >&2
			exit 1
			;;
		*)
			if [[ -z "$TARGET_PATH" ]]; then
				TARGET_PATH="$1"
			else
				echo "[setup-worktree] Error: Unexpected argument '$1'" >&2
				print_usage >&2
				exit 1
			fi
			shift
			;;
	esac
done

TARGET_DIR="${TARGET_PATH:-.}"

if [[ ! -d "$TARGET_DIR" ]]; then
	echo "[setup-worktree] Error: Target directory '$TARGET_DIR' does not exist." >&2
	exit 1
fi

TARGET_DIR="$(cd "$TARGET_DIR" && pwd -P)"

# Verify target is inside a git work tree
if ! git -C "$TARGET_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	echo "[setup-worktree] Error: '$TARGET_DIR' is not inside a git work tree." >&2
	exit 1
fi

CURRENT_ROOT="$(git -C "$TARGET_DIR" rev-parse --show-toplevel)"
CURRENT_ROOT="$(cd "$CURRENT_ROOT" && pwd -P)"

COMMON_GIT_DIR="$(git -C "$CURRENT_ROOT" rev-parse --git-common-dir)"

if [[ "$COMMON_GIT_DIR" = /* ]]; then
	PRIMARY_ROOT="$(cd "$COMMON_GIT_DIR/.." 2>/dev/null && pwd -P)"
else
	PRIMARY_ROOT="$(cd "$CURRENT_ROOT/$COMMON_GIT_DIR/.." 2>/dev/null && pwd -P)"
fi

if [[ "$CURRENT_ROOT" == "$PRIMARY_ROOT" ]]; then
	echo "[setup-worktree] Info: '$CURRENT_ROOT' is the primary repository. No worktree symlinks needed."
	exit 0
fi

# Check that primary repository has node_modules
if [[ ! -d "$PRIMARY_ROOT/node_modules" ]]; then
	echo "[setup-worktree] Error: Primary repository node_modules not found at '$PRIMARY_ROOT/node_modules'." >&2
	echo "[setup-worktree] Please run 'pnpm install' in '$PRIMARY_ROOT' first." >&2
	exit 1
fi

ITEMS_TO_LINK=("node_modules")

# Add optional shared caches and config if present in primary
if [[ -d "$PRIMARY_ROOT/.pnpm-store" ]]; then
	ITEMS_TO_LINK+=(".pnpm-store")
fi

if [[ -f "$PRIMARY_ROOT/.env" ]]; then
	ITEMS_TO_LINK+=(".env")
fi

echo "[setup-worktree] Setting up worktree at: $CURRENT_ROOT"
echo "[setup-worktree] Primary repository at:  $PRIMARY_ROOT"

for ITEM in "${ITEMS_TO_LINK[@]}"; do
	SRC="$PRIMARY_ROOT/$ITEM"
	DEST="$CURRENT_ROOT/$ITEM"

	if [[ -L "$DEST" ]]; then
		CURRENT_TARGET="$(readlink "$DEST" || true)"
		if [[ "$CURRENT_TARGET" == "$SRC" ]]; then
			echo "[setup-worktree] $ITEM is already linked to primary repository."
		else
			if [[ "$DRY_RUN" -eq 1 ]]; then
				echo "[setup-worktree] [dry-run] Would update symlink: $DEST -> $SRC"
			else
				ln -sfn "$SRC" "$DEST"
				echo "[setup-worktree] Updated symlink: $ITEM -> $SRC"
			fi
		fi
	elif [[ -e "$DEST" ]]; then
		echo "[setup-worktree] Warning: '$DEST' already exists as a non-symlink file/directory; skipping." >&2
	else
		if [[ "$DRY_RUN" -eq 1 ]]; then
			echo "[setup-worktree] [dry-run] Would create symlink: $DEST -> $SRC"
		else
			ln -s "$SRC" "$DEST"
			echo "[setup-worktree] Created symlink: $ITEM -> $SRC"
		fi
	fi
done

echo "[setup-worktree] Worktree setup complete in $CURRENT_ROOT."
