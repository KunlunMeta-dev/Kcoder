#!/usr/bin/env bash

# Cross-compile and package the Windows GNU CLI release on Linux.

set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -P "$script_dir/../.." && pwd)"
source "$repo_dir/scripts/install/lib/ripgrep.sh"
version="${1:-$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$repo_dir/Cargo.toml" | head -1)}"
target="${KCODER_WINDOWS_TARGET:-x86_64-pc-windows-gnu}"
out_dir="${KCODER_RELEASE_OUT:-$repo_dir/target/dist}"
cargo_bin="${KCODER_CARGO_BIN:-cargo}"
rustup_bin="${KCODER_RUSTUP_BIN:-rustup}"
zip_bin="${KCODER_ZIP_BIN:-zip}"
linker="${KCODER_WINDOWS_LINKER:-x86_64-w64-mingw32-gcc}"
installer="$script_dir/install-kcoder.ps1"

if [[ "$target" != x86_64-pc-windows-gnu ]]; then
  echo "当前 Linux 交叉打包脚本仅支持 x86_64-pc-windows-gnu：$target" >&2
  exit 2
fi
command -v "$cargo_bin" >/dev/null 2>&1 || {
  echo "cargo is required." >&2
  exit 1
}
command -v "$rustup_bin" >/dev/null 2>&1 || {
  echo "rustup is required." >&2
  exit 1
}
command -v "$zip_bin" >/dev/null 2>&1 || {
  echo "zip is required." >&2
  exit 1
}
command -v "$linker" >/dev/null 2>&1 || {
  echo "Windows GNU linker is missing: $linker" >&2
  echo "Install the MinGW-w64 toolchain before running this script." >&2
  exit 1
}
if ! "$rustup_bin" target list --installed | grep -Fxq "$target"; then
  echo "Rust target is missing: $target" >&2
  echo "Install it with: rustup target add $target" >&2
  exit 1
fi

target_env="${target//-/_}"
target_env="${target_env^^}"
target_env="${target_env//./_}"
export "CARGO_TARGET_${target_env}_LINKER=$linker"

echo "Building KCoder Windows CLI ($target)..." >&2
(
  cd "$repo_dir"
  "$cargo_bin" build -p kcoder_cli --bin kcoder --release --locked --target "$target"
  "$cargo_bin" build -p kcoder_process_supervisor --bin kcoder-process-supervisor --release --locked --target "$target"
)

binary="$repo_dir/target/$target/release/kcoder.exe"
supervisor_binary="$repo_dir/target/$target/release/kcoder-process-supervisor.exe"
[[ -x "$binary" ]] || { echo "Windows CLI binary not found: $binary" >&2; exit 1; }
[[ -x "$supervisor_binary" ]] || { echo "Windows process supervisor not found: $supervisor_binary" >&2; exit 1; }
[[ -f "$installer" ]] || { echo "Windows installer script not found: $installer" >&2; exit 1; }

mkdir -p "$out_dir"
stage="$(mktemp -d "${TMPDIR:-/tmp}/kcoder-windows-release.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
install -m 0755 "$binary" "$stage/kcoder.exe"
install -m 0755 "$supervisor_binary" "$stage/kcoder-process-supervisor.exe"
install -m 0644 "$installer" "$stage/install-kcoder.ps1"
if ! kcoder_install_ripgrep "$stage/lib/kcoder" "$target" >/dev/null; then
  echo "Warning: ripgrep was not bundled for $target; the Rust search fallback remains available." >&2
fi

archive="$out_dir/kcoder-$version-$target.zip"
latest_archive="$out_dir/kcoder-$target.zip"
"$zip_bin" -9 -j -q "$archive" \
  "$stage/kcoder.exe" \
  "$stage/kcoder-process-supervisor.exe" \
  "$stage/install-kcoder.ps1"
if [[ -f "$stage/lib/kcoder/rg.exe" ]]; then
  (cd "$stage" && "$zip_bin" -9 -q -r "$archive" lib)
fi
cp "$archive" "$latest_archive"

if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$out_dir"
    sha256sum "$(basename "$archive")" >"$(basename "$archive").sha256"
    sha256sum "$(basename "$latest_archive")" >"$(basename "$latest_archive").sha256"
  )
else
  digest="$(shasum -a 256 "$archive" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$(basename "$archive")" >"$archive.sha256"
  printf '%s  %s\n' "$digest" "$(basename "$latest_archive")" >"$latest_archive.sha256"
fi

echo "$archive"
