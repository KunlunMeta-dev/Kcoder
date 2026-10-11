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
  echo "Usage: scripts/audit/audit_history_cleanup_preflight.sh"
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

echo "== Git history cleanup preflight =="

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "FAIL: not inside a Git work tree."
  exit 1
fi

current_branch="$(git branch --show-current || true)"
if [[ -n "$current_branch" ]]; then
  echo "Current branch: $current_branch"
else
  echo "Current branch: <detached HEAD>"
fi

echo
echo "== Work tree state =="
if [[ -n "$(git status --short)" ]]; then
  echo "FAIL: work tree is not clean. Save, commit, or move unrelated changes before history cleanup."
  status=1
else
  echo "OK: work tree is clean."
fi

echo
echo "== Required tool =="
if command -v git-filter-repo >/dev/null 2>&1; then
  echo "OK: git-filter-repo is available."
else
  echo "FAIL: git-filter-repo is not available on PATH."
  echo "Install it before cleaning history, or use an equivalent reviewed history-cleanup tool."
  status=1
fi

echo
echo "== Remote refs =="
remote_names=()
while IFS= read -r remote; do
  remote_names+=("$remote")
done < <(git remote)

if ((${#remote_names[@]} == 0)); then
  echo "WARN: no remotes configured."
else
  printf '  %s\n' "${remote_names[@]}"
fi

echo
echo "== History matches =="
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

if ((${#history_hits[@]} == 0)); then
  echo "OK: no API key pattern found in local Git history."
else
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
  status=1
fi

echo
echo "== Unreachable object matches =="
if scripts/audit/audit_git_unreachable_secret_scan.sh; then
  :
else
  status=1
fi

echo
echo "== Before destructive cleanup =="
echo "Required maintainer actions:"
echo "  1. Confirm the leaked MiniMax key is revoked."
echo "  2. Coordinate a push freeze with all collaborators."
echo "  3. Create an out-of-repo backup of this repository."
echo "  4. Record the current refs above in the manual signoff evidence."
echo "  5. Create replacement rules with scripts/audit/audit_history_cleanup_materials.sh outside this repository."
echo "  6. Review scripts/audit/audit_history_cleanup_runbook.sh before running destructive history cleanup."
echo "  7. After cleanup, rerun scripts/audit/audit_release_check.sh and scripts/audit/audit_manual_release_gate.sh."

if ((status == 0)); then
  echo
  echo "OK: cleanup preflight passed."
else
  echo
  echo "FAIL: cleanup preflight found blockers."
fi

exit "$status"
