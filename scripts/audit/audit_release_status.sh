#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
repo_dir="$(cd "$script_dir/../.." && pwd -P)"
cd "$repo_dir"

status=0
mode="${1:-full}"
secret_regex='sk-cp-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}'
required_signoffs=(
  MINIMAX_KEY_ROTATED
  GIT_HISTORY_CLEANED
  CI_DEPLOY_SECRETS_UPDATED
  TUI_PANIC_RECOVERY_OK
  TUI_SIGTERM_RECOVERY_OK
  TUI_HIGH_SPEED_STREAM_OK
  TUI_UNICODE_EDIT_OK
  DIRTY_WORKTREE_REVIEWED
)

usage() {
  echo "Usage: scripts/audit/audit_release_status.sh [--summary]"
}

current_branch() {
  if command -v git >/dev/null 2>&1; then
    git branch --show-current 2>/dev/null || printf 'unknown'
  else
    printf 'unknown'
  fi
}

current_head() {
  if command -v git >/dev/null 2>&1; then
    git rev-parse --short HEAD 2>/dev/null || printf 'unknown'
  else
    printf 'unknown'
  fi
}

if (($# > 1)); then
  usage
  exit 2
fi

if [[ "$mode" == "-h" || "$mode" == "--help" ]]; then
  usage
  exit 0
fi

run_gate() {
  local title="$1"
  shift

  echo
  echo "== $title =="
  if "$@"; then
    echo "OK: $title passed."
  else
    local code=$?
    echo "FAIL: $title failed with exit code $code."
    status=1
  fi
}

run_history_cleanup_materials_gate() {
  scripts/audit/audit_history_cleanup_materials.sh --check
}

run_summary() {
  local summary_status=0
  local prerequisites_ok=1

  echo "== KCoder release summary =="
  echo "This summary is read-only and never prints secret values."
  echo
  echo "Repository: $repo_dir"
  echo "Branch: $(current_branch)"
  echo "Head: $(current_head)"

  echo
  echo "== Prerequisites =="
  for tool in git rg; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "OK: $tool is available."
    else
      echo "FAIL: required tool is missing: $tool"
      prerequisites_ok=0
      summary_status=1
    fi
  done
  if ((prerequisites_ok != 0)); then
    if printf 'no-secret-here\n' | rg --pcre2 "$secret_regex" - >/dev/null 2>&1; then
      :
    else
      local rg_status=$?
      if ((rg_status == 1)); then
        echo "OK: rg PCRE2 support is available."
      else
        echo "FAIL: rg --pcre2 is not usable in this environment."
        prerequisites_ok=0
        summary_status=1
      fi
    fi
  fi
  if ((prerequisites_ok == 0)); then
    echo
    echo "FAIL: summary cannot complete until prerequisites are available."
    return "$summary_status"
  fi

  echo
  echo "== Local secret state =="
  local launcher_status=0
  local credential_path_regex='lib/common\.sh|auth import --env-file'
  for file in scripts/install/lib/launcher.sh; do
    if [[ ! -f "$file" ]]; then
      echo "FAIL: $file is missing."
      launcher_status=1
      summary_status=1
      continue
    fi
    if ! rg -q "$credential_path_regex" "$file"; then
      echo "FAIL: $file does not use the approved development credential path."
      launcher_status=1
      summary_status=1
    fi
    if rg --pcre2 -q "$secret_regex" "$file"; then
      echo "FAIL: $file contains an inline API key pattern."
      launcher_status=1
      summary_status=1
    fi
  done
  if ((launcher_status == 0)); then
    echo "OK: MiniMax launcher uses the shared credential path and contains no inline API key pattern."
  fi

  local worktree_summary_output
  worktree_summary_output="$(mktemp)"
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
    . >"$worktree_summary_output"; then
    local worktree_count
    worktree_count="$(wc -l <"$worktree_summary_output" | tr -d '[:space:]')"
    echo "FAIL: working tree API key pattern matches in $worktree_count file(s)."
    summary_status=1
  else
    local rg_status=$?
    if ((rg_status == 1)); then
      echo "OK: working tree secret scan has no API key pattern matches."
    else
      echo "FAIL: working tree secret scan failed."
      summary_status=1
    fi
  fi
  rm -f "$worktree_summary_output"

  echo
  echo "== Git history state =="
  local history_hits=0
  local history_commits=0
  declare -A seen_history_hits=()
  declare -A seen_history_commits=()
  while IFS= read -r rev; do
    while IFS= read -r match; do
      local path="${match#"$rev:"}"
      local hit="${rev:0:7}:$path"
      if [[ -z "${seen_history_hits[$hit]+x}" ]]; then
        seen_history_hits[$hit]=1
        history_hits=$((history_hits + 1))
      fi
      if [[ -z "${seen_history_commits[$rev]+x}" ]]; then
        seen_history_commits[$rev]=1
        history_commits=$((history_commits + 1))
      fi
    done < <(git grep -I -E -l "$secret_regex" "$rev" -- . 2>/dev/null || true)
  done < <(git rev-list --all --reflog)

  if ((history_hits > 0)); then
    echo "FAIL: Git history/reflog still has API key pattern matches in $history_hits path snapshot(s) across $history_commits commit(s)."
    echo "Next: run scripts/audit/audit_history_cleanup_runbook.sh after key revocation, push freeze, backup, and clean worktree."
    summary_status=1
  else
    echo "OK: Git history/reflog secret scan has no API key pattern matches."
  fi

  echo
  echo "== Git unreachable object state =="
  if scripts/audit/audit_git_unreachable_secret_scan.sh --summary; then
    :
  else
    summary_status=1
  fi

  echo
  echo "== History cleanup readiness =="
  if [[ -n "$(git status --short)" ]]; then
    echo "FAIL: worktree is not clean."
    summary_status=1
  else
    echo "OK: worktree is clean."
  fi
  if command -v git-filter-repo >/dev/null 2>&1; then
    echo "OK: git-filter-repo is available."
  else
    echo "FAIL: git-filter-repo is not available on PATH."
    summary_status=1
  fi

  echo
  echo "== Manual signoff state =="
  local signoff_file="AUDIT_REMEDIATION_MANUAL_SIGNOFF.md"
  if [[ ! -r "$signoff_file" ]]; then
    echo "FAIL: $signoff_file is not readable."
    summary_status=1
  else
    local missing=()
    for id in "${required_signoffs[@]}"; do
      if ! grep -Eq "^- \[x\] \`$id\`:" "$signoff_file"; then
        missing+=("$id")
      fi
    done
    if ((${#missing[@]} > 0)); then
      echo "FAIL: ${#missing[@]} signoff item(s) are not checked:"
      printf '  %s\n' "${missing[@]}"
      echo "Next: use the checklist scripts listed below, then run scripts/audit/audit_manual_release_gate.sh."
      summary_status=1
    else
      echo "OK: all signoff checkboxes are checked. Run scripts/audit/audit_manual_release_gate.sh for evidence validation."
    fi
  fi

  echo
  echo "Checklist entry points:"
  echo "- scripts/audit/audit_external_secret_checklist.sh"
  echo "- scripts/audit/audit_tui_manual_checklist.sh"
  echo "- scripts/audit/audit_worktree_review_checklist.sh"
  echo "- scripts/audit/audit_history_cleanup_runbook.sh"
  echo "- scripts/audit/audit_history_cleanup_materials.sh"

  echo
  if ((summary_status == 0)); then
    echo "OK: summary found no local blockers. Run scripts/audit/audit_release_status.sh for full gate output."
  else
    echo "FAIL: summary found release blockers."
  fi
  return "$summary_status"
}

if [[ "$mode" == "--summary" ]]; then
  run_summary
  exit $?
elif [[ "$mode" != "full" ]]; then
  usage
  exit 2
fi

echo "== KCoder release status =="
echo "This script is read-only. It does not rewrite history, rotate keys, or approve manual checks."
echo "Do not paste or record secret values in signoff evidence."
echo
echo "Repository: $repo_dir"
echo "Branch: $(current_branch)"
echo "Head: $(current_head)"
echo
echo "Manual checklist entry points:"
echo "- External secrets: scripts/audit/audit_external_secret_checklist.sh"
echo "- TUI real-terminal checks: scripts/audit/audit_tui_manual_checklist.sh"
echo "- Worktree review: scripts/audit/audit_worktree_review_checklist.sh"
echo "- History cleanup runbook: scripts/audit/audit_history_cleanup_runbook.sh"
echo "- History cleanup materials: scripts/audit/audit_history_cleanup_materials.sh"

run_gate "External secret local checklist" scripts/audit/audit_external_secret_checklist.sh
run_gate "History cleanup materials" run_history_cleanup_materials_gate
run_gate "Release audit" scripts/audit/audit_release_check.sh
run_gate "History cleanup preflight" scripts/audit/audit_history_cleanup_preflight.sh
run_gate "Manual signoff evidence" scripts/audit/audit_manual_release_gate.sh --signoff-only

echo
if ((status == 0)); then
  echo "OK: all local release status gates passed."
else
  echo "FAIL: release is still blocked. Review the failing sections above."
fi

exit "$status"
