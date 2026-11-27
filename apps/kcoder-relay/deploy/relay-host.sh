#!/usr/bin/env bash
set -Eeuo pipefail
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

usage() {
  printf 'Usage: relay-host.sh prepare --stage-dir DIR [--check-only] | install|upgrade --stage-dir DIR [--adopt-existing] | status --stage-dir DIR | cleanup --stage-dir DIR [--purge-data]\n' >&2
}

fail() {
  local status=$1
  shift
  printf '%s\n' "$*" >&2
  exit "$status"
}

[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 4 'Relay host lifecycle must run as root'

action=${1:-}
[[ -n "$action" ]] || { usage; exit 2; }
shift
case "$action" in
  prepare|install|upgrade|status|cleanup) ;;
  *) usage; exit 2 ;;
esac

stage_dir=
check_only=false
adopt_existing=false
purge_data=false
while (($#)); do
  case "$1" in
    --stage-dir)
      (($# >= 2)) || { usage; exit 2; }
      [[ -z "$stage_dir" ]] || { usage; exit 2; }
      stage_dir=$2
      shift 2
      ;;
    --check-only)
      [[ "$action" == prepare && "$check_only" == false ]] || { usage; exit 2; }
      check_only=true
      shift
      ;;
    --adopt-existing)
      [[ "$action" == install || "$action" == upgrade ]] || { usage; exit 2; }
      [[ "$adopt_existing" == false ]] || { usage; exit 2; }
      adopt_existing=true
      shift
      ;;
    --purge-data)
      [[ "$action" == cleanup && "$purge_data" == false ]] || { usage; exit 2; }
      purge_data=true
      shift
      ;;
    *) usage; exit 2 ;;
  esac
done

[[ "$stage_dir" =~ ^/var/tmp/kcoder-relay-deploy-[a-f0-9]{16,64}$ ]] || fail 2 'Invalid deployment staging directory'
[[ -d "$stage_dir" && ! -L "$stage_dir" ]] || fail 4 'Deployment staging directory is missing or unsafe'
[[ "$(realpath -e -- "$stage_dir")" == "$stage_dir" ]] || fail 4 'Deployment staging directory must be canonical'
stage_owner=$(stat -c '%u' -- "$stage_dir") || fail 4 'Could not inspect deployment staging owner'
script_file=$(readlink -f -- "${BASH_SOURCE[0]}") || fail 4 'Could not resolve Relay host wrapper'
[[ "$script_file" == "$stage_dir/deploy/relay-host.sh" ]] || fail 4 'Relay host wrapper must belong to the selected staging directory'
deploy_dir="$stage_dir/deploy"
[[ -d "$deploy_dir" && ! -L "$deploy_dir" && "$(stat -c '%u' -- "$deploy_dir")" == "$stage_owner" ]] || fail 4 'Deployment helper directory is unsafe'
for helper_file in relay-host.sh relay-lifecycle.mjs caddy-lifecycle.mjs; do
  helper_path="$deploy_dir/$helper_file"
  [[ -f "$helper_path" && ! -L "$helper_path" && "$(stat -c '%h' -- "$helper_path")" == 1 && "$(stat -c '%u' -- "$helper_path")" == "$stage_owner" ]] || fail 4 'Relay lifecycle helper ownership or type is unsafe'
done

valid_node() {
  local candidate=$1 owner version
  [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
  owner=$(stat -c '%u' -- "$candidate" 2>/dev/null) || return 1
  [[ "$owner" == 0 ]] || return 1

  local directory current
  directory=$(dirname -- "$candidate")
  while [[ "$directory" != / ]]; do
    [[ -d "$directory" && ! -L "$directory" ]] || return 1
    owner=$(stat -c '%u' -- "$directory" 2>/dev/null) || return 1
    [[ "$owner" == 0 ]] || return 1
    current=$directory
    directory=$(dirname -- "$current")
  done
  version=$("$candidate" --eval 'const [major] = process.versions.node.split(".").map(Number); process.stdout.write(String(major));' 2>/dev/null) || return 1
  [[ "$version" =~ ^[0-9]+$ ]] && (( version >= 18 ))
}

find_node() {
  local candidate resolved
  local -a candidates=(/opt/kcoder-relay/runtime/node /usr/bin/node /usr/bin/nodejs)
  if candidate=$(command -v node 2>/dev/null); then candidates+=("$candidate"); fi
  for candidate in "${candidates[@]}"; do
    resolved=$(readlink -f -- "$candidate" 2>/dev/null) || continue
    if valid_node "$resolved"; then
      printf '%s\n' "$resolved"
      return 0
    fi
  done
  return 1
}

node_bin=
if ! node_bin=$(find_node); then
  if [[ "$action" != prepare || "$check_only" == true ]]; then
    fail 4 "A root-owned Node.js 18+ executable is required; run relay-host.sh prepare --stage-dir '$stage_dir' to prepare the runtime"
  fi
  if command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs >&2 || fail 4 'Could not install Node.js with dnf'
  elif command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq >&2 || fail 4 'Could not refresh apt package metadata for Node.js'
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >&2 || fail 4 'Could not install Node.js with apt'
  else
    fail 4 'No supported apt or dnf package manager is available to prepare Node.js'
  fi
  node_bin=$(find_node) || fail 4 'The installed Node.js is not a root-owned version 18 or newer'
fi

helper="$deploy_dir/relay-lifecycle.mjs"
[[ -f "$helper" && ! -L "$helper" ]] || fail 4 'Relay lifecycle helper is missing or unsafe'
helper_args=("$action" --stage-dir "$stage_dir")
if [[ "$check_only" == true ]]; then helper_args+=(--check-only); fi
if [[ "$adopt_existing" == true ]]; then helper_args+=(--adopt-existing); fi
if [[ "$purge_data" == true ]]; then helper_args+=(--purge-data); fi
exec "$node_bin" "$helper" "${helper_args[@]}"
