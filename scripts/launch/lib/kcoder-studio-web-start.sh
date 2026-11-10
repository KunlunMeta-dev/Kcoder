#!/usr/bin/env bash
# Managed runtime implementation shared by kcoder-studio-web-dev.sh and kcoder-studio-web-release.sh.
# The two callers own profile selection and the --direct branch; this file is not a
# third user entry point. It stages managed units and starts KCoder, Studio Gateway,
# Studio Web, and Mobile Web from the current checkout.
#
# Runtime uses the selected private profile directory. Repository development settings
# are imported into that directory through the CLI and are never passed to live
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
install_services=0
while (($#)); do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "--profile requires dev or release" >&2; exit 2; }
      profile="$2"
      shift 2
      ;;
    --install-services)
      install_services=1
      shift
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
    default_profile_home="$repo_dir/target/home"
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

renderer_mode="${KCODER_STUDIO_RENDERER_MODE:-static}"
if [[ "$profile" == dev ]]; then
  renderer_mode="${KCODER_STUDIO_RENDERER_MODE:-vite}"
fi
case "$renderer_mode" in
  static|vite) ;;
  *) echo "KCODER_STUDIO_RENDERER_MODE must be static or vite" >&2; exit 2 ;;
esac

user_bin="$user_home/.local/bin/$binary_name"
profile_home="${KCODER_STUDIO_KCODER_HOME:-${KCODER_CONFIG_DIR:-$default_profile_home}}"
printf 'KCoder %s Home: %s\n' "$profile" "$profile_home" >&2
studio_config_dir="${KCODER_STUDIO_CONFIG_DIR:-$user_home/.config/kcoder-studio}"
gateway_env="$studio_config_dir/web-gateway.env"
state_root="${XDG_STATE_HOME:-$user_home/.local/state}/kcoder-studio/$profile"
log_dir="$state_root/logs"
mobile_dir="$repo_dir/apps/kcoder-studio/mobile"
staged_unit_dir=""
binary_stage=""

cleanup_staged_units() {
  if [[ -n "$staged_unit_dir" && -d "$staged_unit_dir" ]]; then
    rm -rf -- "$staged_unit_dir"
  fi
  if [[ -n "$binary_stage" && -e "$binary_stage" ]]; then
    rm -f -- "$binary_stage"
  fi
}
trap cleanup_staged_units EXIT

units=(
  kcoder-studio-web.service
  kcoder-studio-client.service
  kcoder-studio-mobile-bundler.service
  kcoder-studio-mobile-web.service
)

if [[ "$install_user" != "$service_user" ]]; then
  echo "managed Studio must run as the configured service user $service_user; current user is $install_user." >&2
  exit 1
fi
[[ "$user_home" == /* && "$user_home" != *'|'* && "$user_home" != *'&'* ]] || {
  echo "Studio service home must be absolute and must not contain '|' or '&': $user_home" >&2
  exit 2
}

mkdir -p "$state_root" "$log_dir" "$user_home/.local/bin"
chmod 700 "$state_root" "$log_dir"

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

active_units=("${units[@]}")
if [[ "$profile" == release ]]; then
  active_units=(kcoder-studio-web.service kcoder-studio-client.service)
fi

stage_web_services() {
  local systemd_dir="$repo_dir/scripts/launch/services/systemd"
  local service_group="${KCODER_STUDIO_SERVICE_GROUP:-$(id -gn)}"
  local node_bin="${KCODER_STUDIO_NODE_BIN:-$(command -v node || true)}"
  local npm_bin="${KCODER_STUDIO_NPM_BIN:-$(command -v npm || true)}"
  local service_path="$user_home/.local/bin:/usr/local/bin:/usr/bin:/bin"
  local mobile_ci_env=""
  local file value sudo_bin="${KCODER_STUDIO_SUDO_BIN:-sudo}"

  [[ "$service_user" =~ ^[A-Za-z_][A-Za-z0-9_.-]*\$?$ ]] || {
    echo "Invalid KCODER_STUDIO_SERVICE_USER: $service_user" >&2
    return 2
  }
  [[ "$service_group" =~ ^[A-Za-z_][A-Za-z0-9_.-]*\$?$ ]] || {
    echo "Invalid KCODER_STUDIO_SERVICE_GROUP: $service_group" >&2
    return 2
  }
  for value in "$user_home" "$node_bin" "$npm_bin"; do
    [[ "$value" == /* && "$value" != *'|'* && "$value" != *'&'* ]] || {
      echo "Studio service paths must be absolute and must not contain '|' or '&': $value" >&2
      return 2
    }
  done
  [[ -x "$node_bin" && -x "$npm_bin" ]] || {
    echo "KCODER_STUDIO_NODE_BIN and KCODER_STUDIO_NPM_BIN must be executable." >&2
    return 1
  }
  command -v "$sudo_bin" >/dev/null 2>&1 || {
    echo "sudo is required to install Studio Web systemd units." >&2
    return 1
  }
  if [[ "$profile" == release ]]; then
    mobile_ci_env="Environment=CI=1"
  fi

  staged_unit_dir="$(mktemp -d "${TMPDIR:-/tmp}/kcoder-studio-units.XXXXXX")"
  chmod 700 "$staged_unit_dir"
  for file in "${units[@]}"; do
    [[ -s "$systemd_dir/$file" ]] || {
      echo "Missing systemd unit: $systemd_dir/$file" >&2
      return 1
    }
    sed \
      -e "s|@KCODER_STUDIO_REPO_DIR@|$repo_dir|g" \
      -e "s|@KCODER_STUDIO_MOBILE_CI_ENV@|$mobile_ci_env|g" \
      -e "s|@KCODER_STUDIO_SERVICE_USER@|$service_user|g" \
      -e "s|@KCODER_STUDIO_SERVICE_GROUP@|$service_group|g" \
      -e "s|@KCODER_STUDIO_SERVICE_HOME@|$user_home|g" \
      -e "s|@KCODER_STUDIO_SERVICE_PATH@|$service_path|g" \
      -e "s|@KCODER_STUDIO_NODE_BIN@|$node_bin|g" \
      -e "s|@KCODER_STUDIO_NPM_BIN@|$npm_bin|g" \
      -e "s|@KCODER_STUDIO_RENDERER_MODE@|$renderer_mode|g" \
      "$systemd_dir/$file" >"$staged_unit_dir/$file"
  done
}

commit_web_services() {
  local sudo_bin="${KCODER_STUDIO_SUDO_BIN:-sudo}"
  local file
  for file in "${units[@]}"; do
    "$sudo_bin" install -m 0644 "$staged_unit_dir/$file" "/etc/systemd/system/$file"
  done
  "$sudo_bin" systemctl daemon-reload
}

for unit in "${active_units[@]}"; do
  if [[ "$install_services" != 1 ]] && ! unit_exists "$unit"; then
    echo "缺少服务单元 $unit。请直接使用 kcoder-studio-web-*.sh 默认托管启动，或检查 scripts/launch/services/systemd/。" >&2
    exit 1
  fi
done

if [[ "$install_services" == 1 ]]; then
  stage_web_services
fi

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

if [[ "$renderer_mode" == vite ]]; then
  echo "[2/7] 使用 Vite 实时加载 renderer（不构建静态 dist）..."
  [[ -f "$repo_dir/apps/kcoder-studio/renderer/node_modules/vite/package.json" ]] || {
    echo "请先执行 pnpm --dir apps/kcoder-studio/renderer install --frozen-lockfile。" >&2
    exit 1
  }
elif [[ "${KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD:-0}" != 1 ]]; then
  echo "[2/7] 构建当前 Studio renderer..."
  command -v pnpm >/dev/null 2>&1 || {
    echo "默认源码启动需要 pnpm；仅跳过 renderer 构建时设置 KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD=1。" >&2
    exit 1
  }
  # Run inside the package so Corepack selects its pinned packageManager; from
  # a directory without package.json it falls back to its latest pnpm.
  (cd "$repo_dir/apps/kcoder-studio/renderer" && pnpm build)
else
  echo "[2/7] 跳过 Studio renderer 构建（KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD=1）"
fi

if [[ "$profile" == release ]]; then
  echo "构建部署版 Mobile Web（由 Gateway 提供）..."
  npm --prefix "$mobile_dir" run build:web
fi

echo "[3/7] 检查当前源码二进制..."
"$source_binary" --version

echo "[4/7] 准备 $profile 用户配置目录..."
mkdir -p "$profile_home"
export KCODER_HOME="$profile_home"
export KCODER_CONFIG_DIR="$profile_home"
KCODER_REAL_BIN="$source_binary"
export KCODER_REAL_BIN
if [[ "$sync_development" == 1 ]]; then
  kcoder_sync_development_config
else
  "$source_binary" config migrate >/dev/null
fi
"$source_binary" config validate
binary_stage="$(mktemp "$user_home/.local/bin/.${binary_name}.XXXXXX")"
if ! install -m 0755 "$source_binary" "$binary_stage"; then
  rm -f -- "$binary_stage"
  echo "无法暂存已验证的 $build_profile 二进制。" >&2
  exit 1
fi
if [[ "$install_services" == 1 ]]; then
  commit_web_services
fi
mv -f -- "$binary_stage" "$user_bin"
binary_stage=""
KCODER_REAL_BIN="$user_bin"
export KCODER_REAL_BIN
set_gateway_binary

echo "[5/7] 停止本仓库旧服务和旧进程..."
stop_units
stop_owned_processes

echo "[6/7] 启动 Gateway、Studio Web 和 Mobile Web..."
"${systemctl_cmd[@]}" daemon-reload
"${systemctl_cmd[@]}" start kcoder-studio-web.service
"${systemctl_cmd[@]}" start kcoder-studio-client.service
if [[ "$profile" == dev ]]; then
  "${systemctl_cmd[@]}" start kcoder-studio-mobile-bundler.service
  "${systemctl_cmd[@]}" start kcoder-studio-mobile-web.service
fi

echo "[7/7] 等待服务进入 active..."
for unit in "${active_units[@]}"; do
  "${systemctl_cmd[@]}" is-active --quiet "$unit" || {
    echo "服务未能启动：$unit" >&2
    "${systemctl_cmd[@]}" status "$unit" --no-pager -l >&2 || true
    exit 1
  }
done

# This managed Gateway binds loopback; use its actual configured port for links.
gateway_port=4173
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^KCODER_STUDIO_PORT=([0-9]+)$ ]]; then
    gateway_port="${BASH_REMATCH[1]}"
  fi
done <"$gateway_env"
mobile_url=http://127.0.0.1:4175
if [[ "$profile" == release ]]; then
  mobile_url="http://127.0.0.1:$gateway_port/mobile/"
fi

cat <<EOF
$profile 环境已启动。
  Gateway（本机）: http://127.0.0.1:$gateway_port
  Studio Web: http://127.0.0.1:4174
  Mobile Web（本机）: $mobile_url
  Rust CLI:   $user_bin
  日志目录:    $log_dir（systemd 服务日志使用 journalctl）
EOF
