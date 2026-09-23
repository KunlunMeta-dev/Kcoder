#!/usr/bin/env bash
# Install the user-level kcoder-studio command without installing or enabling systemd services.

set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -P "$script_dir/../../.." && pwd)"
install_dir="${KCODER_STUDIO_INSTALL_DIR:-${HOME:?HOME is required}/.local/bin}"
launcher="$repo_dir/scripts/launch/kcoder-studio-electron.sh"
command_path="$install_dir/kcoder-studio"

[[ -x "$launcher" ]] || {
  echo "KCoder Studio launcher is missing or not executable: $launcher" >&2
  exit 1
}

mkdir -p "$install_dir"
if [[ -e "$command_path" && ! -L "$command_path" ]]; then
  echo "Refusing to replace existing non-symlink: $command_path" >&2
  exit 1
fi
ln -sfn "$launcher" "$command_path"

echo "Installed kcoder-studio -> $launcher"
case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH: export PATH=\"$install_dir:\$PATH\"" >&2 ;;
esac
