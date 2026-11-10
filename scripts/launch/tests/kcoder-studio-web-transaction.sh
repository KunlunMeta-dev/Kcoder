#!/usr/bin/env bash
# Managed launch preflight ordering contract. All privileged commands and services
# are mocked; this test never invokes host systemd or writes /etc.

set -euo pipefail

source_repo="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
test_root="$(mktemp -d "${TMPDIR:-/tmp}/kcoder-studio-launch-transaction.XXXXXX")"
trap 'rm -rf -- "$test_root"' EXIT

repo="$test_root/repo"
home="$test_root/home"
fake_bin="$test_root/fake-bin"
fake_systemd="$test_root/systemd"
temp_dir="$test_root/tmp"
events="$test_root/events.log"
mkdir -p \
  "$repo/scripts/launch/lib" \
  "$repo/scripts/launch/services/systemd" \
  "$repo/scripts/install/lib" \
  "$repo/crates/kcoder_config" \
  "$repo/apps/kcoder-studio/renderer" \
  "$repo/apps/kcoder-studio/mobile/node_modules/expo/bin" \
  "$repo/apps/kcoder-studio/mobile/node_modules/esbuild" \
  "$repo/target/release" "$repo/target/debug" \
  "$home/.local/bin" \
  "$home/.config/kcoder-studio" \
  "$fake_bin" "$fake_systemd" "$temp_dir"

cp "$source_repo/scripts/launch/kcoder-studio-web-release.sh" "$repo/scripts/launch/"
cp "$source_repo/scripts/launch/kcoder-studio-web-dev.sh" "$repo/scripts/launch/"
cp "$source_repo/scripts/launch/lib/kcoder-studio-web-start.sh" "$repo/scripts/launch/lib/"
cp "$source_repo/scripts/install/lib/"{binary,profile,config-sync}.sh "$repo/scripts/install/lib/"
cp "$source_repo/scripts/launch/services/systemd/"*.service "$repo/scripts/launch/services/systemd/"
touch "$repo/apps/kcoder-studio/mobile/node_modules/expo/bin/cli"
chmod +x "$repo/apps/kcoder-studio/mobile/node_modules/expo/bin/cli"

cat >"$repo/target/release/kcoder" <<'MOCK_KCODER'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --cwd ]]; then shift 2; fi
case "${1:-}" in
  --help) printf '%s\n' 'options: --provider'; exit 0 ;;
  auth) printf '%s\n' 'login'; exit 0 ;;
  --version) printf '%s\n' 'kcoder mock version'; exit 0 ;;
  config)
    case "${2:-}" in
      migrate) printf 'config-migrate\n' >>"$KCODER_TEST_EVENTS"; exit 0 ;;
      import) printf 'config-import\n' >>"$KCODER_TEST_EVENTS"; exit 0 ;;
      validate)
        printf 'config-validate\n' >>"$KCODER_TEST_EVENTS"
        if [[ "${KCODER_TEST_VALIDATE_FAIL:-0}" == 1 ]]; then
          echo 'mock config validation failed' >&2
          exit 41
        fi
        exit 0
        ;;
    esac
    ;;
esac
echo "unexpected mock kcoder invocation: $*" >&2
exit 2
MOCK_KCODER
chmod +x "$repo/target/release/kcoder"
cp "$repo/target/release/kcoder" "$repo/target/debug/kcoder-dev"
chmod +x "$repo/target/debug/kcoder-dev"

cat >"$fake_bin/npm" <<'MOCK_NPM'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm-build\n' >>"$KCODER_TEST_EVENTS"
if [[ "${KCODER_TEST_NPM_FAIL:-0}" == 1 ]]; then
  echo 'mock Mobile build failed' >&2
  exit 42
fi
MOCK_NPM
chmod +x "$fake_bin/npm"

cat >"$fake_bin/pnpm" <<'MOCK_PNPM'
#!/usr/bin/env bash
set -euo pipefail
printf 'renderer-build\n' >>"$KCODER_TEST_EVENTS"
if [[ "${KCODER_TEST_PNPM_FAIL:-0}" == 1 ]]; then
  echo 'mock renderer build failed' >&2
  exit 43
fi
MOCK_PNPM
chmod +x "$fake_bin/pnpm"

cat >"$fake_bin/install" <<'MOCK_INSTALL'
#!/usr/bin/env bash
set -euo pipefail
destination="${@: -1}"
if [[ "${KCODER_TEST_INSTALL_FAIL:-0}" == 1 && "$destination" == "$HOME"/.local/bin/.kcoder.* ]]; then
  printf 'binary-stage-failed\n' >>"$KCODER_TEST_EVENTS"
  echo 'mock binary staging write failed' >&2
  exit 44
fi
exec /usr/bin/install "$@"
MOCK_INSTALL
chmod +x "$fake_bin/install"

cat >"$fake_bin/systemctl" <<'MOCK_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >>"$KCODER_TEST_EVENTS"
case "${1:-}" in
  show-environment|daemon-reload|start|stop|status) exit 0 ;;
  cat) [[ -f "$KCODER_TEST_SYSTEMD/${2:?unit required}" ]] ;;
  is-active) [[ "${2:-}" == --quiet && -f "$KCODER_TEST_SYSTEMD/${3:?unit required}" ]] ;;
  *) echo "unexpected mock systemctl invocation: $*" >&2; exit 2 ;;
esac
MOCK_SYSTEMCTL
chmod +x "$fake_bin/systemctl"

cat >"$fake_bin/sudo" <<'MOCK_SUDO'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == -n ]]; then shift; fi
if [[ "${1:-}" == true ]]; then exit 0; fi
if [[ "${1:-}" == systemctl ]]; then
  shift
  exec "$KCODER_TEST_FAKE_BIN/systemctl" "$@"
fi
if [[ "${1:-}" == install ]]; then
  shift
  mode=""
  if [[ "${1:-}" == -m ]]; then mode="$2"; shift 2; fi
  source_file="${1:?source file required}"
  destination="${2:?destination required}"
  case "$destination" in
    /etc/systemd/system/*) destination="$KCODER_TEST_SYSTEMD/${destination##*/}" ;;
    *) echo "unexpected mock privileged destination: $destination" >&2; exit 2 ;;
  esac
  /usr/bin/install -m "${mode:-0644}" "$source_file" "$destination"
  printf 'unit-install %s\n' "${destination##*/}" >>"$KCODER_TEST_EVENTS"
  exit 0
fi
echo "unexpected mock sudo invocation: $*" >&2
exit 2
MOCK_SUDO
chmod +x "$fake_bin/sudo"

printf 'KCODER_STUDIO_PORT=4173\n' >"$home/.config/kcoder-studio/web-gateway.env"
printf '{"providers":[]}\n' >"$repo/crates/kcoder_config/setting_dev_user.jsonc"
for unit in \
  kcoder-studio-web.service \
  kcoder-studio-client.service \
  kcoder-studio-mobile-bundler.service \
  kcoder-studio-mobile-web.service; do
  printf 'old unit: %s\n' "$unit" >"$fake_systemd/$unit"
done
printf 'old user binary\n' >"$home/.local/bin/kcoder"
printf 'old dev user binary\n' >"$home/.local/bin/kcoder-dev"

env_common=(
  "HOME=$home"
  "KCODER_STUDIO_SERVICE_HOME=$home"
  "KCODER_STUDIO_CONFIG_DIR=$home/.config/kcoder-studio"
  "KCODER_STUDIO_KCODER_HOME=$home/.config/kcoder"
  "KCODER_REAL_BIN=$repo/target/release/kcoder"
  "KCODER_STUDIO_NODE_BIN=$(command -v node)"
  "KCODER_STUDIO_NPM_BIN=$fake_bin/npm"
  "KCODER_STUDIO_SKIP_CLI_INSTALL=1"
  "KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD=1"
  "KCODER_TEST_EVENTS=$events"
  "KCODER_TEST_SYSTEMD=$fake_systemd"
  "KCODER_TEST_FAKE_BIN=$fake_bin"
  "PATH=$fake_bin:$PATH"
  "TMPDIR=$temp_dir"
)

assert_old_artifacts_unchanged() {
  local binary_path="$1" expected_binary="$2"
  grep -Fxq "$expected_binary" "$binary_path"
  for unit in \
    kcoder-studio-web.service \
    kcoder-studio-client.service \
    kcoder-studio-mobile-bundler.service \
    kcoder-studio-mobile-web.service; do
    grep -Fxq "old unit: $unit" "$fake_systemd/$unit"
  done
  ! grep -q '^unit-install ' "$events"
  ! grep -q '^systemctl daemon-reload$' "$events"
  [[ -z "$(find "$temp_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]
  [[ -z "$(find "$home/.local/bin" -name '.kcoder.*' -print -quit)" ]]
}

run_release() {
  local result=0
  env "${env_common[@]}" "$@" "$repo/scripts/launch/kcoder-studio-web-release.sh" --managed \
    >"$test_root/run.stdout" 2>"$test_root/run.stderr" || result=$?
  return "$result"
}

: >"$events"
if run_release KCODER_TEST_NPM_FAIL=1; then
  echo 'release launch unexpectedly passed the mocked Mobile build failure.' >&2
  exit 1
fi
assert_old_artifacts_unchanged "$home/.local/bin/kcoder" 'old user binary'
grep -Fxq 'npm-build' "$events"
! grep -q '^config-validate$' "$events"

: >"$events"
if run_release KCODER_TEST_VALIDATE_FAIL=1; then
  echo 'release launch unexpectedly passed the mocked config validation failure.' >&2
  exit 1
fi
assert_old_artifacts_unchanged "$home/.local/bin/kcoder" 'old user binary'
grep -Fxq 'config-validate' "$events"
! grep -q '^unit-install ' "$events"

: >"$events"
if run_release KCODER_TEST_INSTALL_FAIL=1; then
  echo 'release launch unexpectedly passed the mocked binary staging failure.' >&2
  exit 1
fi
assert_old_artifacts_unchanged "$home/.local/bin/kcoder" 'old user binary'
grep -Fxq 'binary-stage-failed' "$events"
! grep -q '^unit-install ' "$events"

: >"$events"
if env "${env_common[@]}" \
  KCODER_STUDIO_RENDERER_MODE=static \
  KCODER_STUDIO_DEV_SKIP_RENDERER_BUILD=0 \
  KCODER_REAL_BIN="$repo/target/debug/kcoder-dev" \
  KCODER_TEST_PNPM_FAIL=1 \
  "$repo/scripts/launch/kcoder-studio-web-dev.sh" --managed \
  >"$test_root/run.stdout" 2>"$test_root/run.stderr"; then
  echo 'development launch unexpectedly passed the mocked renderer build failure.' >&2
  exit 1
fi
assert_old_artifacts_unchanged "$home/.local/bin/kcoder-dev" 'old dev user binary'
grep -Fxq 'renderer-build' "$events"
! grep -q '^config-validate$' "$events"

: >"$events"
run_release
published_version="$("$home/.local/bin/kcoder" --version)"
[[ "$published_version" == 'kcoder mock version' ]] || {
  echo 'successful managed launch did not publish the validated user binary.' >&2
  exit 1
}
first_install_line="$(grep -n '^unit-install ' "$events" | head -n 1 | cut -d: -f1)"
validate_line="$(grep -n '^config-validate$' "$events" | head -n 1 | cut -d: -f1)"
reload_line="$(grep -n '^systemctl daemon-reload$' "$events" | head -n 1 | cut -d: -f1)"
[[ -n "$first_install_line" && -n "$validate_line" && -n "$reload_line" ]] || {
  echo 'successful managed launch omitted a required preflight/install event.' >&2
  exit 1
}
(( validate_line < first_install_line && first_install_line < reload_line )) || {
  echo 'service installation did not follow successful config validation.' >&2
  cat "$events" >&2
  exit 1
}
[[ -z "$(find "$temp_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]]
[[ -z "$(find "$home/.local/bin" -name '.kcoder.*' -print -quit)" ]]

# Development's default Vite path needs installed dependencies, but no dist build.
mkdir -p "$repo/apps/kcoder-studio/renderer/node_modules/vite"
printf '{}\n' >"$repo/apps/kcoder-studio/renderer/node_modules/vite/package.json"
: >"$events"
if ! env "${env_common[@]}" KCODER_REAL_BIN="$repo/target/debug/kcoder-dev" \
  "$repo/scripts/launch/kcoder-studio-web-dev.sh" --managed \
  >"$test_root/run.stdout" 2>"$test_root/run.stderr"; then
  cat "$test_root/run.stderr" >&2
  exit 1
fi
! grep -q '^renderer-build$' "$events"
grep -Fxq 'Environment=KCODER_STUDIO_RENDERER_MODE=vite' "$fake_systemd/kcoder-studio-web.service"

echo 'studio managed launch transaction contract: ok'
