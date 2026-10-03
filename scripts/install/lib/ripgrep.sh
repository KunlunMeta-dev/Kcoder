#!/usr/bin/env bash

# ripgrep distribution: prefer an explicit or system rg, then download a binary
# matching official archive. The program retains its Rust fallback, so offline installation is not blocked.

KCODER_RIPGREP_VERSION="${KCODER_RIPGREP_VERSION:-15.1.0}"

kcoder_ripgrep_target() {
  local target="${1:-$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')}"
  case "$target" in
    x86_64-unknown-linux-gnu|x86_64-unknown-linux-musl) printf '%s\n' x86_64-unknown-linux-musl ;;
    aarch64-unknown-linux-gnu|aarch64-unknown-linux-musl) printf '%s\n' aarch64-unknown-linux-gnu ;;
    x86_64-apple-darwin) printf '%s\n' x86_64-apple-darwin ;;
    aarch64-apple-darwin) printf '%s\n' aarch64-apple-darwin ;;
    x86_64-pc-windows-msvc|x86_64-pc-windows-gnu) printf '%s\n' x86_64-pc-windows-msvc ;;
    i686-pc-windows-msvc) printf '%s\n' i686-pc-windows-msvc ;;
    aarch64-pc-windows-msvc) printf '%s\n' aarch64-pc-windows-msvc ;;
    *) return 1 ;;
  esac
}

kcoder_ripgrep_target_extension() {
  case "$1" in
    *-windows-*) printf '%s\n' zip ;;
    *) printf '%s\n' tar.gz ;;
  esac
}

kcoder_ripgrep_existing() {
  if [[ -n "${KCODER_RIPGREP_BIN:-}" && -x "$KCODER_RIPGREP_BIN" ]]; then
    printf '%s\n' "$KCODER_RIPGREP_BIN"
    return 0
  fi
  if command -v rg >/dev/null 2>&1; then
    command -v rg
    return 0
  fi
  return 1
}

kcoder_ripgrep_download() (
  set -euo pipefail
  local target="$1" destination="$2" extension filename url temp archive extracted
  extension="$(kcoder_ripgrep_target_extension "$target")"
  filename="ripgrep-${KCODER_RIPGREP_VERSION}-${target}.${extension}"
  url="https://github.com/BurntSushi/ripgrep/releases/download/${KCODER_RIPGREP_VERSION}/${filename}"
  temp="$(mktemp -d "${TMPDIR:-/tmp}/kcoder-ripgrep.XXXXXX")"
  archive="$temp/$filename"
  extracted="$temp/extracted"
  mkdir -p "$extracted"
  trap 'rm -rf "$temp"' EXIT

  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error "$url" --output "$archive"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$archive" "$url"
  else
    echo "Cannot download ripgrep: curl or wget is required ($url)" >&2
    return 1
  fi

  if [[ "$extension" == zip ]]; then
    command -v unzip >/dev/null 2>&1 || {
      echo "Cannot extract ripgrep zip: unzip is required." >&2
      return 1
    }
    unzip -q "$archive" -d "$extracted"
  else
    tar -xzf "$archive" -C "$extracted"
  fi

  local rg_name=rg
  [[ "$extension" == zip ]] && rg_name=rg.exe
  local source
  source="$(find "$extracted" -type f -name "$rg_name" -print -quit)"
  [[ -n "$source" && -f "$source" ]] || {
    echo "Downloaded ripgrep archive did not contain $rg_name: $url" >&2
    return 1
  }
  mkdir -p "$(dirname "$destination")"
  install -m 0755 "$source" "$destination"
  printf '%s\n' "$destination"
)

# Install rg into the target resource directory. Return 1 on failure and let the caller decide whether to continue with the Rust fallback.
kcoder_install_ripgrep() {
  local resource_dir="$1" target="${2:-$(kcoder_ripgrep_target)}" rg_target destination
  local rg_name=rg
  [[ "$target" == *-windows-* ]] && rg_name=rg.exe
  destination="$resource_dir/$rg_name"

  if [[ -x "$destination" ]]; then
    printf '%s\n' "$destination"
    return 0
  fi
  if rg_target="$(kcoder_ripgrep_target "$target")"; then
    if [[ -n "${KCODER_RIPGREP_BIN:-}" && -x "$KCODER_RIPGREP_BIN" ]]; then
      mkdir -p "$resource_dir"
      install -m 0755 "$KCODER_RIPGREP_BIN" "$destination"
      printf '%s\n' "$destination"
      return 0
    fi
    local host_target
    if host_target="$(kcoder_ripgrep_target 2>/dev/null)" && [[ "$rg_target" == "$host_target" ]]; then
      if existing="$(kcoder_ripgrep_existing 2>/dev/null)"; then
        mkdir -p "$resource_dir"
        install -m 0755 "$existing" "$destination"
        printf '%s\n' "$destination"
        return 0
      fi
    fi
    if [[ "${KCODER_SKIP_RIPGREP_DOWNLOAD:-0}" == 1 ]]; then
      return 1
    fi
    kcoder_ripgrep_download "$rg_target" "$destination"
    return
  fi
  echo "No ripgrep distribution mapping for Rust target: $target" >&2
  return 1
}
