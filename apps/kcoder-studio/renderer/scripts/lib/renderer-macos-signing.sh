#!/usr/bin/env bash

# Shared macOS code-signing helpers for Wework build scripts.

wework_resolve_developer_id_application_identity() {
  local identity="${1:-}"
  if [ -n "$identity" ]; then
    printf '%s\n' "$identity"
    return 0
  fi

  security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' \
    | head -n 1
}

