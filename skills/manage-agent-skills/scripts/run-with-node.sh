#!/bin/sh
set -eu

is_compatible_node() {
  candidate=$1
  [ -x "$candidate" ] || return 1
  major=$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) || return 1
  [ "$major" -ge 20 ] 2>/dev/null
}

exec_node() {
  selected_node=$1
  shift
  PATH="$(dirname "$selected_node"):$PATH"
  export PATH
  exec "$selected_node" "$@"
}

if [ -n "${AGENT_SKILLS_NODE:-}" ]; then
  if ! is_compatible_node "$AGENT_SKILLS_NODE"; then
    echo "AGENT_SKILLS_NODE must point to Node.js 20 or newer: $AGENT_SKILLS_NODE" >&2
    exit 1
  fi
  exec_node "$AGENT_SKILLS_NODE" "$@"
fi

path_node=$(command -v node 2>/dev/null || true)
if [ -n "$path_node" ] && is_compatible_node "$path_node"; then
  exec_node "$path_node" "$@"
fi

if [ -n "${NVM_DIR:-}" ]; then
  for candidate in "$NVM_DIR"/versions/node/*/bin/node; do
    if is_compatible_node "$candidate"; then
      exec_node "$candidate" "$@"
    fi
  done
fi

if [ -n "${HOME:-}" ]; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node; do
    if is_compatible_node "$candidate"; then
      exec_node "$candidate" "$@"
    fi
  done
fi

echo "agent-skills requires Node.js 20 or newer; install one or set AGENT_SKILLS_NODE to its executable" >&2
exit 1
