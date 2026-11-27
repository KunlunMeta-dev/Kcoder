#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'STUN host operation failed: %s\n' "$1" >&2
  exit 4
}

SCRIPT_FILE=$(readlink -f -- "${BASH_SOURCE[0]}") || fail 'could not resolve the host wrapper'
SCRIPT_DIR=$(dirname -- "$SCRIPT_FILE")
MODULE_FILE="${SCRIPT_DIR}/stun-lifecycle.mjs"
[[ -f "$MODULE_FILE" && ! -L "$MODULE_FILE" ]] || fail 'adjacent stun-lifecycle.mjs is missing or unsafe'

if [[ -n "${KCODER_STUN_FIXTURE_ROOT:-}" ]]; then
  [[ "$EUID" -ne 0 ]] || fail 'fixture mode must run as an ordinary user'
  NODE_CANDIDATE=$(command -v node || true)
  [[ -n "$NODE_CANDIDATE" && -f "$NODE_CANDIDATE" && -x "$NODE_CANDIDATE" ]] || fail 'Node.js is required for the isolated fixture runner'
else
  [[ "$EUID" -eq 0 ]] || fail 'host lifecycle must run as root'
  PATH=/opt/kcoder-relay/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
  NODE_CANDIDATE=

  source_root=$(dirname -- "$SCRIPT_DIR")
  case "$source_root" in
    /opt/kcoder-relay) source_owner=0 ;;
    /var/tmp/kcoder-relay-deploy-*|/var/tmp/kcoder-stun-test-*)
      [[ -d "$source_root" && ! -L "$source_root" && "$(realpath -e -- "$source_root")" == "$source_root" ]] || fail 'deployment source must be a canonical directory'
      source_owner=$(stat -c '%u' -- "$source_root") || fail 'could not inspect the deployment source owner'
      ;;
    *) fail 'host wrapper must run from an installed or staged deployment' ;;
  esac
  for source_path in "$source_root" "$SCRIPT_DIR" "$SCRIPT_FILE" "$MODULE_FILE"; do
    [[ ! -L "$source_path" && "$(stat -c '%u' -- "$source_path")" == "$source_owner" ]] || fail 'lifecycle source ownership is unsafe'
  done
  [[ "$(stat -c '%h' -- "$MODULE_FILE")" == 1 ]] || fail 'lifecycle helper must not have hard links'

  trusted_node() {
    local candidate=$1 resolved owner directory directory_owner
    [[ -n "$candidate" && -x "$candidate" && -f "$candidate" ]] || return 1
    owner=$(stat -c '%u' -- "$candidate" 2>/dev/null) || return 1
    [[ "$owner" == 0 ]] || return 1
    resolved=$(readlink -f -- "$candidate" 2>/dev/null) || return 1
    [[ -f "$resolved" && -x "$resolved" && ! -L "$resolved" ]] || return 1
    owner=$(stat -c '%u' -- "$resolved" 2>/dev/null) || return 1
    [[ "$owner" == 0 ]] || return 1
    directory=$(dirname -- "$resolved")
    while [[ "$directory" != / ]]; do
      [[ -d "$directory" && ! -L "$directory" ]] || return 1
      directory_owner=$(stat -c '%u' -- "$directory" 2>/dev/null) || return 1
      [[ "$directory_owner" == 0 ]] || return 1
      directory=$(dirname -- "$directory")
    done
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
  [[ -n "$NODE_CANDIDATE" ]] || fail 'a root-owned Node.js runtime version 18 or newer is required'
fi

exec "$NODE_CANDIDATE" "$MODULE_FILE" --host "$@"
