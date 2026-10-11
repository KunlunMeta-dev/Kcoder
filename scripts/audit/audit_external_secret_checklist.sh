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
  echo "Usage: scripts/audit/audit_external_secret_checklist.sh"
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
secret_regex='sk-cp-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{32,}'
credential_path_regex='(?:lib/)?(?:common|launcher|config-sync)\.sh|auth (import|login).*--env-file'
launcher_files=(
  scripts/install/lib/launcher.sh
  scripts/install/lib/config-sync.sh
)

echo "== KCoder external secret checklist =="
echo
echo "This script prints secret-rotation checks and evidence lines."
echo "It does not contact MiniMax, CI, deployment hosts, or secret managers."
echo "Do not paste or record secret values."
echo
echo "Context:"
echo "- repo: $repo_dir"
echo "- date: $today"
echo "- maintainer field: $maintainer"
echo "- MINIMAX_API_KEY environment: $([[ -n "${MINIMAX_API_KEY:-}" ]] && printf 'set' || printf 'unset')"
echo
echo "Local launcher checks:"
status=0
for file in "${launcher_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "- FAIL: $file is missing"
    status=1
    continue
  fi
  if rg -q "$credential_path_regex" "$file"; then
    echo "- OK: $file uses an approved credential-sync path"
  else
    echo "- FAIL: $file does not delegate to an approved credential-sync helper"
    status=1
  fi
  if rg --pcre2 -q "$secret_regex" "$file"; then
    echo "- FAIL: $file contains an inline API key pattern"
    status=1
  else
    echo "- OK: $file has no inline API key pattern"
  fi
done
echo
echo "MiniMax console checklist:"
echo "- Revoke every exposed MiniMax key visible in the leak history."
echo "- Issue a replacement key in the MiniMax console."
echo "- Store the replacement only in approved secret storage."
echo "- Record a console audit id, ticket id, or timestamp; do not record the key."
echo
echo "CI/deployment checklist:"
echo "- Update CI/CD secret storage for MINIMAX_API_KEY."
echo "- Update deployment hosts or orchestration secret storage."
echo "- Update developer machine local environments where needed."
echo "- Restart or redeploy services that cache environment variables."
echo "- Run scripts/audit/audit_release_check.sh after updates."
echo
echo "Evidence lines:"
echo "- MiniMax key rotation: $today maintainer=$maintainer console=minimax-console command=\"revoke exposed MiniMax key and issue replacement\" observed=\"old key revoked; replacement issued; no key value recorded\""
echo "- CI/deployment secret update: $today maintainer=$maintainer console=secret-manager command=\"update MINIMAX_API_KEY in CI, deployment hosts, and developer environments\" observed=\"new key installed through approved secret storage; no key value recorded\""
echo
echo "After external updates:"
echo "1. Replace any angle-bracket values before copying evidence into AUDIT_REMEDIATION_MANUAL_SIGNOFF.md."
echo "2. Change MINIMAX_KEY_ROTATED and CI_DEPLOY_SECRETS_UPDATED to [x] only after the external actions are complete."
echo "3. Run: scripts/audit/audit_manual_release_gate.sh"

exit "$status"
