#!/usr/bin/env bash

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
binary="${KCODER_TEST_BIN:-$repo_dir/target/release/kcoder}"
[[ -x "$binary" ]] || {
  echo "Build a release binary first: cargo build -p kcoder_cli --bin kcoder --release --locked" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
export KCODER_INSTALL_DIR="$HOME/.local/bin"
export KCODER_CONFIG_DIR="$HOME/.config/kcoder"
export KCODER_RELEASE_BIN="$binary"
mkdir -p "$HOME" "$tmp/workspace/nested"

(cd "$tmp/workspace" && "$repo_dir/scripts/install/installers/cli-release.sh")
installed="$KCODER_INSTALL_DIR/kcoder"
"$installed" --cwd "$tmp/workspace" config set model installed-user-model
"$installed" --cwd "$tmp/workspace" config set model installed-project-model --scope project
[[ "$("$installed" --cwd "$tmp/workspace" config get model)" == "installed-project-model" ]]
[[ "$("$installed" --cwd "$tmp/workspace/nested" config get model)" == "installed-user-model" ]]
"$installed" --cwd "$tmp/workspace/nested" config validate
"$installed" --cwd "$tmp/workspace/nested" doctor >/dev/null

echo "Installed CLI smoke test passed: $installed"
