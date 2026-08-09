#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
manager_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd -P)
tsx="$manager_root/node_modules/.bin/tsx"

if [ ! -f "$tsx" ]; then
  echo "central agent-skills dependencies are missing; run npm install in $manager_root with Node.js 20 or newer" >&2
  exit 1
fi

cd "$manager_root"
exec "$script_dir/run-with-node.sh" "$tsx" "$manager_root/src/cli.ts" "$@"
