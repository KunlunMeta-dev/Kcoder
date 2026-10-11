#!/usr/bin/env bash
# Install the current checkout for this server only.
#
# This deliberately does not share behavior with scripts/install/installers/cli-release.sh, which is
# the user-local checkout release installer. On this server the historical Go
# This system-wide installer builds once as root and updates only the root/system
# entry for the current Rust version.

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cargo_bin="${KCODER_SERVER_CARGO_BIN:-cargo}"
target_dir="${KCODER_SERVER_TARGET_DIR:-$repo_dir/target}"
env_file="${KCODER_SERVER_ENV_FILE:-$repo_dir/.env}"
development_settings="$repo_dir/crates/kcoder_config/setting_dev_user.jsonc"
kunlunmeta_base_url="${KCODER_SERVER_KUNLUNMETA_BASE_URL:-http://127.0.0.1:8000}"
source "$repo_dir/scripts/install/lib/ripgrep.sh"

current_user="$(id -un)"
if [[ "$(id -u)" -ne 0 && "${KCODER_SERVER_TEST_ALLOW_NON_ROOT:-0}" != 1 ]]; then
  echo "This server installer must run as root, not $current_user." >&2
  echo "Open a root shell and run the selected server installer." >&2
  exit 1
fi
root_home="${KCODER_SERVER_ROOT_HOME:-/root}"
if [[ "$root_home" != /* ]]; then
  echo "Root profile home must be an absolute path: $root_home" >&2
  exit 1
fi

# Wrapper scripts select a profile explicitly. Retain BUILD_PROFILE overrides for
# diagnostics, but command names, build artifacts, and configuration directories must
# use the same profile so a debug build cannot overwrite the production command.
server_profile="${KCODER_SERVER_PROFILE:-}"
if [[ -z "$server_profile" ]]; then
  if [[ "${KCODER_SERVER_BUILD_PROFILE:-release}" == "debug" ]]; then
    server_profile=dev
  else
    server_profile=release
  fi
fi
case "$server_profile" in
  dev)
    command_name=kcoder-dev
    default_build_profile=debug
    default_root_config_dir="$root_home/.config/kcoder-dev"
    import_development=1
    ;;
  release)
    command_name=kcoder
    default_build_profile=release
    default_root_config_dir="$root_home/.config/kcoder"
    import_development=0
    ;;
  *)
    echo "Unsupported server profile: $server_profile (expected dev or release)" >&2
    exit 1
    ;;
esac

root_command="${KCODER_SERVER_ROOT_COMMAND:-/usr/local/bin/$command_name}"
build_profile="${KCODER_SERVER_BUILD_PROFILE:-$default_build_profile}"
root_config_dir="${KCODER_SERVER_ROOT_CONFIG_DIR:-$default_root_config_dir}"
root_prefix="$(cd -P "$(dirname "$root_command")/.." && pwd)"
root_ripgrep_dir="${KCODER_SERVER_ROOT_RIPGREP_DIR:-$root_prefix/lib/kcoder}"
root_command_dir="$(dirname "$root_command")"
retired_family=kunlun
retired_stem="${retired_family}code"
retired_root_commands=(
  "$root_command_dir/$retired_family"
  "$root_command_dir/$retired_stem"
  "$root_command_dir/$retired_stem-dev"
)

canonical_contract_path() {
  realpath -m -- "$1"
}

if [[ "$server_profile" == dev ]]; then
  command -v realpath >/dev/null 2>&1 || {
    echo "realpath is required to validate development profile isolation." >&2
    exit 1
  }
  config_paths_overlap() {
    local left="$1" right="$2"
    [[ "$left" == "$right" || "$left" == "$right/"* || "$right" == "$left/"* ]]
  }
  # Development installation replaces settings.json, so reject path overlap with the
  # production profile before any build or write. realpath -m collapses both .. in missing paths and existing symlinks.
  release_root_config_dir="$(canonical_contract_path "$root_home/.config/kcoder")"
  canonical_root_config_dir="$(canonical_contract_path "$root_config_dir")"

  if config_paths_overlap "$canonical_root_config_dir" "$release_root_config_dir"; then
    echo "Development config directory conflicts with a release profile: $release_root_config_dir" >&2
    exit 1
  fi
fi

if [[ "$build_profile" != "$default_build_profile" ]]; then
  echo "Server profile $server_profile requires the $default_build_profile build; got $build_profile." >&2
  echo "Choose the matching server installer instead of mixing profiles." >&2
  exit 1
fi

if [[ "$target_dir" != /* ]]; then
  target_dir="$repo_dir/$target_dir"
fi
case "$build_profile" in
  debug)
    build_args=(build --locked)
    ;;
  release)
    build_args=(build --release --locked)
    ;;
  *)
    echo "Unsupported server build profile: $build_profile" >&2
    exit 1
    ;;
esac
built_binary="$target_dir/$build_profile/kcoder"

if [[ "$(basename "$root_command")" != "$command_name" ]]; then
  echo "Root command must be named $command_name: $root_command" >&2
  exit 1
fi
command -v "$cargo_bin" >/dev/null 2>&1 || {
  echo "cargo is required to install KCoder from source." >&2
  exit 1
}

run_profile_command() {
  local profile_home="$1" config_dir="$2" binary="$3"
  shift 3
  env HOME="$profile_home" KCODER_HOME="$config_dir" KCODER_CONFIG_DIR="$config_dir" \
    "$binary" "$@"
}

version_probe_root=""
cleanup_version_probe() {
  if [[ -n "$version_probe_root" && -d "$version_probe_root" ]]; then
    rm -rf -- "$version_probe_root"
  fi
}

prepare_version_probe() {
  version_probe_root="$(mktemp -d "${TMPDIR:-/tmp}/kcoder-version-check.XXXXXX")"
  trap cleanup_version_probe EXIT
}

echo "Building the current checkout with Cargo fingerprint reuse..."
(
  cd "$repo_dir"
  CARGO_TARGET_DIR="$target_dir" "$cargo_bin" "${build_args[@]}"
)
[[ -x "$built_binary" ]] || {
  echo "$build_profile build did not produce $built_binary" >&2
  exit 1
}
echo "Built $build_profile binary: $built_binary"

# The current CLI short-circuits `--version` before configuration initialization.
# The version probe still uses a disposable isolated profile as defense in depth,
# ensuring installation validation can never become an implicit write to the production root profile.
prepare_version_probe

mkdir -p "$(dirname "$root_command")"
# Remove any symlink at the destination first: `install` would otherwise
# follow it and overwrite the link target.
if [[ -L "$root_command" ]]; then
  rm -f "$root_command"
fi
install -m 0755 "$built_binary" "$root_command"
echo "Installed root command: $root_command"

# The compatibility window has ended. Installing either profile removes all retired
# entry points in the command directory so old remnants or reinstalls cannot restore retired commands.
for retired_command in "${retired_root_commands[@]}"; do
  if [[ -d "$retired_command" && ! -L "$retired_command" ]]; then
    echo "Refusing to replace a retired command directory in $root_command_dir" >&2
    exit 1
  fi
  if [[ -e "$retired_command" || -L "$retired_command" ]]; then
    rm -f -- "$retired_command"
    echo "Removed a retired command entry from $root_command_dir"
  fi
done
run_profile_command "$root_home" "$version_probe_root" "$root_command" --version
cleanup_version_probe
trap - EXIT

mkdir -p "$root_ripgrep_dir"
if root_ripgrep_path="$(kcoder_install_ripgrep "$root_ripgrep_dir" "${KCODER_RIPGREP_TARGET:-$(rustc -vV | sed -n 's/^host: //p')}")"; then
  echo "Installed bundled ripgrep for root: $root_ripgrep_dir/$(basename "$root_ripgrep_path")"
else
  echo "ripgrep resource was not installed for root; KCoder will use its Rust search fallback." >&2
fi

if [[ "$server_profile" == release && "${KCODER_SKIP_CHROME_DOWNLOAD:-0}" != 1 ]]; then
  chrome_args=(--platform linux64 --dest "$root_prefix/lib/kcoder/chrome")
  [[ -z "${KCODER_CHROME_CACHE:-}" ]] || chrome_args+=(--cache "$KCODER_CHROME_CACHE")
  [[ -z "${KCODER_CHROME_ARCHIVE_LINUX64:-}" ]] || chrome_args+=(--archive "$KCODER_CHROME_ARCHIVE_LINUX64")
  if [[ "$(uname -m)" == x86_64 ]] && command -v node >/dev/null 2>&1 && \
    node "$repo_dir/scripts/release/prepare-chrome.mjs" "${chrome_args[@]}"; then
    echo "Prepared bundled Google Chrome for Testing: $root_prefix/lib/kcoder/chrome"
  else
    echo "Bundled Chrome was not prepared; browser dependencies remain incomplete. Retry prepare-chrome.mjs with a verified archive." >&2
  fi
else
  echo "Bundled Chrome preparation skipped for development or explicit offline installation; browser dependencies may remain incomplete."
fi

env_has_key() {
  local pattern="$1"
  [[ -f "$env_file" ]] &&
    grep -Eq "^[[:space:]]*(export[[:space:]]+)?($pattern)[[:space:]]*=" "$env_file"
}

install_source_dotenv() {
  local config_dir="$1"
  if [[ ! -f "$env_file" || -e "$config_dir/.env" ]]; then
    return
  fi
  mkdir -p "$config_dir"
  install -m 0600 "$env_file" "$config_dir/.env"
}

import_root_provider() {
  local provider="$1"
  run_profile_command "$root_home" "$root_config_dir" "$root_command" \
    auth login --provider "$provider" --env-file "$env_file"
}

import_development_settings() {
  # Development settings are the sole source for the development profile. Remove only
  # that profile's user layer; retain credentials in the isolated directory and refresh them from repository dotenv below.
  rm -f "$root_config_dir/settings.json"
  run_profile_command "$root_home" "$root_config_dir" "$root_command" \
    config migrate >/dev/null
  run_profile_command "$root_home" "$root_config_dir" "$root_command" \
    config import --scope user --file "$development_settings" >/dev/null

  # An old import expanded the selected provider into top-level runtime fields.
  # Continue calibrating these high-priority fields so they cannot hide the current server provider endpoint.
  run_profile_command "$root_home" "$root_config_dir" "$root_command" \
    config set --scope user providers.kunlunmeta.endpoint "$kunlunmeta_base_url" >/dev/null
  run_profile_command "$root_home" "$root_config_dir" "$root_command" \
    config set --scope user providers.kunlunmeta.no_proxy true >/dev/null
  run_profile_command "$root_home" "$root_config_dir" "$root_command" \
    config set --scope user base_url "$kunlunmeta_base_url" >/dev/null
  run_profile_command "$root_home" "$root_config_dir" "$root_command" \
    config set --scope user provider_no_proxy true >/dev/null
}

if [[ "$import_development" == 1 ]]; then
  install_source_dotenv "$root_config_dir"
  import_development_settings
  echo "Imported development settings into isolated $root_config_dir."

  if [[ -f "$env_file" ]]; then
    if env_has_key 'KUNLUNMETA_BASE_API_KEY'; then
      import_root_provider kunlunmeta
    fi
    echo "Imported repository KunlunMeta credential for root from: $env_file"
  else
    echo "Repository .env not found; credential import skipped: $env_file" >&2
  fi
else
  echo "Release profile selected; development settings and repository credentials were not imported."
fi

echo "Root command installed: $root_command"
