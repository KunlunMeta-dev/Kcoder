#!/usr/bin/env bash

# Reuse Cargo build caches across local worktrees.
#
# Each component uses a separate target directory. Cargo serializes concurrent
# access to one directory and evicts stale artifacts when fingerprints change.

shared_cargo_cache_root() {
  if [ -n "${KCODER_CARGO_TARGET_ROOT:-}" ]; then
    printf '%s\n' "${KCODER_CARGO_TARGET_ROOT%/}"
  elif [ -n "${XDG_CACHE_HOME:-}" ]; then
    printf '%s\n' "${XDG_CACHE_HOME%/}/kcoder/cargo-target"
  elif [ -n "${HOME:-}" ]; then
    printf '%s\n' "$HOME/.cache/kcoder/cargo-target"
  fi
}

configure_shared_sccache() {
  local project_dir="$1"
  local target_dir="$2"
  local canonical_project_dir=""

  if [ "${KCODER_DISABLE_SCCACHE:-0}" = "1" ]; then
    return 0
  fi

  if [ -n "${RUSTC_WRAPPER:-}" ] && [ "${KCODER_SCCACHE_AUTO:-0}" != "1" ]; then
    return 0
  fi

  if command -v sccache >/dev/null 2>&1; then
    canonical_project_dir="$(cd "$project_dir" 2>/dev/null && pwd -P)" || return 1
    RUSTC_WRAPPER="$(command -v sccache)"
    export RUSTC_WRAPPER
    export CARGO_INCREMENTAL=0
    export KCODER_SCCACHE_AUTO=1
    if [ -z "${SCCACHE_BASEDIRS:-}" ] || [ "${KCODER_SCCACHE_BASEDIRS_AUTO:-0}" = "1" ]; then
      export SCCACHE_BASEDIRS="$canonical_project_dir:$target_dir"
      export KCODER_SCCACHE_BASEDIRS_AUTO=1
    fi
  fi
}

install_shared_sccache_with_homebrew() {
  if [ "${KCODER_DISABLE_SCCACHE:-0}" = "1" ] || command -v sccache >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v brew >/dev/null 2>&1; then
    echo "Error: sccache is required for shared Rust compilation caching." >&2
    echo "Install Homebrew or set KCODER_DISABLE_SCCACHE=1 to continue without sccache." >&2
    return 1
  fi

  echo "sccache is not installed; installing it with Homebrew..."
  brew install sccache
}

configure_shared_cargo_target_dir() {
  local project_dir="$1"
  local cache_name="$2"

  if [ "${KCODER_DISABLE_SHARED_CARGO_TARGET:-0}" = "1" ]; then
    configure_shared_sccache "$project_dir" "$project_dir/target"
    return 0
  fi

  if [ -n "${CARGO_TARGET_DIR:-}" ]; then
    configure_shared_sccache "$project_dir" "$CARGO_TARGET_DIR"
    return 0
  fi

  local cache_root=""
  cache_root="$(shared_cargo_cache_root)"
  [ -n "$cache_root" ] || return 0

  export CARGO_TARGET_DIR="$cache_root/$cache_name"
  export KCODER_CARGO_TARGET_DIR_AUTO=1
  mkdir -p "$CARGO_TARGET_DIR"
  configure_shared_sccache "$project_dir" "$CARGO_TARGET_DIR"
}

cargo_target_dir_for() {
  local manifest_dir="$1"

  if [ -n "${CARGO_TARGET_DIR:-}" ]; then
    case "$CARGO_TARGET_DIR" in
      /*) printf '%s\n' "$CARGO_TARGET_DIR" ;;
      *) printf '%s/%s\n' "$(pwd)" "$CARGO_TARGET_DIR" ;;
    esac
    return 0
  fi

  printf '%s/target\n' "$manifest_dir"
}

cargo_target_binary_path() {
  local manifest_dir="$1"
  local profile="$2"
  local binary="$3"

  printf '%s/%s/%s\n' "$(cargo_target_dir_for "$manifest_dir")" "$profile" "$binary"
}
