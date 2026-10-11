#!/usr/bin/env bash

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_dir/scripts/install/lib/ripgrep.sh"
version="${1:-$(sed -n 's/^version = "\([^"]*\)"/\1/p' "$repo_dir/Cargo.toml" | head -1)}"
target="${2:-$(rustc -vV | sed -n 's/^host: //p')}"
binary="${KCODER_RELEASE_BIN:-$repo_dir/target/$target/release/kcoder}"
out_dir="${KCODER_RELEASE_OUT:-$repo_dir/target/dist}"

if [[ ! -x "$binary" && "$target" == "$(rustc -vV | sed -n 's/^host: //p')" ]]; then
  binary="$repo_dir/target/release/kcoder"
fi
[[ -x "$binary" ]] || {
  echo "Release binary not found: $binary" >&2
  exit 1
}

mkdir -p "$out_dir"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
install -m 0755 "$binary" "$stage/kcoder"
mkdir -p "$stage/lib/kcoder"
if ! kcoder_install_ripgrep "$stage/lib/kcoder" "$target" >/dev/null; then
  echo "Warning: ripgrep was not bundled for $target; the Rust search fallback remains available." >&2
fi

node "$repo_dir/scripts/release/artifact-manifest.mjs" --stage "$stage" cli "$target"
archive="$out_dir/kcoder-$version-$target.tar.gz"
tar -czf "$archive" -C "$stage" kcoder lib kcoder-release-manifest.json
latest_archive="$out_dir/kcoder-$target.tar.gz"
cp "$archive" "$latest_archive"
if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$out_dir"
    sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256"
    sha256sum "$(basename "$latest_archive")" > "$(basename "$latest_archive").sha256"
  )
else
  digest="$(shasum -a 256 "$archive" | awk '{print $1}')"
  printf '%s  %s\n' "$digest" "$(basename "$archive")" > "$archive.sha256"
  printf '%s  %s\n' "$digest" "$(basename "$latest_archive")" > "$latest_archive.sha256"
fi

echo "$archive"
