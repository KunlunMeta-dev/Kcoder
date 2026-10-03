#!/usr/bin/env bash
# Start local KCoder Studio Electron; the gateway manages app-server child processes on demand.

set -euo pipefail

resolve_script() {
  if command -v readlink >/dev/null 2>&1 && readlink -f "${BASH_SOURCE[0]}" >/dev/null 2>&1; then
    readlink -f "${BASH_SOURCE[0]}"
    return
  fi
  cd -P "$(dirname "${BASH_SOURCE[0]}")" && printf '%s/%s\n' "$(pwd)" "$(basename "${BASH_SOURCE[0]}")"
}

script_path="$(resolve_script)"
script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
repo_dir="$(cd -P "$script_dir/../.." && pwd)"
studio_dir="$repo_dir/apps/kcoder-studio"
profile="${KCODER_STUDIO_PROFILE:-release}"

case "$profile" in
  dev)
    default_binary="${HOME:?HOME is required}/.local/bin/kcoder-dev"
    default_home="${HOME:?HOME is required}/.config/kcoder-dev"
    ;;
  release)
    default_binary="${HOME:?HOME is required}/.local/bin/kcoder"
    default_home="${HOME:?HOME is required}/.config/kcoder"
    ;;
  *)
    echo "Unsupported Studio profile: $profile (expected dev or release)." >&2
    exit 2
    ;;
esac

while (($#)); do
  case "$1" in
    --dev)
      profile=dev
      default_binary="${HOME:?HOME is required}/.local/bin/kcoder-dev"
      default_home="${HOME:?HOME is required}/.config/kcoder-dev"
      shift
      ;;
    --release)
      profile=release
      default_binary="${HOME:?HOME is required}/.local/bin/kcoder"
      default_home="${HOME:?HOME is required}/.config/kcoder"
      shift
      ;;
    --managed)
      echo "kcoder-studio 只启动本地 Electron；Web systemd 托管请使用 scripts/launch/kcoder-studio-web-*.sh。" >&2
      exit 2
      ;;
    --help|-h)
      cat <<'EOF'
用法：kcoder-studio [--dev|--release] [Electron 参数]

默认启动 release profile。Electron 自带 loopback Gateway，并在需要时启动匹配的 app-server；退出时会清理由 Gateway 创建的子进程。
EOF
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

binary="${KCODER_STUDIO_KCODER_BIN:-$default_binary}"
# System-wide source installation intentionally does not create a user-local CLI.
# Fall back only when the user did not explicitly choose a binary.
if [[ -z "${KCODER_STUDIO_KCODER_BIN:-}" && ! -x "$binary" ]]; then
  profile_command=kcoder
  [[ "$profile" != dev ]] || profile_command=kcoder-dev
  resolved_binary="$(command -v "$profile_command" || true)"
  if [[ "$resolved_binary" == /* && -x "$resolved_binary" ]]; then
    binary="$resolved_binary"
  fi
fi
profile_home="${KCODER_STUDIO_KCODER_HOME:-${KCODER_CONFIG_DIR:-${KCODER_HOME:-$default_home}}}"

[[ -d "$studio_dir" && -f "$studio_dir/package.json" ]] || {
  echo "KCoder Studio checkout is missing: $studio_dir" >&2
  exit 1
}
[[ -x "$binary" ]] || {
  echo "KCoder $profile binary is not executable: $binary" >&2
  if [[ "$profile" == dev ]]; then
    echo "先运行 scripts/install/installers/cli-dev.sh，或使用 scripts/launch/kcoder-studio-web-dev.sh。" >&2
  else
    echo "先运行 scripts/install/installers/cli-release.sh，或使用 scripts/launch/kcoder-studio-web-release.sh。" >&2
  fi
  exit 1
}
command -v pnpm >/dev/null 2>&1 || {
  echo "pnpm is required to start KCoder Studio from source." >&2
  exit 1
}
if [[ "${KCODER_STUDIO_SKIP_DEPENDENCY_CHECK:-0}" != 1 && ! -x "$studio_dir/node_modules/.bin/electron" ]]; then
  echo "KCoder Studio dependencies are missing: $studio_dir/node_modules/.bin/electron" >&2
  echo "Run: pnpm --dir apps/kcoder-studio install" >&2
  exit 1
fi

export KCODER_STUDIO_PROFILE="$profile"
export KCODER_STUDIO_KCODER_BIN="$binary"
export KCODER_HOME="$profile_home"
export KCODER_CONFIG_DIR="$profile_home"
export KCODER_STUDIO_WORKSPACE="${KCODER_STUDIO_WORKSPACE:-$PWD}"

exec pnpm --dir "$studio_dir" desktop "$@"
