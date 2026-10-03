//! Managed CLI launcher creation and platform-specific installation.

#[cfg(target_os = "macos")]
use crate::*;

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn macos_app_bundle_for_executable(
    executable_path: &std::path::Path,
) -> Option<std::path::PathBuf> {
    executable_path
        .ancestors()
        .find(|path| path.extension().is_some_and(|extension| extension == "app"))
        .map(std::path::Path::to_path_buf)
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn studio_cli_launcher_content(
    executable_path: &std::path::Path,
    app_bundle_path: Option<&std::path::Path>,
) -> String {
    let executable = shell_single_quote(&executable_path.to_string_lossy());
    let app_bundle = app_bundle_path
        .map(|path| shell_single_quote(&path.to_string_lossy()))
        .unwrap_or_else(|| "''".to_string());
    // Debug `tauri dev` sets KCODER_STUDIO_EXECUTOR_SIDECAR to the source-tree sidecar script.
    // CLI launches are a fresh process without that env; bake the absolute path into the
    // launcher so `wework <path>` can start a healthy local executor outside `dev:mac`.
    let executor_sidecar = std::env::var_os("KCODER_STUDIO_EXECUTOR_SIDECAR")
        .map(std::path::PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .and_then(|path| {
            if path.is_absolute() {
                Some(path)
            } else {
                std::env::current_dir().ok().map(|cwd| cwd.join(path))
            }
        })
        .map(|path| shell_single_quote(&path.to_string_lossy()))
        .unwrap_or_else(|| "''".to_string());

    format!(
        r#"#!/usr/bin/env bash
{KCODER_STUDIO_CLI_MANAGED_MARKER}

set -euo pipefail

usage() {{
  cat <<'EOF'
Usage: kcoder-studio [path]

Open a local workspace in the KCoder Studio desktop app.

Examples:
  kcoder-studio
  kcoder-studio .
  kcoder-studio ~/projects/my-app
EOF
}}

if [ "${{1:-}}" = "-h" ] || [ "${{1:-}}" = "--help" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 1 ]; then
  echo "kcoder-studio: expected at most one path argument" >&2
  usage >&2
  exit 2
fi

TARGET_PATH="${{1:-.}}"

if [ ! -e "$TARGET_PATH" ]; then
  echo "kcoder-studio: path does not exist: $TARGET_PATH" >&2
  exit 1
fi

if [ ! -d "$TARGET_PATH" ]; then
  echo "kcoder-studio: path is not a directory: $TARGET_PATH" >&2
  exit 1
fi

ABSOLUTE_PATH="$(cd "$TARGET_PATH" && pwd -P)"
APP_BUNDLE={app_bundle}
KCODER_STUDIO_EXECUTABLE={executable}
KCODER_STUDIO_EXECUTOR_SIDECAR={executor_sidecar}

if [ -n "$KCODER_STUDIO_EXECUTOR_SIDECAR" ]; then
  export KCODER_STUDIO_EXECUTOR_SIDECAR
fi

if [ -x "$KCODER_STUDIO_EXECUTABLE" ]; then
  "$KCODER_STUDIO_EXECUTABLE" --open-workspace "$ABSOLUTE_PATH" >/dev/null 2>&1 &
  exit 0
fi

if [ -n "$APP_BUNDLE" ] && [ -d "$APP_BUNDLE" ]; then
  exec open "$APP_BUNDLE" --args --open-workspace "$ABSOLUTE_PATH"
fi

echo "kcoder-studio: unable to locate KCoder Studio app executable" >&2
exit 1
"#
    )
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn can_replace_studio_cli_path(path: &std::path::Path) -> Result<bool, String> {
    if let Ok(target) = std::fs::read_link(path) {
        let target_text = target.to_string_lossy();
        return Ok(target_text.contains("wework")
            || target_text.contains("WeWork")
            || target_text.contains("kcoder-studio"));
    }

    if !path.exists() {
        return Ok(true);
    }

    let content = std::fs::read_to_string(path)
        .map_err(|error| format!("Failed to inspect existing Wework CLI file: {error}"))?;
    Ok(content.contains(KCODER_STUDIO_CLI_MANAGED_MARKER))
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn install_studio_cli_impl(
    home_dir: &std::path::Path,
    executable_path: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let install_dir = home_dir.join(KCODER_STUDIO_CLI_INSTALL_DIR);
    std::fs::create_dir_all(&install_dir)
        .map_err(|error| format!("Failed to create Wework CLI install directory: {error}"))?;
    let installed_path = install_dir.join(KCODER_STUDIO_CLI_INSTALL_NAME);

    if !can_replace_studio_cli_path(&installed_path)? {
        return Err(format!(
            "Wework CLI install path already exists and is not managed by Wework: {}",
            installed_path.display()
        ));
    }

    if installed_path.exists() || std::fs::symlink_metadata(&installed_path).is_ok() {
        std::fs::remove_file(&installed_path)
            .map_err(|error| format!("Failed to replace existing Wework CLI file: {error}"))?;
    }

    let app_bundle = macos_app_bundle_for_executable(executable_path);
    let content = studio_cli_launcher_content(executable_path, app_bundle.as_deref());
    std::fs::write(&installed_path, content)
        .map_err(|error| format!("Failed to write Wework CLI launcher: {error}"))?;
    let mut permissions = std::fs::metadata(&installed_path)
        .map_err(|error| format!("Failed to inspect Wework CLI launcher: {error}"))?
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&installed_path, permissions)
        .map_err(|error| format!("Failed to make Wework CLI executable: {error}"))?;

    Ok(installed_path)
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn install_studio_cli_link(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    let home_dir = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to locate home directory: {error}"))?;
    let executable_path = std::env::current_exe()
        .map_err(|error| format!("Failed to locate Wework executable: {error}"))?;
    install_studio_cli_impl(&home_dir, &executable_path)
}

#[cfg(all(desktop, not(target_os = "macos")))]
pub(crate) fn install_studio_cli_link(
    _app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    Err("Wework CLI installation is only available on macOS".to_string())
}

#[cfg(not(desktop))]
pub(crate) fn install_studio_cli_link(
    _app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, String> {
    Err("Wework CLI installation is only available on desktop".to_string())
}

#[tauri::command]
pub(crate) fn install_studio_cli(app: tauri::AppHandle) -> Result<String, String> {
    install_studio_cli_link(&app).map(|path| path.to_string_lossy().to_string())
}
