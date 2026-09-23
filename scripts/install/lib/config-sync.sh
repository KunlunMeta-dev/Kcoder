#!/usr/bin/env bash

# User-profile configuration synchronization shared by installers and source launchers.

kcoder_sync_development_config() {
  local settings="$KCODER_REPO_DIR/crates/kcoder_config/setting_dev_user.jsonc"
  local env_file="$KCODER_REPO_DIR/.env"
  local sync_cwd="$KCODER_REPO_DIR"
  local user_settings_dir="${KCODER_CONFIG_DIR:-$KCODER_HOME}"

  [[ -f "$settings" ]] || {
    echo "缺少开发配置源文件：$settings" >&2
    return 1
  }
  mkdir -p "$user_settings_dir"
  # Development settings from the checkout are the sole source for this profile; replace only the development user layer.
  rm -f "$user_settings_dir/settings.json"

  "$KCODER_REAL_BIN" --cwd "$sync_cwd" config migrate >/dev/null
  "$KCODER_REAL_BIN" --cwd "$sync_cwd" \
    config import --scope user --file "$settings" >/dev/null
  if [[ -f "$env_file" ]]; then
    "$KCODER_REAL_BIN" --cwd "$sync_cwd" \
      auth login --provider kunlunmeta --env-file "$env_file" >/dev/null
  fi
}
