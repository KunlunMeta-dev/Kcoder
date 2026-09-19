#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
repo_dir="$(cd "$script_dir/../.." && pwd -P)"
cd "$repo_dir"

usage() {
  echo "Usage: scripts/audit/audit_release_check.sh"
}

if (($# > 0)); then
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "FAIL: unknown argument: $1"
      usage
      exit 2
      ;;
  esac
fi

secret_regex='sk-cp-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}'
status=0

echo "== Release audit prerequisites =="
missing_tool=0
for tool in git rg; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "OK: $tool is available."
  else
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
  if ((rg_status == 1)); then
    echo "OK: rg PCRE2 support is available."
  else
    echo "FAIL: rg --pcre2 is not usable in this environment."
    exit 1
  fi
fi

echo

echo "== Working tree secret scan =="
worktree_hits=()
worktree_scan_output="$(mktemp)"
trap 'rm -f "$worktree_scan_output"' EXIT
if rg \
  --hidden \
  --no-ignore \
  --pcre2 \
  -l "$secret_regex" \
  --glob '!.git/**' \
  --glob '!target/**' \
  --glob '!node_modules/**' \
  --glob '!.venv/**' \
  --glob '!dist/**' \
  --glob '!build/**' \
  --glob '!Cargo.lock' \
  . >"$worktree_scan_output"; then
  rg_status=0
else
  rg_status=$?
fi

while IFS= read -r path; do
  worktree_hits+=("$path")
done < "$worktree_scan_output"

if ((rg_status != 0 && rg_status != 1)); then
  echo "FAIL: working tree secret scan failed."
  exit 1
fi

if ((${#worktree_hits[@]} > 0)); then
  echo "FAIL: potential API key found in the working tree."
  echo "Matching files:"
  printf '  %s\n' "${worktree_hits[@]}"
  echo "Sanitize local env files with scripts/audit/audit_sanitize_local_env.sh; rotate any key that may have been exposed."
  status=1
else
  echo "OK: no working tree API key match."
fi

echo
echo "== Git history API key scan =="
history_hits=()
history_commits=()
declare -A seen_history_hits=()
declare -A seen_history_commits=()
while IFS= read -r rev; do
  while IFS= read -r match; do
    path="${match#"$rev:"}"
    hit="${rev:0:7}:$path"
    if [[ -z "${seen_history_hits[$hit]+x}" ]]; then
      seen_history_hits[$hit]=1
      history_hits+=("$hit")
    fi
    if [[ -z "${seen_history_commits[$rev]+x}" ]]; then
      seen_history_commits[$rev]=1
      history_commits+=("$rev")
    fi
  done < <(git grep -I -E -l "$secret_regex" "$rev" -- . 2>/dev/null || true)
done < <(git rev-list --all --reflog)

if ((${#history_hits[@]} > 0)); then
  echo "FAIL: API key pattern is still present in local Git history."
  echo "Scanned all local refs, remote-tracking refs, and local reflog entries."
  printf '  %s\n' "${history_hits[@]}"
  echo
  echo "Refs containing matching commits:"
  for commit in "${history_commits[@]}"; do
    refs_joined=""
    while IFS= read -r ref; do
      if [[ -z "$refs_joined" ]]; then
        refs_joined="$ref"
      else
        refs_joined="$refs_joined, $ref"
      fi
    done < <(git for-each-ref --contains "$commit" --format='%(refname:short)')
    if [[ -z "$refs_joined" ]]; then
      refs_joined="<no named ref contains this commit>"
    fi
    echo "  ${commit:0:7}: $refs_joined"
  done
  echo "Clean history before release, or confirm these commits never reached a remote."
  echo "Generate a non-destructive cleanup runbook with scripts/audit/audit_history_cleanup_runbook.sh."
  status=1
else
  echo "OK: no API key pattern found in local Git history."
fi

echo
echo "== Git unreachable object API key scan =="
if scripts/audit/audit_git_unreachable_secret_scan.sh; then
  :
else
  status=1
fi

exit "$status"
