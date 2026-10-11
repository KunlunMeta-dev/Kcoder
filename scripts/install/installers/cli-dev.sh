#!/usr/bin/env bash
# Build and install the debug CLI development profile from the current checkout.

set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -P "$script_dir/../../.." && pwd)"
install_dir="${KCODER_DEV_INSTALL_DIR:-${HOME:?HOME is required}/.local/bin}"
profile_home="${KCODER_CONFIG_DIR:-${KCODER_HOME:-${HOME:?HOME is required}/.config/kcoder-dev}}"
binary="$install_dir/kcoder-dev"

source "$repo_dir/scripts/install/lib/profile.sh"
source "$repo_dir/scripts/install/lib/binary.sh"
source "$repo_dir/scripts/install/lib/config-sync.sh"
source "$repo_dir/scripts/install/lib/ripgrep.sh"

export KCODER_HOME="$profile_home"
export KCODER_CONFIG_DIR="$profile_home"

echo "Building KCoder debug CLI from $repo_dir..." >&2
(cd "$repo_dir" && cargo build --locked --bin kcoder)
[[ -x "$repo_dir/target/debug/kcoder" ]] || {
  echo "Debug build did not produce $repo_dir/target/debug/kcoder" >&2
  exit 1
}

mkdir -p "$install_dir"
install -m 0755 "$repo_dir/target/debug/kcoder" "$binary"
rg_resource_dir="${KCODER_RIPGREP_DIR:-$(cd "$install_dir/.." && pwd)/lib/kcoder}"
if rg_path="$(kcoder_install_ripgrep "$rg_resource_dir" "${KCODER_RIPGREP_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}")"; then
  echo "Installed bundled ripgrep to $rg_path"
else
  echo "ripgrep resource was not installed; KCoder will use its Rust search fallback." >&2
fi
KCODER_REAL_BIN="$binary"
export KCODER_REAL_BIN
kcoder_sync_development_config
"$binary" config validate >/dev/null
"$binary" --version
echo "Installed debug CLI: $binary"
echo "Development profile: $profile_home"
