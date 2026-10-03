#!/usr/bin/env bash
# Managed runtime implementation shared by kcoder-studio-web-dev.sh and kcoder-studio-web-release.sh.
# The two callers own profile selection, systemd unit installation, and the --direct
# branch; this file is not a third user entry point. It starts KCoder, Studio Gateway,
# Studio Web, and Mobile Web from the current checkout.
#
# Runtime uses only user-directory configuration. Repository development settings
# are imported into the user directory through the CLI and are never passed to live
# processes as KCODER_CONFIG_DIR or a Studio servers overlay.

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
install_user="$(id -un)"
service_user="${KCODER_STUDIO_SERVICE_USER:-$install_user}"
user_home="${KCODER_STUDIO_SERVICE_HOME:-${HOME:?HOME must be set}}"

# The Studio launcher calls only shared profile, binary, and configuration-sync functions; it does not run the full installer.
shared_lib_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../install/lib" && pwd)"
source "$shared_lib_dir/profile.sh"
source "$shared_lib_dir/binary.sh"
source "$shared_lib_dir/config-sync.sh"
export KCODER_REPO_DIR="$repo_dir"

profile="${KCODER_STUDIO_PROFILE:-dev}"
while (($#)); do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "--profile requires dev or release" >&2; exit 2; }
      profile="$2"
      shift 2
      ;;
    --dev) profile=dev; shift ;;
    --release) profile=release; shift ;;
    *)
      echo "Unknown option: $1 (expected --profile dev|release, --dev, or --release)" >&2
      exit 2
      ;;
  esac
done
case "$profile" in
  dev)
    binary_name=kcoder-dev
    build_profile=debug
    default_profile_home="$user_home/.config/kcoder-dev"
    sync_development=1
    ;;
  release)
    binary_name=kcoder
    build_profile=release
    default_profile_home="$user_home/.config/kcoder"
    sync_development=0
    ;;
  *)
    echo "Unsupported Studio profile: $profile (expected dev or release)" >&2
    exit 2
    ;;
esac

user_bin="$user_home/.local/bin/$binary_name"
profile_home="${KCODER_STUDIO_KCODER_HOME:-${KCODER_CONFIG_DIR:-$default_profile_home}}"
studio_config_dir="${KCODER_STUDIO_CONFIG_DIR:-$user_home/.config/kcoder-studio}"
gateway_env="$studio_config_dir/web-gateway.env"
state_root="${XDG_STATE_HOME:-$user_home/.local/state}/kcoder-studio/$profile"
log_dir="$state_root/logs"
mobile_dir="$repo_dir/apps/kcoder-studio/mobile"

units=(
  kcoder-studio-web.service
  kcoder-studio-client.service
  kcoder-studio-mobile-bundler.service
  kcoder-studio-mobile-web.service
)

mkdir -p "$state_root" "$log_dir" "$user_home/.local/bin"
chmod 700 "$state_root" "$log_dir"

if [[ "$install_user" != "$service_user" ]]; then
  echo "managed Studio must run as the configured service user $service_user; current user is $install_user." >&2
  exit 1
fi

if [[ ! -f "$gateway_env" ]]; then
  echo "缺少 Gateway 用户配置：$gateway_env" >&2
  echo "请先按部署文档创建 web-gateway.env；启动器不会读取仓库里的运行时配置。" >&2
  exit 1
fi

if [[ "$sync_development" == 1 && ! -f "$repo_dir/crates/kcoder_config/setting_dev_user.jsonc" ]]; then
  echo "缺少开发配置源文件：$repo_dir/crates/kcoder_config/setting_dev_user.jsonc" >&2
  exit 1
fi
if [[ ! -x "$mobile_dir/node_modules/expo/bin/cli" || ! -d "$mobile_dir/node_modules/esbuild" ]]; then
  echo "缺少 Mobile Web 的 Expo/esbuild 依赖：$mobile_dir/node_modules" >&2
  echo "请先执行：cd $mobile_dir && npm install" >&2
  exit 1
fi

systemctl_cmd=()
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
  systemctl_cmd=(sudo -n systemctl)
elif systemctl --user show-environment >/dev/null 2>&1; then
  echo "未找到系统级 systemd 权限；当前服务单元是系统级服务。" >&2
  exit 1
else
  systemctl_cmd=(systemctl)
fi

unit_exists() {
  "${systemctl_cmd[@]}" cat "$1" >/dev/null 2>&1
}

for unit in "${units[@]}"; do
  if ! unit_exists "$unit"; then
    echo "缺少服务单元 $unit。请直接使用 kcoder-studio-web-*.sh 默认托管启动，或检查 scripts/launch/services/systemd/。" >&2
    exit 1
  fi
done

stop_units() {
  local unit
  for unit in "${units[@]}"; do
    if unit_exists "$unit"; then
      "${systemctl_cmd[@]}" stop "$unit" >/dev/null 2>&1 || true
    fi
  done
}

proc_cmdline() {
  local pid="$1"
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true
}

proc_cwd() {
  readlink "/proc/$1/cwd" 2>/dev/null || true
}

owned_pid() {
  local pid="$1" cmd cwd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  cmd="$(proc_cmdline "$pid")"
  cwd="$(proc_cwd "$pid")"
  [[ "$cwd" == "$repo_dir"* ]] || return 1
  case "$cmd" in
    *"$repo_dir/apps/kcoder-studio/dev-server.mjs"*|\
    *"$repo_dir/apps/kcoder-studio/mobile"*"expo"*"14175"*|\
      *"/kcoder app-server"|*"/kcoder app-server "|\
      *"/kcoder-dev app-server"|*"/kcoder-dev app-server "*)
      return 0
      ;;
  esac
  return 1
}

descendants() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null || true); do
    descendants "$child"
  done
  printf '%s\n' "$parent"
}

stop_pid_tree() {
  local pid="$1" child
  owned_pid "$pid" || return 0
  while read -r child; do
    kill -TERM "$child" 2>/dev/null || true
  done < <(descendants "$pid")
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  while read -r child; do
    kill -KILL "$child" 2>/dev/null || true
  done < <(descendants "$pid")
}

stop_owned_processes() {
  local proc pid
  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    [[ "$pid" != "$$" ]] || continue
    if owned_pid "$pid"; then
      stop_pid_tree "$pid"
    fi
  done
}

set_gateway_binary() {
  local tmp line key found_binary=0 found_home=0 found_host=0
  tmp="$(mktemp "$studio_config_dir/.web-gateway.env.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    key="${line%%=*}"
    case "$key" in
      KCODER_STUDIO_KCODER_BIN)
        printf 'KCODER_STUDIO_KCODER_BIN=%s\n' "$user_bin" >>"$tmp"
        found_binary=1
        ;;
      KCODER_HOME)
        printf 'KCODER_HOME=%s\n' "$profile_home" >>"$tmp"
        found_home=1
        ;;
      KCODER_STUDIO_HOST)
        printf 'KCODER_STUDIO_HOST=127.0.0.1\n' >>"$tmp"
        found_host=1
        ;;
      *) printf '%s\n' "$line" >>"$tmp" ;;
    esac
  done <"$gateway_env"
  if [[ "$found_binary" == 0 ]]; then
    printf 'KCODER_STUDIO_KCODER_BIN=%s\n' "$user_bin" >>"$tmp"
  fi
  if [[ "$found_home" == 0 ]]; then
    printf 'KCODER_HOME=%s\n' "$profile_home" >>"$tmp"
  fi
  if [[ "$found_host" == 0 ]]; then
    printf 'KCODER_STUDIO_HOST=127.0.0.1\n' >>"$tmp"
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$gateway_env"
}

echo "[1/7] 构建当前 checkout..."
binary_policy=debug
[[ "$build_profile" == release ]] && binary_policy=build
kcoder_prepare_binary "$binary_policy"
source_binary="$KCODER_REAL_BIN"
[[ -x "$source_binary" ]] || {
  echo "Cargo 构建未生成可用的 $build_profile 二进制。" >&2
  exit 1
}

if [[ "${KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD:-0}" != 1 ]]; then
  echo "[2/7] 构建当前 Studio renderer..."
  command -v pnpm >/dev/null 2>&1 || {
    echo "默认源码启动需要 pnpm；仅跳过 renderer 构建时设置 KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD=1。" >&2
    exit 1
  }
  pnpm --dir "$repo_dir/apps/kcoder-studio/renderer" build
else
  echo "[2/7] 跳过 Studio renderer 构建（KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD=1）"
fi

echo "[3/7] 安装当前源码二进制到用户目录..."
install -m 0755 "$source_binary" "$user_bin"
"$user_bin" --version

echo "[4/7] 准备 $profile 用户配置目录..."
mkdir -p "$profile_home"
export KCODER_HOME="$profile_home"
export KCODER_CONFIG_DIR="$profile_home"
KCODER_REAL_BIN="$user_bin"
export KCODER_REAL_BIN
if [[ "$sync_development" == 1 ]]; then
  kcoder_sync_development_config
else
  "$user_bin" config migrate >/dev/null
fi
"$user_bin" config validate
set_gateway_binary

echo "[5/7] 停止本仓库旧服务和旧进程..."
stop_units
stop_owned_processes

echo "[6/7] 启动 Gateway、Studio Web 和 Mobile Web..."
"${systemctl_cmd[@]}" daemon-reload
"${systemctl_cmd[@]}" start kcoder-studio-web.service
"${systemctl_cmd[@]}" start kcoder-studio-client.service
"${systemctl_cmd[@]}" start kcoder-studio-mobile-bundler.service
"${systemctl_cmd[@]}" start kcoder-studio-mobile-web.service

echo "[7/7] 等待服务进入 active..."
for unit in "${units[@]}"; do
  "${systemctl_cmd[@]}" is-active --quiet "$unit" || {
    echo "服务未能启动：$unit" >&2
    "${systemctl_cmd[@]}" status "$unit" --no-pager -l >&2 || true
    exit 1
  }
done

cat <<EOF
源码开发环境已启动。
  Gateway:    http://127.0.0.1:4173
  Studio Web: http://127.0.0.1:4174
  Mobile Web: http://127.0.0.1:4175
  Rust CLI:   $user_bin
  日志目录:    $log_dir（systemd 服务日志使用 journalctl）
EOF
