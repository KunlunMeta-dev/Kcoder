#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
default_repo_dir="$(cd "$script_dir/../.." && pwd -P)"

mode="full"
if [[ "${1:-}" == "--summary" ]]; then
  mode="summary"
  shift
fi

if (($# > 1)); then
  echo "Usage: scripts/audit/audit_git_unreachable_secret_scan.sh [--summary] [repo]"
  exit 2
fi

repo_dir="${1:-$default_repo_dir}"
secret_regex='sk-cp-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}'

if ! cd "$repo_dir" 2>/dev/null; then
  echo "FAIL: repository path is not accessible."
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: not inside a Git work tree."
  exit 1
fi

missing_tool=0
for tool in git rg; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: required tool is missing: $tool"
    missing_tool=1
  fi
done
if ((missing_tool != 0)); then
  exit 1
fi

if printf 'no-secret-here\n' | rg --pcre2 "$secret_regex" - >/dev/null 2>&1; then
  :
else
  rg_status=$?
  if ((rg_status != 1)); then
    echo "FAIL: rg --pcre2 is not usable in this environment."
    exit 1
  fi
fi

hits=()
declare -A seen_hits=()

record_hit() {
  local hit="$1"
  if [[ -z "${seen_hits[$hit]+x}" ]]; then
    seen_hits[$hit]=1
    hits+=("$hit")
  fi
}

scan_object_payload() {
  local type="$1"
  local sha="$2"
  if git cat-file -p "$sha" 2>/dev/null | rg --pcre2 -q "$secret_regex" -; then
    record_hit "$type:${sha:0:12}"
  fi
}

while IFS= read -r line; do
  read -r marker type sha _ <<<"$line"
  case "$marker" in
    unreachable|dangling) ;;
    *) continue ;;
  esac
  if [[ -z "${type:-}" || -z "${sha:-}" ]]; then
    continue
  fi

  case "$type" in
    commit|tree)
      while IFS= read -r match; do
        path="${match#"$sha:"}"
        record_hit "$type:${sha:0:12}:$path"
      done < <(git grep -I -E -l "$secret_regex" "$sha" -- . 2>/dev/null || true)
      ;;
    blob|tag)
      scan_object_payload "$type" "$sha"
      ;;
    *)
      scan_object_payload "$type" "$sha"
      ;;
  esac
done < <(git fsck --unreachable --no-reflogs --no-progress 2>/dev/null || true)

if ((${#hits[@]} > 0)); then
  if [[ "$mode" == "summary" ]]; then
    echo "FAIL: unreachable Git objects contain API key pattern in ${#hits[@]} object/path record(s)."
  else
    echo "FAIL: unreachable Git objects contain API key pattern."
    echo "Scanned unreachable and dangling Git objects without printing object contents."
    printf '  %s\n' "${hits[@]}"
  fi
  exit 1
fi

if [[ "$mode" == "summary" ]]; then
  echo "OK: unreachable Git object secret scan has no API key pattern matches."
else
  echo "OK: no API key pattern found in unreachable Git objects."
fi
