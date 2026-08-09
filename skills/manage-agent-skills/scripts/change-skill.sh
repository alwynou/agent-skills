#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
manager_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd -P)
workdir=$(pwd -P)

cd "$manager_root"
exec "$script_dir/run-with-node.sh" "$script_dir/change-skill.mjs" --workdir "$workdir" "$@"
