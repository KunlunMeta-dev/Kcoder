#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
repo_dir="$(cd "$script_dir/../.." && pwd -P)"
cd "$repo_dir"

secret_regex='sk-cp-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}'
replacement='<redacted-api-key>'

targets=("$@")
if ((${#targets[@]} == 0)); then
  shopt -s nullglob
  targets=(.env .env.*)
  shopt -u nullglob
fi

if ((${#targets[@]} == 0)); then
  echo "OK: no local env files found."
  exit 0
fi

status=0
changed=0

for path in "${targets[@]}"; do
  if [[ "$(basename "$path")" == ".env.example" ]]; then
    continue
  fi
  if [[ ! -e "$path" ]]; then
    echo "WARN: local env file not found: $path"
    continue
  fi
  if [[ ! -f "$path" ]]; then
    echo "WARN: skipping non-file target: $path"
    continue
  fi
  if [[ ! -r "$path" || ! -w "$path" ]]; then
    echo "FAIL: local env file is not readable and writable: $path"
    status=1
    continue
  fi

  before_count="$( (rg --pcre2 -o "$secret_regex" "$path" 2>/dev/null || true) | wc -l | tr -d '[:space:]')"
  if [[ "$before_count" == "0" ]]; then
    echo "OK: no API key pattern found in $path"
    continue
  fi

  perl -0pi -e "s/$secret_regex/$replacement/g" -- "$path"

  after_count="$( (rg --pcre2 -o "$secret_regex" "$path" 2>/dev/null || true) | wc -l | tr -d '[:space:]')"
  if [[ "$after_count" != "0" ]]; then
    echo "FAIL: API key pattern remains in $path"
    status=1
  else
    echo "OK: redacted $before_count API key pattern(s) in $path"
    changed=1
  fi
done

if ((status == 0 && changed == 0)); then
  echo "OK: no local env redaction needed."
fi

exit "$status"
