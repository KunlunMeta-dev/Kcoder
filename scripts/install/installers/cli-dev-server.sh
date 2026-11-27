#!/usr/bin/env bash
# Install the current checkout with the debug profile, isolating its command and user directory from the release profile.

set -euo pipefail

script_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KCODER_SERVER_PROFILE=dev \
KCODER_SERVER_BUILD_PROFILE=debug \
  exec "$script_dir/cli-release-server.sh" "$@"
