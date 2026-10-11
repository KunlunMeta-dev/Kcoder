#!/usr/bin/env bash

# Profile, repository-location, and environment initialization shared by installers and source launchers.

kcoder_find_repo_dir() {
  local start_dir="$1"
  local candidate
  candidate="$(cd -P "$start_dir" && pwd)"
  while [[ "$candidate" != "/" && ! -f "$candidate/Cargo.toml" ]]; do
    candidate="$(dirname "$candidate")"
  done
  [[ -f "$candidate/Cargo.toml" ]] || {
    echo "无法从 $start_dir 定位 KCoder checkout。" >&2
    return 1
  }
  printf '%s\n' "$candidate"
}

kcoder_launch_init() {
  local launch_dir="$1"
  local profile="${2:-dev}"

  KCODER_REPO_DIR="$(kcoder_find_repo_dir "$launch_dir")"
  KCODER_LAUNCH_CWD="$(pwd)"

  local default_home="${HOME:?HOME must be set}/.config/kcoder-dev"
  case "$profile" in
    dev)
      default_home="${KCODER_DEV_HOME:-$default_home}"
      ;;
    release)
      default_home="${KCODER_RELEASE_HOME:-${HOME:?HOME must be set}/.config/kcoder}"
      ;;
    *)
      echo "未知启动 profile：$profile（应为 dev 或 release）。" >&2
      return 2
      ;;
  esac
  # A source launcher shares state with its matching installation profile; tests and temporary sandboxes may still override the directory explicitly.
  export KCODER_HOME="${KCODER_HOME:-$default_home}"

  unset KCODER_PROVIDER
  unset KCODER_USE_ANTHROPIC KCODER_USE_OPENAI
  unset KCODER_USE_GEMINI KCODER_USE_GROK
  unset KCODER_USE_LOCAL KCODER_USE_VLLM KCODER_USE_SGLANG
  unset ANTHROPIC_BASE_URL OPENAI_BASE_URL KCODER_LOCAL_BASE_URL
}
