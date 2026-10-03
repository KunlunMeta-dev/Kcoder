#!/usr/bin/env bash

# Start the release Studio profile from the current checkout.
# By default, install and manage Web/Mobile services through systemd so they outlive
# the developer's terminal session. Use --direct or KCODER_STUDIO_INSTALL_SERVICES=false for local Electron.

set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -P "$script_dir/../.." && pwd)"
install_services="${KCODER_STUDIO_INSTALL_SERVICES:-true}"
case "$install_services" in
  true|1|yes) install_services=true ;;
  false|0|no) install_services=false ;;
  *)
    echo "Unsupported KCODER_STUDIO_INSTALL_SERVICES: $install_services (expected true or false)." >&2
    exit 2
    ;;
esac
if (($#)); then
  case "$1" in
    --managed)
      install_services=true
      shift
      ;;
    --direct)
      install_services=false
      shift
      ;;
  esac
fi

install_web_services() {
  local systemd_dir="$script_dir/services/systemd"
  local sudo_bin="${KCODER_STUDIO_SUDO_BIN:-sudo}"
  local service_user="${KCODER_STUDIO_SERVICE_USER:-$(id -un)}"
  local service_group="${KCODER_STUDIO_SERVICE_GROUP:-$(id -gn)}"
  local service_home="${KCODER_STUDIO_SERVICE_HOME:-${HOME:?HOME must be set}}"
  local node_bin="${KCODER_STUDIO_NODE_BIN:-$(command -v node || true)}"
  local npm_bin="${KCODER_STUDIO_NPM_BIN:-$(command -v npm || true)}"
  local service_path="$service_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
  if [[ "$(id -un)" != "$service_user" ]]; then
    echo "managed Studio installation must run as the configured service user: $service_user" >&2
    exit 1
  fi
  [[ "$service_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*\$?$ ]] || {
    echo "Invalid KCODER_STUDIO_SERVICE_USER: $service_user" >&2
    exit 2
  }
  [[ "$service_group" =~ ^[A-Za-z_][A-Za-z0-9_.-]*\$?$ ]] || {
    echo "Invalid KCODER_STUDIO_SERVICE_GROUP: $service_group" >&2
    exit 2
  }
  for value in "$service_home" "$node_bin" "$npm_bin"; do
    [[ "$value" == /* && "$value" != *'|'* && "$value" != *'&'* ]] || {
      echo "Studio service paths must be absolute and must not contain '|' or '&': $value" >&2
      exit 2
    }
  done
  [[ -x "$node_bin" && -x "$npm_bin" ]] || {
    echo "KCODER_STUDIO_NODE_BIN and KCODER_STUDIO_NPM_BIN must be executable." >&2
    exit 1
  }
  command -v "$sudo_bin" >/dev/null 2>&1 || {
    echo "sudo is required to install Studio Web systemd units." >&2
    exit 1
  }
  local render_dir
  render_dir="$(mktemp -d "${TMPDIR:-/tmp}/kcoder-studio-units.XXXXXX")"
  local mobile_ci_env="Environment=CI=1"
  for file in \
    kcoder-studio-web.service \
    kcoder-studio-client.service \
    kcoder-studio-mobile-bundler.service \
    kcoder-studio-mobile-web.service; do
    [[ -s "$systemd_dir/$file" ]] || {
      echo "Missing systemd unit: $systemd_dir/$file" >&2
      rm -rf "$render_dir"
      exit 1
    }
    sed \
      -e "s|@KCODER_STUDIO_REPO_DIR@|$repo_dir|g" \
      -e "s|@KCODER_STUDIO_MOBILE_CI_ENV@|$mobile_ci_env|g" \
      -e "s|@KCODER_STUDIO_SERVICE_USER@|$service_user|g" \
      -e "s|@KCODER_STUDIO_SERVICE_GROUP@|$service_group|g" \
      -e "s|@KCODER_STUDIO_SERVICE_HOME@|$service_home|g" \
      -e "s|@KCODER_STUDIO_SERVICE_PATH@|$service_path|g" \
      -e "s|@KCODER_STUDIO_NODE_BIN@|$node_bin|g" \
      -e "s|@KCODER_STUDIO_NPM_BIN@|$npm_bin|g" \
      "$systemd_dir/$file" >"$render_dir/$file"
    "$sudo_bin" install -m 0644 "$render_dir/$file" "/etc/systemd/system/$file"
  done
  rm -rf "$render_dir"
  "$sudo_bin" systemctl daemon-reload
}

if [[ "$install_services" == true ]]; then
  install_web_services
  exec "$script_dir/lib/kcoder-studio-web-start.sh" --profile release "$@"
fi

if [[ "${KCODER_STUDIO_SKIP_CLI_INSTALL:-0}" != 1 ]]; then
  "$script_dir/../install/installers/cli-release.sh"
fi
exec "$script_dir/kcoder-studio-electron.sh" --release "$@"
