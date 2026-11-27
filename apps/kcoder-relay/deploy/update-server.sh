#!/usr/bin/env bash
set -Eeuo pipefail

script_file=${BASH_SOURCE[0]}
for ((depth=0; ; depth++)); do
  (( depth < 40 )) || { printf 'Too many update-server.sh symbolic links\n' >&2; exit 4; }
  script_dir=$(cd -P -- "$(dirname -- "$script_file")" && pwd) || exit 4
  script_file="$script_dir/$(basename -- "$script_file")"
  [[ -L "$script_file" ]] || break
  script_file=$(readlink "$script_file") || { printf 'Could not resolve update-server.sh\n' >&2; exit 4; }
  [[ "$script_file" == /* ]] || script_file="$script_dir/$script_file"
done
module_file="${script_dir}/../src/deploy.mjs"
[[ -f "$module_file" && ! -L "$module_file" ]] || { printf 'Adjacent Relay deployment module is missing or unsafe\n' >&2; exit 4; }
exec node "$module_file" upgrade "$@"
