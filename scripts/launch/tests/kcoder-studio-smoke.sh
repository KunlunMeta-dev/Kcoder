#!/usr/bin/env bash
# KCoder Studio local Electron startup smoke test: check entry-point isolation and verify gateway start/stop.

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
wrapper="$repo_dir/scripts/launch/kcoder-studio-electron.sh"

bash -n \
  "$wrapper" \
  "$repo_dir/scripts/launch/kcoder-studio-web-dev.sh" \
  "$repo_dir/scripts/launch/kcoder-studio-web-release.sh" \
  "$repo_dir/scripts/install/installers/studio-client.sh"

help_output="$($wrapper --help)"
grep -Fq 'kcoder-studio [--dev|--release]' <<<"$help_output"
grep -Fq '启动匹配的 app-server' <<<"$help_output"
grep -Fq 'KCODER_STUDIO_KCODER_BIN' "$wrapper"
grep -Fq 'KCODER_HOME' "$wrapper"
grep -Fq 'workspaceAppServerBrokers' "$repo_dir/apps/kcoder-studio/dev-server.mjs"
grep -Fq 'terminateAppServerChild' "$repo_dir/apps/kcoder-studio/dev-server.mjs"

node --test "$repo_dir/apps/kcoder-studio/desktop/gateway-process.test.mjs"

if command -v xvfb-run >/dev/null 2>&1 && [[ -x "$repo_dir/apps/kcoder-studio/node_modules/.bin/electron" ]]; then
  smoke_home="$(mktemp -d "${TMPDIR:-/tmp}/kcoder-studio-smoke.XXXXXX")"
  trap 'rm -rf "$smoke_home"' EXIT
  KCODER_STUDIO_DESKTOP_SMOKE_MS=1000 \
    KCODER_STUDIO_KCODER_BIN=/bin/true \
    KCODER_STUDIO_KCODER_HOME="$smoke_home" \
    timeout 30s xvfb-run -a "$wrapper" --release --no-sandbox --disable-gpu
else
  echo "kcoder-studio Electron smoke skipped: xvfb-run or Electron dependency is unavailable."
fi

echo "kcoder-studio local Electron smoke: ok"
