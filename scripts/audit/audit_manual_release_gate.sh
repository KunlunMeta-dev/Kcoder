#!/usr/bin/env bash
set -euo pipefail

script_path="${BASH_SOURCE[0]}"
script_dir="${script_path%/*}"
if [[ "$script_dir" == "$script_path" ]]; then
  script_dir="."
fi
repo_dir="$(cd "$script_dir/../.." && pwd -P)"
cd "$repo_dir"

signoff_file="AUDIT_REMEDIATION_MANUAL_SIGNOFF.md"
run_automated_audit=1
signoff_file_set=0

usage() {
  echo "Usage: scripts/audit/audit_manual_release_gate.sh [--signoff-only] [signoff-file]"
}

while (($# > 0)); do
  case "$1" in
    --signoff-only)
      run_automated_audit=0
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "FAIL: unknown option: $1"
      usage
      exit 2
      ;;
    *)
      if ((signoff_file_set != 0)); then
        echo "FAIL: at most one signoff file may be provided."
        usage
        exit 2
      fi
      signoff_file="$1"
      signoff_file_set=1
      ;;
  esac
  shift
done

required_ids=(
  MINIMAX_KEY_ROTATED
  GIT_HISTORY_CLEANED
  CI_DEPLOY_SECRETS_UPDATED
  TUI_PANIC_RECOVERY_OK
  TUI_SIGTERM_RECOVERY_OK
  TUI_HIGH_SPEED_STREAM_OK
  TUI_UNICODE_EDIT_OK
  DIRTY_WORKTREE_REVIEWED
)

declare -A evidence_labels=(
  [MINIMAX_KEY_ROTATED]="MiniMax key rotation"
  [GIT_HISTORY_CLEANED]="Git history cleanup"
  [CI_DEPLOY_SECRETS_UPDATED]="CI/deployment secret update"
  [TUI_PANIC_RECOVERY_OK]="TUI panic recovery"
  [TUI_SIGTERM_RECOVERY_OK]="TUI SIGTERM recovery"
  [TUI_HIGH_SPEED_STREAM_OK]="TUI high-speed stream"
  [TUI_UNICODE_EDIT_OK]="TUI Unicode editing"
  [DIRTY_WORKTREE_REVIEWED]="Dirty worktree review"
)

status=0

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

evidence_contains_placeholder() {
  local evidence_lower="$1"
  [[ "$evidence_lower" =~ (^|[^[:alnum:]])(todo|tbd|pending|none|n/a|na|placeholder|replace-me)([^[:alnum:]]|$) \
    || "$evidence_lower" =~ \<[^[:space:]][^[:space:]]*\> \
    || "$evidence_lower" == "-" ]]
}

evidence_contains_valid_iso_date() {
  local evidence="$1"
  if [[ "$evidence" =~ (20[0-9]{2}-[01][0-9]-[0-3][0-9]) ]]; then
    local candidate="${BASH_REMATCH[1]}"
    [[ "$(date -d "$candidate" +%F 2>/dev/null || true)" == "$candidate" ]]
  else
    return 1
  fi
}

evidence_has_required_fields() {
  local evidence_lower="$1"
  [[ "$evidence_lower" == *"maintainer="* ]] \
    && { [[ "$evidence_lower" == *"command="* ]] || [[ "$evidence_lower" == *"console="* ]]; } \
    && [[ "$evidence_lower" == *"observed="* ]]
}

evidence_contains_secret_pattern() {
  local evidence="$1"
  [[ "$evidence" =~ sk-cp-[A-Za-z0-9_-]{20,} || "$evidence" =~ sk-[A-Za-z0-9_-]{32,} ]]
}

echo "== Manual release signoff =="
if [[ ! -r "$signoff_file" ]]; then
  echo "FAIL: signoff file not readable: $signoff_file"
  status=1
else
  signoff_content="$(<"$signoff_file")"
  for id in "${required_ids[@]}"; do
    checkbox_count="$(grep -Ec "^- \[[ x]\] \`$id\`:" <<<"$signoff_content" || true)"
    if [[ "$checkbox_count" != "1" ]]; then
      echo "FAIL: $id must appear exactly once in the signoff checklist"
      status=1
      continue
    fi
    if grep -Eq "^- \[x\] \`$id\`:" <<<"$signoff_content"; then
      echo "OK: $id"
      label="${evidence_labels[$id]}"
      evidence_count="$(grep -Ec "^- ${label}:" <<<"$signoff_content" || true)"
      if [[ "$evidence_count" != "1" ]]; then
        echo "FAIL: $id evidence note must appear exactly once"
        status=1
        continue
      fi
      evidence_line="$(grep -E "^- ${label}:" <<<"$signoff_content")"
      evidence_text="${evidence_line#- ${label}:}"
      evidence_text="$(trim "$evidence_text")"
      if [[ -z "$evidence_line" || -z "$evidence_text" ]]; then
        echo "FAIL: $id is signed off but evidence note is empty"
        status=1
      else
        evidence_lower="$(printf '%s' "$evidence_text" | tr '[:upper:]' '[:lower:]')"
        if evidence_contains_placeholder "$evidence_lower"; then
          echo "FAIL: $id evidence note is still a placeholder"
          status=1
        fi
        if evidence_contains_secret_pattern "$evidence_text"; then
          echo "FAIL: $id evidence note contains an API key pattern"
          status=1
        fi
        if ! evidence_contains_valid_iso_date "$evidence_text"; then
          echo "FAIL: $id evidence note must include a valid ISO date (YYYY-MM-DD)"
          status=1
        fi
        if ! evidence_has_required_fields "$evidence_lower"; then
          echo "FAIL: $id evidence note must include maintainer=..., command=... or console=..., and observed=..."
          status=1
        fi
      fi
    else
      echo "FAIL: $id is not signed off in $signoff_file"
      status=1
    fi
  done
fi

echo
echo "== Automated release audit =="
if ((run_automated_audit != 0)); then
  if ! scripts/audit/audit_release_check.sh; then
    status=1
  fi
else
  echo "SKIP: --signoff-only was requested. Run scripts/audit/audit_release_check.sh separately."
fi

if ((status == 0)); then
  echo
  if ((run_automated_audit != 0)); then
    echo "OK: manual signoff and automated release audit passed."
  else
    echo "OK: manual signoff passed."
  fi
else
  echo
  echo "FAIL: release is still blocked."
fi

exit "$status"
