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
  echo "Usage: scripts/audit/audit_scripts_selftest.sh"
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

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

status=0
last_output="$tmp_dir/output.txt"
secret_regex='sk-cp-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}'
bash_bin="${BASH:-/bin/bash}"
# Resolve the platform env binary from system paths. Developer shells may put
# an environment-manager shim named `env` earlier in PATH; such a shim does not
# necessarily implement POSIX `env PATH=... command` semantics and would make
# the missing-prerequisite test exercise the shim instead of the audit script.
env_bin="$(PATH=/usr/bin:/bin command -v env)"

valid_minimax='2026-06-18 maintainer=release-owner console=minimax-console command=rotate-minimax-key observed=old-key-revoked-and-new-key-issued'
valid_history='2026-06-18 maintainer=release-owner command=audit-release-check observed=clean-history-confirmed'
valid_ci='2026-06-18 maintainer=release-owner console=secret-manager command=update-minimax-api-key observed=ci-deploy-dev-secrets-updated'
valid_panic='2026-06-18 maintainer=release-owner console=pts-1 command=controlled-tui-panic-then-stty observed=terminal-restored'
valid_sigterm='2026-06-18 maintainer=release-owner console=pts-1 command=kill-term-12345-then-stty observed=terminal-restored'
valid_stream='2026-06-18 maintainer=release-owner console=pts-1 command=long-stream-while-typing observed=input-responsive'
valid_unicode='2026-06-18 maintainer=release-owner console=pts-1 command=permission-editor-unicode observed=cursor-delete-wrap-correct'
valid_worktree='2026-06-18 maintainer=release-owner command=audit-worktree-review-checklist observed=all-listed-paths-reviewed'

write_signoff() {
  local path="$1"
  local minimax="${2:-$valid_minimax}"
  local history="${3:-$valid_history}"
  local ci="${4:-$valid_ci}"
  local panic="${5:-$valid_panic}"
  local sigterm="${6:-$valid_sigterm}"
  local stream="${7:-$valid_stream}"
  local unicode="${8:-$valid_unicode}"
  local worktree="${9:-$valid_worktree}"

  cat >"$path" <<EOF
# KCoder Manual Release Signoff

- [x] \`MINIMAX_KEY_ROTATED\`: done
- [x] \`GIT_HISTORY_CLEANED\`: done
- [x] \`CI_DEPLOY_SECRETS_UPDATED\`: done
- [x] \`TUI_PANIC_RECOVERY_OK\`: done
- [x] \`TUI_SIGTERM_RECOVERY_OK\`: done
- [x] \`TUI_HIGH_SPEED_STREAM_OK\`: done
- [x] \`TUI_UNICODE_EDIT_OK\`: done
- [x] \`DIRTY_WORKTREE_REVIEWED\`: done

## Evidence Notes

- MiniMax key rotation: $minimax
- Git history cleanup: $history
- CI/deployment secret update: $ci
- TUI panic recovery: $panic
- TUI SIGTERM recovery: $sigterm
- TUI high-speed stream: $stream
- TUI Unicode editing: $unicode
- Dirty worktree review: $worktree
EOF
}

ok() {
  echo "OK: $1"
}

fail() {
  echo "FAIL: $1"
  status=1
}

expect_success() {
  local name="$1"
  shift
  if "$@" >"$last_output" 2>&1; then
    ok "$name"
  else
    fail "$name"
  fi
}

expect_failure() {
  local name="$1"
  shift
  if "$@" >"$last_output" 2>&1; then
    fail "$name"
  else
    ok "$name"
  fi
}

expect_exit_code() {
  local name="$1"
  local expected="$2"
  shift 2
  set +e
  "$@" >"$last_output" 2>&1
  local code=$?
  set -e
  if [[ "$code" == "$expected" ]]; then
    ok "$name"
  else
    fail "$name"
  fi
}

assert_output_contains() {
  local name="$1"
  local pattern="$2"
  if rg -q "$pattern" "$last_output"; then
    ok "$name"
  else
    fail "$name"
  fi
}

assert_output_has_no_secret() {
  local name="$1"
  if rg --pcre2 -q "$secret_regex" "$last_output"; then
    fail "$name"
  else
    ok "$name"
  fi
}

assert_output_not_contains() {
  local name="$1"
  local pattern="$2"
  if rg -q "$pattern" "$last_output"; then
    fail "$name"
  else
    ok "$name"
  fi
}

echo "== Audit scripts selftest =="

if [[ -x scripts/audit/audit_source_language.py ]]; then
  ok "executable: scripts/audit/audit_source_language.py"
else
  fail "executable: scripts/audit/audit_source_language.py"
fi
expect_success "source language audit passes repository" scripts/audit/audit_source_language.py

source_language_repo="$tmp_dir/source-language-repo"
mkdir -p "$source_language_repo"
git -C "$source_language_repo" init -q
printf '%s\n' '# English comment.' >"$source_language_repo/example.sh"
git -C "$source_language_repo" add example.sh
expect_success "source language audit accepts English comments" \
  scripts/audit/audit_source_language.py "$source_language_repo"
printf '%s\n' '# 中文注释' >"$source_language_repo/example.sh"
expect_failure "source language audit rejects non-English comments" \
  scripts/audit/audit_source_language.py "$source_language_repo"
assert_output_contains "source language failure reports file" "example.sh:1"

printf '%s\n' '# English comment.' >"$source_language_repo/example.sh"
printf '%s\n' 'const VALUE: &str = r#"fixture"#;' '// 中文注释' >"$source_language_repo/raw.rs"
git -C "$source_language_repo" add raw.rs
expect_failure "source language audit checks comments after Rust raw strings" \
  scripts/audit/audit_source_language.py "$source_language_repo"
assert_output_contains "raw-string language failure reports file" "raw.rs:2"

printf '%s\n' '// English comment.' >"$source_language_repo/raw.rs"
printf '%s\n' '<# 中文块注释 #>' >"$source_language_repo/block.ps1"
git -C "$source_language_repo" add block.ps1
expect_failure "source language audit checks PowerShell block comments" \
  scripts/audit/audit_source_language.py "$source_language_repo"
assert_output_contains "PowerShell language failure reports file" "block.ps1:1"

printf '%s\n' '<# English block comment. #>' >"$source_language_repo/block.ps1"
attribution_product=Code
attribution_product+=x
printf '// This mirrors %s\047s design.\n' "$attribution_product" >"$source_language_repo/attribution.rs"
git -C "$source_language_repo" add attribution.rs
expect_failure "source language audit rejects attribution variants" \
  scripts/audit/audit_source_language.py "$source_language_repo"
assert_output_contains "attribution failure reports file" "attribution.rs"

printf '%s\n' '// Independent implementation.' >"$source_language_repo/attribution.rs"
printf '%s\n' '# 中文点文件注释' >"$source_language_repo/.npmignore"
git -C "$source_language_repo" add .npmignore
expect_failure "source language audit checks comments in ignore dotfiles" \
  scripts/audit/audit_source_language.py "$source_language_repo"
assert_output_contains "dotfile language failure reports file" ".npmignore:1"

for script in scripts/audit/audit_*.sh; do
  expect_success "syntax: $script" bash -n "$script"
  if [[ -x "$script" ]]; then
    ok "executable: $script"
  else
    fail "executable: $script"
  fi
done

path_dependency_pattern='repo_dir=.*dir'
path_dependency_pattern+='name.*BASH_SOURCE'
if rg -q "$path_dependency_pattern" scripts/audit/audit_*.sh; then
  fail "audit scripts avoid dirname path dependency"
else
  ok "audit scripts avoid dirname path dependency"
fi

valid_signoff="$tmp_dir/valid-signoff.md"
write_signoff "$valid_signoff"
expect_success "valid signoff passes signoff-only" scripts/audit/audit_manual_release_gate.sh --signoff-only "$valid_signoff"
assert_output_contains "valid signoff output confirms pass" "OK: manual signoff passed"

expect_exit_code "manual gate bad argument exits 2" 2 scripts/audit/audit_manual_release_gate.sh --bad --signoff-only
assert_output_contains "manual gate bad argument shows usage" "Usage:"

expect_exit_code "manual gate rejects multiple signoff files" 2 scripts/audit/audit_manual_release_gate.sh --signoff-only "$valid_signoff" "$valid_signoff"
assert_output_contains "manual gate multiple file failure explains limit" "at most one signoff file"

no_arg_scripts=(
  scripts/audit/audit_external_secret_checklist.sh
  scripts/audit/audit_tui_manual_checklist.sh
  scripts/audit/audit_release_check.sh
  scripts/audit/audit_history_cleanup_preflight.sh
  scripts/audit/audit_history_cleanup_runbook.sh
  scripts/audit/audit_scripts_selftest.sh
)
for script in "${no_arg_scripts[@]}"; do
  expect_exit_code "bad argument exits 2: $script" 2 "$script" --bad
  assert_output_contains "bad argument shows usage: $script" "Usage:"
done

placeholder_signoff="$tmp_dir/placeholder-signoff.md"
write_signoff "$placeholder_signoff" "2026-06-18 maintainer=<maintainer> command=console observed=rotated"
expect_failure "placeholder evidence is rejected" scripts/audit/audit_manual_release_gate.sh --signoff-only "$placeholder_signoff"
assert_output_contains "placeholder failure mentions placeholder" "placeholder"

missing_field_signoff="$tmp_dir/missing-field-signoff.md"
write_signoff "$missing_field_signoff" "2026-06-18 maintainer=release-owner command=console"
expect_failure "missing observed field is rejected" scripts/audit/audit_manual_release_gate.sh --signoff-only "$missing_field_signoff"
assert_output_contains "missing field failure mentions observed" "observed"

invalid_date_signoff="$tmp_dir/invalid-date-signoff.md"
write_signoff "$invalid_date_signoff" "2026-02-31 maintainer=release-owner command=console observed=rotated"
expect_failure "invalid ISO date is rejected" scripts/audit/audit_manual_release_gate.sh --signoff-only "$invalid_date_signoff"
assert_output_contains "invalid date failure mentions ISO date" "ISO date"

duplicate_checkbox_signoff="$tmp_dir/duplicate-checkbox-signoff.md"
write_signoff "$duplicate_checkbox_signoff"
printf '%s\n' '- [x] `MINIMAX_KEY_ROTATED`: duplicate' >>"$duplicate_checkbox_signoff"
expect_failure "duplicate signoff checkbox is rejected" scripts/audit/audit_manual_release_gate.sh --signoff-only "$duplicate_checkbox_signoff"
assert_output_contains "duplicate checkbox failure mentions exactly once" "must appear exactly once"

duplicate_evidence_signoff="$tmp_dir/duplicate-evidence-signoff.md"
write_signoff "$duplicate_evidence_signoff"
printf '%s\n' "- MiniMax key rotation: $valid_minimax" >>"$duplicate_evidence_signoff"
expect_failure "duplicate evidence note is rejected" scripts/audit/audit_manual_release_gate.sh --signoff-only "$duplicate_evidence_signoff"
assert_output_contains "duplicate evidence failure mentions exactly once" "evidence note must appear exactly once"

fake_secret='sk-cp-'
fake_secret+='ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
secret_signoff="$tmp_dir/secret-signoff.md"
write_signoff "$secret_signoff" "2026-06-18 maintainer=release-owner command=console observed=$fake_secret"
expect_failure "API key pattern evidence is rejected" scripts/audit/audit_manual_release_gate.sh --signoff-only "$secret_signoff"
assert_output_contains "secret failure mentions API key pattern" "API key pattern"
assert_output_has_no_secret "secret failure output does not echo key"

expect_exit_code "release status bad argument exits 2" 2 scripts/audit/audit_release_status.sh --bad
assert_output_contains "bad argument shows usage" "Usage:"

set +e
scripts/audit/audit_release_status.sh --summary >"$last_output" 2>&1
summary_code=$?
set -e
if [[ "$summary_code" == 0 || "$summary_code" == 1 ]]; then
  ok "release summary returns expected gate status"
else
  fail "release summary returns expected gate status"
fi
assert_output_has_no_secret "release summary output does not expose API key"

expect_failure "release summary reports missing tools cleanly" "$env_bin" PATH=/tmp "$bash_bin" scripts/audit/audit_release_status.sh --summary
assert_output_contains "missing tool summary mentions git" "required tool is missing: git"
assert_output_contains "missing tool summary mentions rg" "required tool is missing: rg"
assert_output_not_contains "missing tool summary has no shell command noise" "command not found"
assert_output_has_no_secret "missing tool summary output does not expose API key"

materials_file="$tmp_dir/kcoder-api-key-replacements.txt"
expect_success "history cleanup materials file is generated" scripts/audit/audit_history_cleanup_materials.sh "$materials_file"
assert_output_contains "materials output includes filter-repo command" "git filter-repo --replace-text"
if [[ -s "$materials_file" ]]; then
  ok "history cleanup materials file is non-empty"
else
  fail "history cleanup materials file is non-empty"
fi
if [[ "$(stat -c '%a' "$materials_file")" == "600" ]]; then
  ok "history cleanup materials file is mode 600"
else
  fail "history cleanup materials file is mode 600"
fi
if rg --pcre2 -q "$secret_regex" "$materials_file"; then
  fail "history cleanup materials file does not contain API key"
else
  ok "history cleanup materials file does not contain API key"
fi
assert_output_has_no_secret "history cleanup materials output does not expose API key"

expect_success "history cleanup materials check mode passes" scripts/audit/audit_history_cleanup_materials.sh --check
assert_output_contains "materials check mode confirms generator" "replacement rules generator works"
assert_output_has_no_secret "materials check mode output does not expose API key"

expect_failure "history cleanup materials refuse repository output" scripts/audit/audit_history_cleanup_materials.sh "$repo_dir/kcoder-api-key-replacements.txt"
assert_output_contains "repository output failure explains location" "outside this repository"
assert_output_has_no_secret "repository output failure does not expose API key"

clean_git_repo="$tmp_dir/clean-git-repo"
mkdir -p "$clean_git_repo"
git -C "$clean_git_repo" init -q
expect_success "unreachable object scan passes clean repo" scripts/audit/audit_git_unreachable_secret_scan.sh "$clean_git_repo"
assert_output_contains "clean unreachable scan reports ok" "no API key pattern found in unreachable Git objects"
assert_output_has_no_secret "clean unreachable scan output does not expose API key"

dirty_object_repo="$tmp_dir/dirty-object-repo"
mkdir -p "$dirty_object_repo"
git -C "$dirty_object_repo" init -q
printf '%s\n' "$fake_secret" | git -C "$dirty_object_repo" hash-object -w --stdin >/dev/null
expect_failure "unreachable object scan detects API key pattern" scripts/audit/audit_git_unreachable_secret_scan.sh "$dirty_object_repo"
assert_output_contains "unreachable object scan reports object records" "unreachable Git objects contain API key pattern"
assert_output_has_no_secret "unreachable object scan output does not expose API key"

set +e
scripts/audit/audit_release_status.sh >"$last_output" 2>&1
full_status_code=$?
set -e
if [[ "$full_status_code" == 0 || "$full_status_code" == 1 ]]; then
  ok "full release status returns expected gate status"
else
  fail "full release status returns expected gate status"
fi
assert_output_contains "full release status runs materials gate" "== History cleanup materials =="
assert_output_has_no_secret "full release status output does not expose API key"

expect_success "external secret checklist local checks pass" scripts/audit/audit_external_secret_checklist.sh
assert_output_has_no_secret "external secret checklist output does not expose API key"

expect_success "worktree review checklist local checks pass" scripts/audit/audit_worktree_review_checklist.sh
assert_output_contains "worktree checklist reports review map alignment" "Review map alignment"
assert_output_contains "worktree checklist prints attention paths" "Pay specific attention to:"
assert_output_has_no_secret "worktree checklist output does not expose API key"

if ((status == 0)); then
  echo
  echo "OK: audit scripts selftest passed."
else
  echo
  echo "FAIL: audit scripts selftest failed."
fi

exit "$status"
