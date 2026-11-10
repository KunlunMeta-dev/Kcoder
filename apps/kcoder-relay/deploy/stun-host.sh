#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'STUN host operation failed: %s\n' "$1" >&2
  exit 4
}

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
MODULE_FILE="${SCRIPT_DIR}/stun-lifecycle.mjs"
[[ -f "$MODULE_FILE" && ! -L "$MODULE_FILE" ]] || fail 'adjacent stun-lifecycle.mjs is missing or unsafe'

if [[ -n "${KCODER_STUN_FIXTURE_ROOT:-}" && "$EUID" -ne 0 ]]; then
  NODE_CANDIDATE=$(command -v node || true)
  [[ -n "$NODE_CANDIDATE" && -f "$NODE_CANDIDATE" && -x "$NODE_CANDIDATE" ]] || fail 'Node.js is required for the isolated fixture runner'
else
  PATH=/opt/kcoder-relay/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
  NODE_CANDIDATE=

  no_group_world_write() {
    local mode=${1#0}
    [[ "$mode" =~ ^[0-7]{3}$ ]] || return 1
    local group=${mode:1:1}
    local other=${mode:2:1}
    [[ "$group" =~ ^[0145]$ && "$other" =~ ^[0145]$ ]]
  }

  trusted_node() {
    local candidate=$1 resolved owner mode directory directory_owner directory_mode
    [[ -n "$candidate" && -x "$candidate" && -f "$candidate" ]] || return 1
    owner=$(stat -c '%u' -- "$candidate" 2>/dev/null) || return 1
    [[ "$owner" == 0 ]] || return 1
    resolved=$(readlink -f -- "$candidate" 2>/dev/null) || return 1
    [[ -f "$resolved" && -x "$resolved" && ! -L "$resolved" ]] || return 1
    owner=$(stat -c '%u' -- "$resolved" 2>/dev/null) || return 1
    mode=$(stat -c '%a' -- "$resolved" 2>/dev/null) || return 1
    [[ "$owner" == 0 ]] && no_group_world_write "$mode" || return 1
    directory=$(dirname -- "$resolved")
    while [[ "$directory" != / ]]; do
      [[ -d "$directory" && ! -L "$directory" ]] || return 1
      directory_owner=$(stat -c '%u' -- "$directory" 2>/dev/null) || return 1
      directory_mode=$(stat -c '%a' -- "$directory" 2>/dev/null) || return 1
      [[ "$directory_owner" == 0 ]] && no_group_world_write "$directory_mode" || return 1
      directory=$(dirname -- "$directory")
    done
    [[ "$resolved" == /opt/kcoder-relay/runtime/node || "$resolved" == /usr/bin/node || "$resolved" == /usr/bin/nodejs || "$resolved" == /usr/local/bin/node || "$resolved" == /bin/node ]] || return 1
    local version major
    version=$("$resolved" -p 'process.versions.node' 2>/dev/null) || return 1
    [[ "$version" =~ ^([0-9]+)\. ]] || return 1
    major=${BASH_REMATCH[1]}
    (( major >= 18 )) || return 1
    NODE_CANDIDATE=$resolved
    return 0
  }

  for candidate in /opt/kcoder-relay/runtime/node /usr/bin/node /usr/bin/nodejs /usr/local/bin/node /bin/node; do
    if trusted_node "$candidate"; then break; fi
  done
  [[ -n "$NODE_CANDIDATE" ]] || fail 'a root-owned, protected Node.js runtime version 18 or newer is required'
fi

exec "$NODE_CANDIDATE" "$MODULE_FILE" --host "$@"
