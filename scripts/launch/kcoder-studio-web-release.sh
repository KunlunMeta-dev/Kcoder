#!/usr/bin/env bash

# Start the release Studio profile from the current checkout.
# By default, install and manage Web/Mobile services through systemd so they outlive
# the developer's terminal session. Use --direct or KCODER_STUDIO_INSTALL_SERVICES=false for local Electron.

set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -P "$script_dir/../.." && pwd)"
install_services="${KCODER_STUDIO_INSTALL_SERVICES:-true}"
case "$install_services" in
  true|1|yes) install_services=true ;;
  false|0|no) install_services=false ;;
  *)
    echo "Unsupported KCODER_STUDIO_INSTALL_SERVICES: $install_services (expected true or false)." >&2
    exit 2
    ;;
esac
if (($#)); then
  case "$1" in
    --managed)
      install_services=true
      shift
      ;;
    --direct)
      install_services=false
      shift
      ;;
  esac
fi

if [[ "$install_services" == true ]]; then
  exec "$script_dir/lib/kcoder-studio-web-start.sh" --profile release --install-services "$@"
fi

if [[ "${KCODER_STUDIO_SKIP_CLI_INSTALL:-0}" != 1 ]]; then
  "$script_dir/../install/installers/cli-release.sh"
fi
exec "$script_dir/kcoder-studio-electron.sh" --release "$@"
