#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../../.." && pwd)"
for argument in "$@"; do
  if [[ "$argument" == app-server ]]; then sleep 12; break; fi
done
exec "$repo/target/debug/kcoder" "$@"
