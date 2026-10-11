#!/usr/bin/env bash

set -euo pipefail

install_dir="${KCODER_INSTALL_DIR:-${HOME:?HOME is required}/.local/bin}"
binary="$install_dir/kcoder"
retired_family=kunlun
retired_stem="${retired_family}code"
legacy_family_binary="$install_dir/$retired_family"
legacy_binary="$install_dir/$retired_stem"
system_install_dir="${KCODER_SYSTEM_INSTALL_DIR:-/usr/local/bin}"
system_binary="$system_install_dir/kcoder"
legacy_system_binary="$system_install_dir/$retired_stem"
legacy_family_system_binary="$system_install_dir/$retired_family"
resource="$(dirname "$install_dir")/lib/kcoder/rg"
system_resource="$(dirname "$system_install_dir")/lib/kcoder/rg"
skip_system_install="${KCODER_SKIP_SYSTEM_INSTALL:-false}"
removed=0

if [[ -e "$binary" || -L "$binary" ]]; then
  rm -f "$binary"
  echo "Removed $binary"
  removed=1
fi
if [[ -e "$legacy_binary" || -L "$legacy_binary" ]]; then
  rm -f "$legacy_binary"
  echo "Removed a retired command entry"
  removed=1
fi
if [[ -e "$legacy_family_binary" || -L "$legacy_family_binary" ]]; then
  rm -f "$legacy_family_binary"
  echo "Removed a retired command entry"
  removed=1
fi
if [[ -e "$resource" || -L "$resource" ]]; then
  rm -f "$resource"
  echo "Removed $resource"
  removed=1
fi
if [[ "$skip_system_install" != "true" && "$legacy_system_binary" != "$legacy_binary" && ( -e "$legacy_system_binary" || -L "$legacy_system_binary" ) ]]; then
  if ((EUID == 0)); then
    rm -f "$legacy_system_binary"
  elif command -v sudo >/dev/null 2>&1; then
    sudo rm -f "$legacy_system_binary"
  else
    echo "sudo is unavailable; could not remove a retired system command." >&2
    exit 1
  fi
  echo "Removed a retired system command entry"
  removed=1
fi
if [[ "$skip_system_install" != "true" && "$legacy_family_system_binary" != "$legacy_family_binary" && ( -e "$legacy_family_system_binary" || -L "$legacy_family_system_binary" ) ]]; then
  if ((EUID == 0)); then
    rm -f "$legacy_family_system_binary"
  elif command -v sudo >/dev/null 2>&1; then
    sudo rm -f "$legacy_family_system_binary"
  else
    echo "sudo is unavailable; could not remove a retired system command." >&2
    exit 1
  fi
  echo "Removed a retired system command entry"
  removed=1
fi

if [[ "$skip_system_install" != "true" && "$system_binary" != "$binary" && ( -e "$system_binary" || -L "$system_binary" ) ]]; then
  if ((EUID == 0)); then
    rm -f "$system_binary"
  elif command -v sudo >/dev/null 2>&1; then
    echo "Removing system-wide KCoder with sudo..." >&2
    sudo rm -f "$system_binary"
  else
    echo "sudo is unavailable; could not remove $system_binary." >&2
    exit 1
  fi
  echo "Removed $system_binary"
  removed=1
fi
if [[ "$skip_system_install" != "true" && "$system_resource" != "$resource" && ( -e "$system_resource" || -L "$system_resource" ) ]]; then
  if ((EUID == 0)); then
    rm -f "$system_resource"
  elif command -v sudo >/dev/null 2>&1; then
    echo "Removing system-wide ripgrep resource with sudo..." >&2
    sudo rm -f "$system_resource"
  else
    echo "sudo is unavailable; could not remove $system_resource." >&2
    exit 1
  fi
  echo "Removed $system_resource"
  removed=1
fi

if (( ! removed )); then
  echo "KCoder is not installed at $binary or $system_binary"
  exit 0
fi

echo "User settings and history were kept. Remove them separately if no longer needed."
