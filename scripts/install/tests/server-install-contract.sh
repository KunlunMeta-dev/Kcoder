#!/usr/bin/env bash

set -euo pipefail

repo_dir="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
variant="${KCODER_SERVER_TEST_VARIANT:-release}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

case "$variant" in
  debug)
    installer="$repo_dir/scripts/install/installers/cli-dev-server.sh"
    expected_build_args="build --locked"
    command_name=kcoder-dev
    expected_profile=dev
    expected_root_config="$tmp/root/.config/kcoder-dev"
    ;;
  release)
    installer="$repo_dir/scripts/install/installers/cli-release-server.sh"
    expected_build_args="build --release --locked"
    command_name=kcoder
    expected_profile=release
    expected_root_config="$tmp/root/.config/kcoder"
    ;;
  *)
    echo "Unsupported test variant: $variant" >&2
    exit 1
    ;;
esac

fake_bin="$tmp/bin"
root_command="$tmp/system/$command_name"
retired_family=kunlun
retired_stem="${retired_family}code"
legacy_family_root_command="$tmp/system/$retired_family"
legacy_root_command="$tmp/system/$retired_stem"
legacy_dev_root_command="$tmp/system/$retired_stem-dev"
target_dir="$tmp/target"
env_file="$tmp/repo.env"
probe_tmp="$tmp/version-probes"
root_config_dir="$expected_root_config"
formal_root_config_dir="$tmp/root/.config/kcoder"
build_log="$tmp/build.log"
cli_log="$tmp/cli.log"
preserved_root_settings="$tmp/preserved-root-settings.json"
preserved_root_dotenv="$tmp/preserved-root.env"
mkdir -p "$fake_bin" "$tmp/system" "$probe_tmp" "$tmp/root"
chmod 0755 "$tmp" "$tmp/root" "$probe_tmp"
rg_source="$(command -v rg 2>/dev/null || true)"
current_user="$(id -un)"
installer_test_env=()
if [[ "$current_user" != root ]]; then
  # Contract tests may use temporary target directories without root; production installation remains root-only by default.
  installer_test_env=(KCODER_SERVER_TEST_ALLOW_NON_ROOT=1)
fi
installer_uid="$(id -u)"

# A stale symlink at the destination must be replaced, never followed.
ln -s "$tmp/elsewhere" "$root_command"
# Every profile installer must remove retired compatibility entry points so reinstalls cannot restore them.
printf '%s\n' '#!/bin/sh' 'exit 1' >"$legacy_root_command"
printf '%s\n' '#!/bin/sh' 'exit 1' >"$legacy_dev_root_command"
printf '%s\n' '#!/bin/sh' 'exit 1' >"$legacy_family_root_command"
chmod 0755 "$legacy_family_root_command" "$legacy_root_command" "$legacy_dev_root_command"

printf '%s\n' \
  'KUNLUNMETA_BASE_API_KEY=test-kunlunmeta-key' >"$env_file"

printf '%s\n' \
  '{' \
  '  "permission_mode": "ask",' \
  '  "goal_pro": { "verifier_max_turns": 17 }' \
  '}' >"$preserved_root_settings"
printf '%s\n' 'ROOT_RELEASE_SENTINEL=preserve-root-profile' >"$preserved_root_dotenv"

# The production root profile must remain byte-identical during release installation and entirely untouched during development installation.
install -d -m 0700 "$formal_root_config_dir"
install -m 0600 "$preserved_root_settings" "$formal_root_config_dir/settings.json"
install -m 0600 "$preserved_root_dotenv" "$formal_root_config_dir/.env"

touch "$cli_log"
chmod 0666 "$cli_log"

cat >"$fake_bin/cargo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%q ' "$@" >"${KCODER_SERVER_TEST_BUILD_LOG:?}"
printf '\n' >>"$KCODER_SERVER_TEST_BUILD_LOG"
[[ "$*" == "${KCODER_SERVER_TEST_EXPECTED_BUILD_ARGS:?}" ]]
mkdir -p "${CARGO_TARGET_DIR:?}/${KCODER_SERVER_TEST_BUILD_PROFILE:?}"
cat >"$CARGO_TARGET_DIR/$KCODER_SERVER_TEST_BUILD_PROFILE/kcoder" <<'BINARY'
#!/usr/bin/env bash
set -euo pipefail

config_dir="${KCODER_CONFIG_DIR:?version and config commands must select an explicit profile}"
mkdir -p "$config_dir"
if [[ ! -e "$config_dir/.env" ]]; then
  printf '%s\n' 'EMBEDDED_DEFAULT_SENTINEL=created-by-cli-bootstrap' >"$config_dir/.env"
fi
if [[ ! -e "$config_dir/settings.json" ]]; then
  printf '%s\n' '{"permission_mode":"yolo"}' >"$config_dir/settings.json"
fi
# The fake CLI deliberately simulates a possible future `--version` startup side
# effect. This write detects an installer version probe that incorrectly uses the
# production profile, protecting user configuration even if real CLI short-circuiting regresses.
printf '%s\n' '{"title":"embedded-test-schema"}' >"$config_dir/settings.schema.jsonc"

if [[ -n "${KCODER_SERVER_TEST_CLI_LOG:-}" ]]; then
  printf 'uid=%s home=%q kcoder_home=%q config=%q args=' \
    "$(id -u)" "${HOME:-default}" "${KCODER_HOME:-default}" "$config_dir" \
    >>"$KCODER_SERVER_TEST_CLI_LOG"
  printf '%q ' "$@" >>"$KCODER_SERVER_TEST_CLI_LOG"
  printf '\n' >>"$KCODER_SERVER_TEST_CLI_LOG"
fi
if [[ "${1:-}" == "--version" ]]; then
  printf 'kcoder test-build\n'
fi
BINARY
chmod 0755 "$CARGO_TARGET_DIR/$KCODER_SERVER_TEST_BUILD_PROFILE/kcoder"
EOF

chmod 0755 "$fake_bin/cargo"

output="$({
  env "${installer_test_env[@]}" \
  PATH="$fake_bin:$PATH" \
  TMPDIR="$probe_tmp" \
  KCODER_SERVER_ROOT_HOME="$tmp/root" \
  KCODER_SERVER_ROOT_COMMAND="$root_command" \
  KCODER_SERVER_TARGET_DIR="$target_dir" \
  KCODER_SERVER_ENV_FILE="$env_file" \
  KCODER_SERVER_ROOT_CONFIG_DIR="$root_config_dir" \
  KCODER_SERVER_TEST_BUILD_LOG="$build_log" \
  KCODER_SERVER_TEST_BUILD_PROFILE="$variant" \
  KCODER_SERVER_TEST_EXPECTED_BUILD_ARGS="$expected_build_args" \
  KCODER_SERVER_TEST_CLI_LOG="$cli_log" \
  KCODER_RIPGREP_BIN="$rg_source" \
  KCODER_SKIP_CHROME_DOWNLOAD=1 \
    "$installer"
} 2>&1)"

[[ -x "$root_command" ]]
[[ ! -L "$root_command" ]]
[[ ! -e "$legacy_root_command" && ! -L "$legacy_root_command" ]]
[[ ! -e "$legacy_dev_root_command" && ! -L "$legacy_dev_root_command" ]]
[[ ! -e "$legacy_family_root_command" && ! -L "$legacy_family_root_command" ]]
if [[ -n "$rg_source" ]]; then
  [[ -x "$(dirname "$root_command")/../lib/kcoder/rg" ]]
fi
if [[ "$current_user" == root ]]; then
  [[ "$(stat -c '%U' "$root_command")" == root ]]
fi
[[ "$(stat -c '%a' "$root_command")" == "755" ]]
grep -qx "$expected_build_args " "$build_log"
! grep -q 'install --path' "$build_log"

# The version probe must use a clean temporary profile and run as the installer identity.
[[ "$(grep -c 'args=--version ' "$cli_log")" -eq 1 ]]
root_probe_pattern="uid=$installer_uid home=$tmp/root kcoder_home=$probe_tmp/kcoder-version-check[.][^/]+ config=$probe_tmp/kcoder-version-check[.][^/]+ args=--version "
if ! grep -Eq "$root_probe_pattern" "$cli_log"; then
  echo "root version probe did not use the isolated root profile:" >&2
  sed -n '1,20p' "$cli_log" >&2
  exit 1
fi
! grep -Eq "config=$formal_root_config_dir args=--version " "$cli_log"
[[ -z "$(find "$probe_tmp" -mindepth 1 -print -quit)" ]]

# Release installation preserves production root configuration; development synchronization must not touch it either.
cmp -s "$preserved_root_settings" "$formal_root_config_dir/settings.json"
cmp -s "$preserved_root_dotenv" "$formal_root_config_dir/.env"
[[ "$(find "$formal_root_config_dir" -mindepth 1 -maxdepth 1 -type f | wc -l)" -eq 2 ]]
[[ "$(stat -c '%a' "$formal_root_config_dir/settings.json")" == "600" ]]
if [[ "$current_user" == root ]]; then
  [[ "$(stat -c '%U' "$formal_root_config_dir/settings.json")" == root ]]
fi

if [[ "$expected_profile" == dev ]]; then
  cmp -s "$env_file" "$root_config_dir/.env"
  [[ "$(stat -c '%a' "$root_config_dir/.env")" == "600" ]]
  [[ "$(grep -c "args=config migrate " "$cli_log")" -eq 1 ]]
  [[ "$(grep -c "args=config import --scope user --file $repo_dir/crates/kcoder_config/setting_dev_user.jsonc " "$cli_log")" -eq 1 ]]
  for setting in \
    'providers.kunlunmeta.endpoint http://127.0.0.1:8000' \
    'providers.kunlunmeta.no_proxy true' \
    'base_url http://127.0.0.1:8000' \
    'provider_no_proxy true'; do
    [[ "$(grep -c "args=config set --scope user $setting " "$cli_log")" -eq 1 ]]
  done
  [[ "$(grep -c "args=auth login --provider kunlunmeta --env-file $env_file " "$cli_log")" -eq 1 ]]
  grep -q "kcoder_home=$root_config_dir config=$root_config_dir args=auth login --provider kunlunmeta" "$cli_log"
else
  cmp -s "$preserved_root_settings" "$root_config_dir/settings.json"
  [[ "$(stat -c '%a' "$root_config_dir/settings.json")" == "600" ]]
  ! grep -q 'args=config\|args=auth login' "$cli_log"
  ! grep -q 'config/development' <<<"$output"
fi
if grep -Eq 'args=auth login --provider (anthropic|kimi|openai)' "$cli_log"; then
  echo "installer imported a non-KunlunMeta dotenv credential" >&2
  exit 1
fi
grep -q "Built $variant binary" <<<"$output"
grep -q 'Installed root command' <<<"$output"

if [[ "$expected_profile" == dev ]]; then
  expect_dev_config_rejection() {
    local label="$1" rejected_root_config="$2" expected_error="$3"
    local rejection_dir="$tmp/rejection-$label"
    local rejection_output="$rejection_dir/output.log"
    mkdir -p "$rejection_dir/system" "$rejection_dir/probes"
    chmod 0755 "$rejection_dir" "$rejection_dir/system" "$rejection_dir/probes"
    touch "$rejection_dir/cli.log"
    chmod 0666 "$rejection_dir/cli.log"

    if env "${installer_test_env[@]}" \
      PATH="$fake_bin:$PATH" \
      TMPDIR="$rejection_dir/probes" \
      KCODER_SERVER_ROOT_HOME="$tmp/root" \
      KCODER_SERVER_ROOT_COMMAND="$rejection_dir/system/kcoder-dev" \
      KCODER_SERVER_TARGET_DIR="$rejection_dir/target" \
      KCODER_SERVER_ENV_FILE="$env_file" \
      KCODER_SERVER_ROOT_CONFIG_DIR="$rejected_root_config" \
      KCODER_SERVER_TEST_BUILD_LOG="$rejection_dir/build.log" \
      KCODER_SERVER_TEST_BUILD_PROFILE=debug \
      KCODER_SERVER_TEST_EXPECTED_BUILD_ARGS='build --locked' \
      KCODER_SERVER_TEST_CLI_LOG="$rejection_dir/cli.log" \
      KCODER_RIPGREP_BIN="$rg_source" \
      KCODER_SKIP_CHROME_DOWNLOAD=1 \
        "$installer" >"$rejection_output" 2>&1; then
      echo "dev installer unexpectedly accepted conflicting config paths ($label)" >&2
      exit 1
    fi
    grep -q "$expected_error" "$rejection_output"
    [[ ! -e "$rejection_dir/target" ]]
  }

  expect_dev_config_rejection \
    root-release "$formal_root_config_dir" \
    'conflicts with a release profile'
  expect_dev_config_rejection \
    nested-release "$formal_root_config_dir/dev" \
    'conflicts with a release profile'

  # Even if this negative security test regresses, it can operate only on a temporary directory. The current implementation must reject before build and retain the sentinel.
  cmp -s "$preserved_root_settings" "$formal_root_config_dir/settings.json"
fi

if env "${installer_test_env[@]}" \
  KCODER_SERVER_ROOT_HOME="$tmp/root" \
  KCODER_SERVER_ROOT_COMMAND="/usr/local/bin/not-kcoder" \
  PATH="$fake_bin:$PATH" \
    "$installer" >/dev/null 2>&1; then
  echo "installer unexpectedly allowed a root command not named kcoder" >&2
  exit 1
fi

if [[ "$expected_profile" == release ]] && env "${installer_test_env[@]}" \
  KCODER_SERVER_PROFILE=release \
  KCODER_SERVER_BUILD_PROFILE=debug \
  KCODER_SERVER_ROOT_HOME="$tmp/root" \
  PATH="$fake_bin:$PATH" \
    "$repo_dir/scripts/install/installers/cli-release-server.sh" >/dev/null 2>&1; then
  echo "installer unexpectedly allowed a release profile with a debug build" >&2
  exit 1
fi

if [[ "$current_user" != root ]]; then
  if KCODER_SERVER_TEST_ALLOW_NON_ROOT=0 \
    KCODER_SERVER_ROOT_HOME="$tmp/root" \
    PATH="$fake_bin:$PATH" \
      "$installer" >/dev/null 2>&1; then
    echo "installer unexpectedly allowed a non-root execution user" >&2
    exit 1
  fi
fi

grep -Fq '"$(id -u)" -ne 0' "$repo_dir/scripts/install/installers/cli-release-server.sh"
# The system installer maintains only root/system entry points and must not reintroduce target-user writes.
! grep -q 'KCODER_SERVER_TARGET_USER' "$repo_dir/scripts/install/installers/cli-release-server.sh"

echo "Current-server $variant source installer test passed."

if [[ -z "${KCODER_SERVER_TEST_VARIANT:-}" ]]; then
  KCODER_SERVER_TEST_VARIANT=debug "$0"
fi
