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
  echo "Usage: scripts/audit/audit_history_cleanup_runbook.sh"
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

echo "== Git history cleanup runbook =="
echo
echo "This script is non-destructive. It prints a reviewed cleanup sequence but does not rewrite history."
echo "Do not paste or record the leaked key value."
echo

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
echo "== Current blockers to clear before running destructive cleanup =="
if [[ -n "$(git status --short)" ]]; then
  echo "- Work tree is not clean. Commit, stash outside this repository, or move unrelated changes first."
else
  echo "- Work tree is clean."
fi

if command -v git-filter-repo >/dev/null 2>&1; then
  echo "- git-filter-repo is available."
else
  echo "- git-filter-repo is not available on PATH."
fi

remote_names=()
while IFS= read -r remote; do
  remote_names+=("$remote")
done < <(git remote)
if ((${#remote_names[@]} == 0)); then
  echo "- No Git remotes are configured."
else
  echo "- Git remotes: ${remote_names[*]}"
fi

echo
echo "== Current history matches =="
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
  echo "OK: no API key pattern found in local refs, remote-tracking refs, or reflog."
  exit 0
fi

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

echo
echo "== Destructive cleanup sequence for maintainers =="
cat <<'EOF'
1. Confirm in the MiniMax console that every exposed key is revoked.
2. Coordinate a push freeze with every collaborator.
3. Create a backup outside this repository, for example:
   git clone --mirror <repo-url> /safe/backup/KCoder.git
4. Start from a clean work tree and make sure git-filter-repo is installed.
5. Create a replacement rules file outside the repository:
   scripts/audit/audit_history_cleanup_materials.sh /tmp/kcoder-api-key-replacements.txt
6. Rewrite local history:
   git filter-repo --replace-text /tmp/kcoder-api-key-replacements.txt --force
7. Remove local reflog/object traces after rewrite:
   git reflog expire --expire=now --all
   git gc --prune=now --aggressive
8. Re-run:
   scripts/audit/audit_release_check.sh
   scripts/audit/audit_manual_release_gate.sh
9. If the rewritten history is correct, update remotes with maintainer approval:
   git push --force-with-lease --all origin
   git push --force-with-lease --tags origin
10. Require collaborators to re-clone or hard reset from the rewritten remote.
EOF
