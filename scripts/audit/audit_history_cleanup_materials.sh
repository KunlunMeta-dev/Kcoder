#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
repo_dir="$(cd "$script_dir/../.." && pwd -P)"

secret_regex='sk-cp-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}'

usage() {
  echo "Usage: scripts/audit/audit_history_cleanup_materials.sh [--check] [/absolute/output/path]"
}

check_mode=0
if [[ "${1:-}" == "--check" ]]; then
  check_mode=1
  shift
fi

if (($# > 1)); then
  usage
  exit 2
fi

if ((check_mode != 0 && $# > 0)); then
  usage
  exit 2
fi

output_path="${1:-/tmp/kcoder-api-key-replacements.txt}"

if [[ "$output_path" == "-h" || "$output_path" == "--help" ]]; then
  usage
  exit 0
fi

if ((check_mode != 0)); then
  output_path="$(mktemp /tmp/kcoder-api-key-replacements.XXXXXX)"
  rm -f "$output_path"
fi

if [[ "$output_path" != /* ]]; then
  echo "FAIL: output path must be absolute and outside this repository."
  exit 1
fi

case "$output_path" in
  "$repo_dir"|"$repo_dir"/*)
    echo "FAIL: output path must be outside this repository."
    exit 1
    ;;
esac

parent_dir="${output_path%/*}"
if [[ "$parent_dir" == "$output_path" || ! -d "$parent_dir" ]]; then
  echo "FAIL: output directory does not exist: $parent_dir"
  exit 1
fi

cat >"$output_path" <<'RULES'
regex:sk-cp-[A-Za-z0-9_-]{20,}==><redacted-api-key>
regex:sk-[A-Za-z0-9_-]{32,}==><redacted-api-key>
RULES
chmod 600 "$output_path"

if rg --pcre2 -q "$secret_regex" "$output_path"; then
  echo "FAIL: generated replacement file unexpectedly contains an API key pattern."
  if ((check_mode != 0)); then
    rm -f "$output_path"
  fi
  exit 1
fi

if ((check_mode != 0)); then
  rm -f "$output_path"
  echo "OK: history cleanup replacement rules generator works without exposing API keys."
  exit 0
fi

echo "OK: wrote git-filter-repo replacement rules to $output_path"
echo "Next: after key revocation, push freeze, backup, and clean worktree, run:"
echo "  git filter-repo --replace-text $output_path --force"
