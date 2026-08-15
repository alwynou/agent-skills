#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
manager_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd -P)
tsx="$manager_root/node_modules/.bin/tsx"

# A fresh clone has neither dependencies nor vendor checkouts, and Git hooks cannot fix
# that because hooks are never cloned. Repair both here so any entry point works on a new
# machine straight after `git clone`.
if [ ! -f "$tsx" ]; then
  echo "installing central agent-skills dependencies in $manager_root" >&2
  (cd "$manager_root" && "$script_dir/run-with-node.sh" --exec npm ci >&2) || {
    echo "npm ci failed; run npm install in $manager_root with Node.js 20 or newer" >&2
    exit 1
  }
fi

if git -C "$manager_root" submodule status 2>/dev/null | grep -q '^-'; then
  echo "initializing vendor submodules in $manager_root" >&2
  git -C "$manager_root" submodule update --init --recursive >&2 || exit 1
fi

# Guard: mutating subcommands rewrite registry/skills.yaml and
# .skill-manager/lock.yaml (both git-tracked) without committing, leaving the
# central repository dirty and deadlocking install-skill.sh / change-skill.sh.
# Refuse them here; the dedicated launchers commit to main.
find_command() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root)
        if [ "$#" -ge 2 ]; then shift 2; else shift; fi
        ;;
      --root=*)
        shift
        ;;
      -*)
        shift
        ;;
      *)
        printf '%s\n' "$1"
        return 0
        ;;
    esac
  done
  return 0
}

command_name=$(find_command "$@")

refuse() {
  cat >&2 <<EOF
error: $command_name rewrites git-tracked registry and lock files without committing them,
which leaves the central agent-skills repository dirty and makes every later launcher run
fail with "central agent-skills repository has uncommitted changes".
Use $1 instead; it validates the change, commits it on main, and reconciles the links.
EOF
  exit 2
}

case "$command_name" in
  install)
    refuse "scripts/install-skill.sh"
    ;;
  remove|delete)
    refuse "scripts/change-skill.sh --action $command_name"
    ;;
  update)
    refuse "scripts/change-skill.sh --action update --source <id>"
    ;;
  enable|disable)
    refuse "scripts/change-skill.sh --action $command_name --skill <name>"
    ;;
esac

cd "$manager_root"
exec "$script_dir/run-with-node.sh" "$tsx" "$manager_root/src/cli.ts" "$@"
