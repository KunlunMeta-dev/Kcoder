#!/usr/bin/env bash
# Static launcher contract tests; browser tests under apps/kcoder-studio cover live service smoke tests.

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
startup="$repo_dir/scripts/launch/lib/kcoder-studio-web-start.sh"
dev_entrypoint="$repo_dir/scripts/launch/kcoder-studio-web-dev.sh"
release_entrypoint="$repo_dir/scripts/launch/kcoder-studio-web-release.sh"
desktop_entrypoint="$repo_dir/scripts/launch/kcoder-studio-electron.sh"
client_installer="$repo_dir/scripts/install/installers/studio-client.sh"
service_dir="$repo_dir/scripts/launch/services/systemd"
client_nginx_config="$service_dir/kcoder-studio-client.nginx.conf"
mobile_nginx_config="$service_dir/kcoder-studio-mobile-web.nginx.conf"

bash -n "$startup" "$dev_entrypoint" "$release_entrypoint" "$desktop_entrypoint" "$client_installer"
different_user="kcoder-contract-user"
if [[ "$(id -un)" == "$different_user" ]]; then
  different_user="kcoder-contract-other"
fi
if KCODER_STUDIO_SERVICE_USER="$different_user" \
  KCODER_STUDIO_SUDO_BIN=/bin/true \
  "$dev_entrypoint" --managed >/dev/null 2>&1; then
  echo "managed Studio unexpectedly accepted a service user different from the caller." >&2
  exit 1
fi
if KCODER_STUDIO_SERVICE_HOME='/tmp/unsafe&home' \
  KCODER_STUDIO_SUDO_BIN=/bin/true \
  "$dev_entrypoint" --managed >/dev/null 2>&1; then
  echo "managed Studio unexpectedly accepted an unsafe service home." >&2
  exit 1
fi
grep -Fq 'profile="${KCODER_STUDIO_PROFILE:-dev}"' "$startup"
grep -Fq 'user_home="${KCODER_STUDIO_SERVICE_HOME:-${HOME:?HOME must be set}}"' "$startup"
grep -Fq 'binary_name=kcoder-dev' "$startup"
grep -Fq 'kcoder_prepare_binary "$binary_policy"' "$startup"
grep -Fq 'install -m 0755 "$source_binary" "$user_bin"' "$startup"
grep -Fq 'export KCODER_HOME="$profile_home"' "$startup"
grep -Fq 'kcoder_sync_development_config' "$startup"
grep -Fq 'config migrate' "$startup"
grep -Fq 'KCODER_STUDIO_KCODER_BIN' "$startup"
grep -Fq 'KCODER_HOME' "$startup"
grep -Fq 'KCODER_STUDIO_HOST=127.0.0.1' "$startup"
grep -Fq 'stop_owned_processes' "$startup"
grep -Fq 'kcoder-studio-mobile-bundler.service' "$startup"
grep -Fq 'kcoder-studio-electron.sh' "$dev_entrypoint"
grep -Fq 'cli-dev.sh' "$dev_entrypoint"
grep -Fq 'kcoder-studio-electron.sh' "$release_entrypoint"
grep -Fq 'cli-release.sh' "$release_entrypoint"
grep -Fq 'install_services="${KCODER_STUDIO_INSTALL_SERVICES:-true}"' "$dev_entrypoint"
grep -Fq 'install_services="${KCODER_STUDIO_INSTALL_SERVICES:-true}"' "$release_entrypoint"
grep -Fq 'install_web_services()' "$dev_entrypoint"
grep -Fq 'install_web_services()' "$release_entrypoint"
grep -Fq -- '--direct' "$dev_entrypoint"
grep -Fq -- '--direct' "$release_entrypoint"
grep -Fq -- '--profile dev' "$dev_entrypoint" || grep -Fq -- '--dev' "$dev_entrypoint"
grep -Fq -- '--profile release' "$release_entrypoint" || grep -Fq -- '--release' "$release_entrypoint"
grep -Fq 'exec pnpm --dir "$studio_dir" desktop "$@"' "$desktop_entrypoint"
grep -Fq 'export KCODER_STUDIO_KCODER_BIN="$binary"' "$desktop_entrypoint"
grep -Fq 'resolved_binary="$(command -v "$profile_command" || true)"' "$desktop_entrypoint"
grep -Fq '[[ -z "${KCODER_STUDIO_KCODER_BIN:-}" && ! -x "$binary" ]]' "$desktop_entrypoint"
grep -Fq 'export KCODER_HOME="$profile_home"' "$desktop_entrypoint"
grep -Fq 'KCODER_STUDIO_SKIP_DEPENDENCY_CHECK' "$desktop_entrypoint"
if rg -n 'systemctl' "$desktop_entrypoint"; then
  echo "direct Electron wrapper cannot invoke systemctl." >&2
  exit 1
fi
test ! -e "$repo_dir/scripts/launch/kcoder-studio-web-services.sh"
test ! -e "$repo_dir/scripts/install/services"
test ! -e "$repo_dir/scripts/install/current-server"
if rg -n 'systemctl|/etc/systemd/system' "$repo_dir/scripts/install" --glob '*.sh'; then
  echo "install scripts must not install or manage systemd services." >&2
  exit 1
fi

# Source settings/servers may appear only during synchronization; never pass checkout fixtures to the gateway as runtime environment.
if rg -n 'KCODER_STUDIO_SERVERS_FILE=.*(\./|repo_dir)' "$startup"; then
  echo "启动器不能将 checkout servers 文件作为运行时 overlay。" >&2
  exit 1
fi

for unit in \
  kcoder-studio-web.service \
  kcoder-studio-client.service \
  kcoder-studio-mobile-bundler.service \
  kcoder-studio-mobile-web.service; do
  test -s "$service_dir/$unit"
  grep -Fq '@KCODER_STUDIO_REPO_DIR@' "$service_dir/$unit"
  grep -Fq '@KCODER_STUDIO_SERVICE_USER@' "$service_dir/$unit"
  grep -Fq '@KCODER_STUDIO_SERVICE_GROUP@' "$service_dir/$unit"
  grep -Fq '@KCODER_STUDIO_SERVICE_HOME@' "$service_dir/$unit"
  grep -Fq '@KCODER_STUDIO_SERVICE_PATH@' "$service_dir/$unit"
  grep -Fq "$unit" "$dev_entrypoint"
  grep -Fq "$unit" "$release_entrypoint"
done
grep -Fq '@KCODER_STUDIO_REPO_DIR@|$repo_dir|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_REPO_DIR@|$repo_dir|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_MOBILE_CI_ENV@' "$service_dir/kcoder-studio-mobile-bundler.service"
grep -Fq '@KCODER_STUDIO_MOBILE_CI_ENV@|$mobile_ci_env|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_MOBILE_CI_ENV@|$mobile_ci_env|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_USER@|$service_user|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_USER@|$service_user|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_GROUP@|$service_group|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_GROUP@|$service_group|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_HOME@|$service_home|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_HOME@|$service_home|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_PATH@|$service_path|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_SERVICE_PATH@|$service_path|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_NODE_BIN@|$node_bin|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_NODE_BIN@|$node_bin|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_NPM_BIN@|$npm_bin|g' "$dev_entrypoint"
grep -Fq '@KCODER_STUDIO_NPM_BIN@|$npm_bin|g' "$release_entrypoint"
grep -Fq '@KCODER_STUDIO_NODE_BIN@' "$service_dir/kcoder-studio-web.service"
grep -Fq '@KCODER_STUDIO_NODE_BIN@' "$service_dir/kcoder-studio-mobile-bundler.service"
grep -Fq '@KCODER_STUDIO_NPM_BIN@' "$service_dir/kcoder-studio-mobile-bundler.service"
legacy_account="$(printf '%s%s' 'h' 'yf')"
if rg -n "\\b${legacy_account}\\b|/home/${legacy_account}" "$startup" "$dev_entrypoint" "$release_entrypoint" "$service_dir"; then
  echo "Studio managed deployment must not hard-code a host-specific user." >&2
  exit 1
fi
for listen in \
  'listen 127.0.0.1:4174;' \
  'listen 4174;'; do
  grep -Fq "$listen" "$client_nginx_config"
done
for listen in \
  'listen 127.0.0.1:4175;' \
  'listen 4175;'; do
  grep -Fq "$listen" "$mobile_nginx_config"
done
if rg -n 'listen 0\.0\.0\.0:' "$service_dir"; then
  echo "Studio nginx must not listen on public wildcard addresses." >&2
  exit 1
fi
grep -Fq 'daemon-reload' "$dev_entrypoint"
grep -Fq 'daemon-reload' "$release_entrypoint"
grep -Fq 'ln -sfn' "$client_installer"

echo "studio startup contract: ok"
