#!/usr/bin/env bash
# Build and install the release CLI from the current checkout.

set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="${KCODER_REPO_DIR:-$(cd -P "$script_dir/../../.." && pwd)}"
install_dir="${KCODER_INSTALL_DIR:-${HOME:?HOME is required}/.local/bin}"
formal_home="${KCODER_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kcoder}"
cargo_bin="${KCODER_CARGO_BIN:-cargo}"
source "$repo_dir/scripts/install/lib/ripgrep.sh"
export KCODER_HOME="$formal_home"
if [[ -z "${KCODER_CONFIG_DIR:-}" ]]; then
  export KCODER_CONFIG_DIR="$formal_home"
fi

[[ -d "$repo_dir" ]] || { echo "KCoder checkout not found: $repo_dir" >&2; exit 1; }
if [[ "$repo_dir" != /* ]]; then
  repo_dir="$(cd -P "$repo_dir" && pwd)"
fi
target_dir="${KCODER_TARGET_DIR:-$repo_dir/target}"
binary="${KCODER_RELEASE_BIN:-$target_dir/release/kcoder}"
if [[ "$target_dir" != /* ]]; then
  target_dir="$repo_dir/$target_dir"
  [[ -n "${KCODER_RELEASE_BIN:-}" ]] || binary="$target_dir/release/kcoder"
fi

if [[ -z "${KCODER_RELEASE_BIN:-}" ]]; then
  command -v "$cargo_bin" >/dev/null 2>&1 || {
    echo "cargo is required to build the local KCoder release." >&2
    exit 1
  }
  echo "Building KCoder release CLI from $repo_dir..." >&2
  (
    cd "$repo_dir"
    CARGO_TARGET_DIR="$target_dir" "$cargo_bin" build -p kcoder_cli --bin kcoder --release --locked
  )
fi

[[ -x "$binary" ]] || {
  echo "Release binary not found: $binary" >&2
  echo "Build it with: cargo build -p kcoder_cli --bin kcoder --release --locked" >&2
  exit 1
}

mkdir -p "$install_dir"
install -m 0755 "$binary" "$install_dir/kcoder"
echo "Installed local KCoder release to $install_dir/kcoder"
retired_family=kunlun
retired_stem="${retired_family}code"
for retired_command in "$install_dir/$retired_family" "$install_dir/$retired_stem"; do
  if [[ -d "$retired_command" && ! -L "$retired_command" ]]; then
    echo "Refusing to replace a retired command directory in $install_dir" >&2
    exit 1
  fi
  if [[ -e "$retired_command" || -L "$retired_command" ]]; then
    rm -f -- "$retired_command"
    echo "Removed a retired command entry from $install_dir"
  fi
done

rg_resource_dir="${KCODER_RIPGREP_DIR:-$(cd "$install_dir/.." && pwd)/lib/kcoder}"
if rg_path="$(kcoder_install_ripgrep "$rg_resource_dir" "${KCODER_RIPGREP_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}")"; then
  echo "Installed bundled ripgrep to $rg_path"
else
  echo "ripgrep resource was not installed; KCoder will use its Rust search fallback." >&2
fi

settings_path="$("$install_dir/kcoder" config path --scope user)"
if [[ ! -e "$settings_path" ]]; then
  "$install_dir/kcoder" config init --scope user
else
  echo "Keeping existing user settings: $settings_path"
fi
"$install_dir/kcoder" --version
echo "No credentials were imported. Use: kcoder auth login --provider <provider>"

case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH: export PATH=\"$install_dir:\$PATH\"" >&2 ;;
esac
