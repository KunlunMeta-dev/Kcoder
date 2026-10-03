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
  echo "Usage: scripts/audit/audit_worktree_review_checklist.sh"
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

today="$(date +%F)"
maintainer="${MAINTAINER:-<maintainer>}"
review_map="AUDIT_REMEDIATION_REVIEW_MAP.md"
attention_paths=(
  "TOOLS.md"
  "site/index.html"
  ".kcoder/specs/changes"
)

echo "== KCoder worktree review checklist =="
echo
echo "This script prints path-level Git state for maintainer review."
echo "It does not read file contents and does not approve the worktree."
echo
echo "Context:"
echo "- repo: $repo_dir"
echo "- date: $today"
echo "- maintainer field: $maintainer"
echo "- branch: $(git branch --show-current 2>/dev/null || printf 'unknown')"
echo "- head: $(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
echo
echo "Current path-level Git state:"
status_output="$(git status --short --untracked-files=all)"
if [[ -z "$status_output" ]]; then
  echo "- clean"
else
  printf '%s\n' "$status_output" | sed 's/^/- /'
fi
echo
echo "Path state summary:"
if [[ -z "$status_output" ]]; then
  echo "- clean: 1"
else
  modified_count="$(printf '%s\n' "$status_output" | awk 'substr($0,1,2) !~ /^\?\?/ && substr($0,1,2) != " D" { count++ } END { print count + 0 }')"
  deleted_count="$(printf '%s\n' "$status_output" | awk 'substr($0,1,2) == " D" { count++ } END { print count + 0 }')"
  untracked_count="$(printf '%s\n' "$status_output" | awk 'substr($0,1,2) == "??" { count++ } END { print count + 0 }')"
  echo "- modified/tracked: $modified_count"
  echo "- deleted: $deleted_count"
  echo "- untracked: $untracked_count"
fi
echo
echo "Review map alignment:"
alignment_status=0
if [[ ! -r "$review_map" ]]; then
  echo "- FAIL: $review_map is not readable"
  alignment_status=1
else
  for path in "${attention_paths[@]}"; do
    if rg -q --fixed-strings "$path" "$review_map"; then
      echo "- OK: $review_map mentions $path"
    else
      echo "- FAIL: $review_map does not mention $path"
      alignment_status=1
    fi
  done
fi
if ((alignment_status == 0)); then
  echo "- OK: required attention paths are represented in the review map"
else
  echo "- FAIL: review map alignment needs maintainer attention"
fi
echo
echo "Maintainer decisions required:"
echo "- Confirm which listed files belong to the remediation work."
echo "- Confirm whether unrelated paths are accepted for release or moved out before release."
echo "- Pay specific attention to: TOOLS.md, site/index.html, and .kcoder/specs/changes/*."
echo "- Keep AUDIT_REMEDIATION_REVIEW_MAP.md aligned with the final decision."
echo "- Do not paste secrets into the signoff file."
echo "- Replace any angle-bracket values before copying evidence into the signoff file."
echo
echo "Recommended checks before signoff:"
echo "- git status --short --untracked-files=all"
echo "- scripts/audit/audit_release_check.sh"
echo "- scripts/audit/audit_manual_release_gate.sh"
echo
echo "Evidence line:"
echo "- Dirty worktree review: $today maintainer=$maintainer command=\"scripts/audit/audit_worktree_review_checklist.sh; git status --short --untracked-files=all\" observed=\"all listed paths reviewed; unrelated paths accepted or moved; release blockers recorded\""
