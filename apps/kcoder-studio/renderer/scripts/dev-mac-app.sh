#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KCODER_STUDIO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="$(cd "$KCODER_STUDIO_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"
INITIAL_KCODER_RENDERER_PORT="${KCODER_RENDERER_PORT:-}"

# shellcheck source=../../scripts/lib/cargo-cache.sh
source "$PROJECT_DIR/scripts/lib/cargo-cache.sh"
# shellcheck source=lib/renderer-mac-env.sh
source "$SCRIPT_DIR/lib/renderer-mac-env.sh"

MACOS_BUILD_TARGET="${MACOS_BUILD_TARGET:-}"
KCODER_STUDIO_RELEASE_UI="false"
EXECUTOR_ISOLATION_OVERRIDE="${KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE:-}"

usage() {
  cat <<'EOF'
Usage: bash renderer/scripts/dev-mac-app.sh [options]

Options:
  -p, --port PORT       Vite/Tauri dev server port. Overrides KCODER_RENDERER_PORT.
  --target TARGET       macOS Rust/Tauri target, e.g. aarch64-apple-darwin.
  --release-ui          Run a production frontend bundle through tauri dev.
  --shared-executor-home
                        Alias for --no-executor-isolation.
  --executor-isolation  Use an instance-specific Executor Home instead of the
                        release app's persisted projects and tasks.
  --no-executor-isolation
                        Use the release app's persisted projects and tasks
                        (the default).
  -h, --help            Show this help message.

Environment:
  KCODER_RENDERER_PORT           Default dev server port when --port is not provided.
  KCODER_RENDERER_HOST           Host IP used to build backend proxy targets.
  BACKEND_PORT          Backend port used when proxy targets are not set.
  CARGO_TARGET_DIR      Explicit Cargo target directory. Overrides auto cache.
  KCODER_CARGO_TARGET_ROOT
                        Root containing shared Cargo targets.
  KCODER_DISABLE_SHARED_CARGO_TARGET
                        Set to 1 to keep Cargo's default per-worktree target.
  KCODER_DISABLE_SCCACHE
                        Set to 1 to disable automatic sccache detection.
  KCODER_STUDIO_EXECUTOR_SIDECAR
                        Executor sidecar path. Defaults to source reload sidecar.
  WEGENT_EXECUTOR_DEV_RELOAD
                        Set to 0 to run executor source once without reload.
  KCODER_STUDIO_SHARED_EXECUTOR_HOME
                        Set to 1 to use the normal executor home in debug builds.
  KCODER_STUDIO_MALLOC_STACK_LOGGING
                        Set to 1 to enable macOS malloc stack logging for WebKit diagnostics.
  KCODER_STUDIO_DISABLE_BACKGROUND_THROTTLING
                        Set to 1 to keep the macOS WebView active while hidden.
  MACOS_BUILD_TARGET    Default macOS Rust/Tauri target when --target is not provided.

Examples:
  bash renderer/scripts/dev-mac-app.sh --port 9130
  bash renderer/scripts/dev-mac-app.sh --shared-executor-home
  bash renderer/scripts/dev-mac-app.sh --no-executor-isolation
  bash renderer/scripts/dev-mac-app.sh --release-ui --target aarch64-apple-darwin
  KCODER_RENDERER_PORT=9130 bash renderer/scripts/dev-mac-app.sh
EOF
}

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [ -n "$INITIAL_KCODER_RENDERER_PORT" ]; then
  KCODER_RENDERER_PORT="$INITIAL_KCODER_RENDERER_PORT"
fi

REQUESTED_KCODER_RENDERER_PORT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    -p|--port)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a port value." >&2
        usage
        exit 1
      fi
      REQUESTED_KCODER_RENDERER_PORT="$2"
      shift 2
      ;;
    --port=*)
      REQUESTED_KCODER_RENDERER_PORT="${1#*=}"
      shift
      ;;
    --target)
      if [ "$#" -lt 2 ]; then
        echo "Error: $1 requires a target value." >&2
        usage
        exit 1
      fi
      MACOS_BUILD_TARGET="$2"
      shift 2
      ;;
    --target=*)
      MACOS_BUILD_TARGET="${1#*=}"
      shift
      ;;
    --release-ui)
      KCODER_STUDIO_RELEASE_UI="true"
      shift
      ;;
    --executor-isolation)
      if [ "$EXECUTOR_ISOLATION_OVERRIDE" = "false" ]; then
        echo "Error: --executor-isolation and shared executor options are mutually exclusive." >&2
        exit 1
      fi
      EXECUTOR_ISOLATION_OVERRIDE="true"
      shift
      ;;
    --shared-executor-home|--no-executor-isolation)
      if [ "$EXECUTOR_ISOLATION_OVERRIDE" = "true" ]; then
        echo "Error: --executor-isolation and shared executor options are mutually exclusive." >&2
        exit 1
      fi
      EXECUTOR_ISOLATION_OVERRIDE="false"
      if [ "$1" = "--shared-executor-home" ]; then
        export KCODER_STUDIO_SHARED_EXECUTOR_HOME=1
      fi
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Interactive development should use the same persisted projects and tasks as
# the release app. Verification and E2E launchers provide their own isolated
# executor homes and do not use this default.
if [ -z "$EXECUTOR_ISOLATION_OVERRIDE" ]; then
  EXECUTOR_ISOLATION_OVERRIDE="false"
fi

if [ -n "$EXECUTOR_ISOLATION_OVERRIDE" ]; then
  export KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE="$EXECUTOR_ISOLATION_OVERRIDE"
else
  unset KCODER_STUDIO_EXECUTOR_ISOLATION_OVERRIDE
fi

BACKEND_BASE_URL="$(wework_resolve_backend_base_url)"
BACKEND_PORT="${BACKEND_PORT:-9100}"
KCODER_RENDERER_PORT="${REQUESTED_KCODER_RENDERER_PORT:-${KCODER_RENDERER_PORT:-1420}}"

if ! [[ "$KCODER_RENDERER_PORT" =~ ^[0-9]+$ ]] || [ "$KCODER_RENDERER_PORT" -lt 1 ] || [ "$KCODER_RENDERER_PORT" -gt 65535 ]; then
  echo "Error: KCODER_RENDERER_PORT must be a number between 1 and 65535. Got: $KCODER_RENDERER_PORT" >&2
  exit 1
fi

is_port_available() {
  node - "$1" <<'NODE'
const net = require('node:net')
const port = Number(process.argv[2])

const canListen = host =>
  new Promise(resolve => {
    const server = net.createServer()

    server.once('error', () => resolve(false))
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })

;(async () => {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    if (!(await canListen(host))) {
      process.exit(1)
    }
  }
})()
NODE
}

find_available_wework_port() {
  local port="$1"

  while [ "$port" -le 65535 ]; do
    if is_port_available "$port"; then
      echo "$port"
      return 0
    fi
    port="$((port + 1))"
  done

  echo "Error: no available KCODER_RENDERER_PORT found from $1 to 65535." >&2
  return 1
}

git_branch_name() {
  git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || true
}

basename_or_path() {
  local path="$1"

  basename "$path" 2>/dev/null || echo "$path"
}

build_wework_dev_title() {
  local parent_title="${KCODER_STUDIO_PARENT_TITLE:-}"
  local branch
  local worktree_name

  if [ -n "$parent_title" ]; then
    echo "$parent_title"
    return 0
  fi

  branch="$(git_branch_name)"
  worktree_name="$(basename_or_path "$PROJECT_DIR")"
  if [ -n "$branch" ]; then
    echo "$branch"
    return 0
  fi

  echo "$worktree_name"
}

AVAILABLE_KCODER_RENDERER_PORT="$(find_available_wework_port "$KCODER_RENDERER_PORT")"
if [ "$AVAILABLE_KCODER_RENDERER_PORT" != "$KCODER_RENDERER_PORT" ]; then
  echo "KCODER_RENDERER_PORT $KCODER_RENDERER_PORT is already in use; using $AVAILABLE_KCODER_RENDERER_PORT instead."
fi
KCODER_RENDERER_PORT="$AVAILABLE_KCODER_RENDERER_PORT"

export KCODER_STUDIO_DEV_WORKTREE="$PROJECT_DIR"
export KCODER_STUDIO_DEV_BRANCH="$(git_branch_name)"
export KCODER_STUDIO_DEV_PORT="$KCODER_RENDERER_PORT"
export KCODER_STUDIO_DEV_TITLE="$(build_wework_dev_title)"
export VITE_KCODER_STUDIO_DEV_TITLE="$KCODER_STUDIO_DEV_TITLE"
export VITE_KCODER_STUDIO_DEV_PORT="$KCODER_STUDIO_DEV_PORT"
export VITE_KCODER_STUDIO_DEV_WORKTREE="$KCODER_STUDIO_DEV_WORKTREE"
export VITE_KCODER_STUDIO_DEV_BRANCH="$KCODER_STUDIO_DEV_BRANCH"
export VITE_KCODER_STUDIO_PARENT_TITLE="${KCODER_STUDIO_PARENT_TITLE:-}"
export VITE_KCODER_STUDIO_PARENT_PROJECT="${KCODER_STUDIO_PARENT_PROJECT:-}"
export VITE_KCODER_STUDIO_PARENT_WORKSPACE="${KCODER_STUDIO_PARENT_WORKSPACE:-}"

export SKIP_FONT_DOWNLOAD="${SKIP_FONT_DOWNLOAD:-1}"
export VITE_WEGENT_BACKEND_URL="${VITE_WEGENT_BACKEND_URL:-$BACKEND_BASE_URL}"
if [ -z "${KCODER_STUDIO_EXECUTOR_SIDECAR:-}" ]; then
  KCODER_STUDIO_EXECUTOR_SIDECAR="$KCODER_STUDIO_DIR/scripts/dev-executor-sidecar.sh"
fi
export KCODER_STUDIO_EXECUTOR_SIDECAR

if [ "$KCODER_STUDIO_RELEASE_UI" = "true" ]; then
  BEFORE_DEV_COMMAND="pnpm run build && pnpm exec vite preview --host 0.0.0.0 --port $KCODER_RENDERER_PORT --strictPort"
else
  BEFORE_DEV_COMMAND="pnpm exec vite --host 0.0.0.0 --port $KCODER_RENDERER_PORT --strictPort"
fi
install_shared_sccache_with_homebrew
configure_shared_cargo_target_dir "$PROJECT_DIR" "wework-src-tauri"

TAURI_DEV_CONFIG="$(mktemp -t kcoder-tauri-dev.XXXXXX.json)"
trap 'rm -f "$TAURI_DEV_CONFIG"' EXIT

KCODER_RENDERER_PORT_VALUE="$KCODER_RENDERER_PORT" \
BEFORE_DEV_COMMAND_VALUE="$BEFORE_DEV_COMMAND" \
KCODER_STUDIO_RELEASE_UI_VALUE="$KCODER_STUDIO_RELEASE_UI" \
KCODER_STUDIO_APP_IDENTIFIER_VALUE="${KCODER_STUDIO_APP_IDENTIFIER:-}" \
KCODER_STUDIO_DISABLE_BACKGROUND_THROTTLING_VALUE="${KCODER_STUDIO_DISABLE_BACKGROUND_THROTTLING:-0}" \
KCODER_STUDIO_DIR_VALUE="$KCODER_STUDIO_DIR" \
TAURI_DEV_CONFIG_VALUE="$TAURI_DEV_CONFIG" \
python3 - <<'PY'
import json
import os

config = {
    "build": {
        "devUrl": f"http://localhost:{os.environ['KCODER_RENDERER_PORT_VALUE']}",
        "beforeDevCommand": os.environ["BEFORE_DEV_COMMAND_VALUE"],
    },
}

app_identifier = os.environ["KCODER_STUDIO_APP_IDENTIFIER_VALUE"].strip()
if app_identifier:
    config["identifier"] = app_identifier

if os.environ["KCODER_STUDIO_DISABLE_BACKGROUND_THROTTLING_VALUE"] == "1":
    with open(
        os.path.join(os.environ["KCODER_STUDIO_DIR_VALUE"], "src-tauri", "tauri.conf.json"),
        encoding="utf-8",
    ) as handle:
        base_config = json.load(handle)
    windows = base_config["app"]["windows"]
    for window in windows:
        window["backgroundThrottling"] = "disabled"
    config["app"] = {"windows": windows}

if os.environ["KCODER_STUDIO_RELEASE_UI_VALUE"] != "true":
    config["bundle"] = {
        "icon": [
            "icons/icon-dev.icns",
            "icons/icon.png",
        ],
    }

with open(os.environ["TAURI_DEV_CONFIG_VALUE"], "w", encoding="utf-8") as handle:
    json.dump(config, handle, indent=2)
    handle.write("\n")
PY

echo "Starting WeWork mac app"
echo "  RELEASE_UI=$KCODER_STUDIO_RELEASE_UI"
echo "  KCODER_RENDERER_PORT=$KCODER_RENDERER_PORT"
echo "  KCODER_STUDIO_DEV_TITLE=$KCODER_STUDIO_DEV_TITLE"
echo "  KCODER_STUDIO_DEV_WORKTREE=$KCODER_STUDIO_DEV_WORKTREE"
echo "  KCODER_STUDIO_DEV_BRANCH=${KCODER_STUDIO_DEV_BRANCH:-<detached>}"
echo "  KCODER_STUDIO_APP_IDENTIFIER=${KCODER_STUDIO_APP_IDENTIFIER:-dev.kcoder.studio}"
echo "  MACOS_BUILD_TARGET=${MACOS_BUILD_TARGET:-<native>}"
echo "  VITE_WEGENT_BACKEND_URL=$VITE_WEGENT_BACKEND_URL"
echo "  VITE_WEGENT_SOCKET_URL=${VITE_WEGENT_SOCKET_URL:-<backend URL>}"
echo "  KCODER_STUDIO_EXECUTOR_SIDECAR=${KCODER_STUDIO_EXECUTOR_SIDECAR:-<bundled sidecar>}"
echo "  KCODER_STUDIO_SHARED_EXECUTOR_HOME=${KCODER_STUDIO_SHARED_EXECUTOR_HOME:-0}"
echo "  EXECUTOR_ISOLATION=${EXECUTOR_ISOLATION_OVERRIDE:-auto}"
echo "  CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-<cargo default>}"

if [ "${KCODER_STUDIO_MALLOC_STACK_LOGGING:-}" = "1" ]; then
  export MallocStackLogging=1
  export MallocStackLoggingNoCompact=1
  echo "  MallocStackLogging=1"
  echo "  MallocStackLoggingNoCompact=1"
fi

if [ "${KCODER_STUDIO_DRY_RUN:-}" = "1" ]; then
  echo "  TAURI_DEV_CONFIG=$TAURI_DEV_CONFIG"
  cat "$TAURI_DEV_CONFIG"
  exit 0
fi

cd "$KCODER_STUDIO_DIR"
TAURI_ARGS=(dev --config "$TAURI_DEV_CONFIG")
if [ "$KCODER_STUDIO_RELEASE_UI" = "true" ]; then
  TAURI_ARGS+=(--release)
fi
if [ -n "$MACOS_BUILD_TARGET" ]; then
  TAURI_ARGS+=(--target "$MACOS_BUILD_TARGET")
fi
exec pnpm exec tauri "${TAURI_ARGS[@]}"
