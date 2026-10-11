//! Log directory commands and existing desktop log plugin construction.

use crate::*;

#[cfg(desktop)]
pub(crate) fn app_log_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if cfg!(debug_assertions) {
        return local_executor::local_executor_log_dir_path();
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(app
            .path()
            .home_dir()
            .map_err(|error| format!("Failed to locate home directory: {error}"))?
            .join("Library")
            .join("Logs")
            .join(LOG_DIRECTORY_VENDOR_NAME)
            .join(LOG_DIRECTORY_APP_NAME));
    }

    #[cfg(target_os = "windows")]
    {
        return Ok(app
            .path()
            .local_data_dir()
            .map_err(|error| format!("Failed to locate local data directory: {error}"))?
            .join(LOG_DIRECTORY_VENDOR_NAME)
            .join(LOG_DIRECTORY_APP_NAME)
            .join("logs"));
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(app
            .path()
            .data_dir()
            .map_err(|error| format!("Failed to locate data directory: {error}"))?
            .join(LOG_DIRECTORY_VENDOR_NAME)
            .join(LOG_DIRECTORY_APP_NAME)
            .join("logs"));
    }

    #[allow(unreachable_code)]
    app.path()
        .app_log_dir()
        .map_err(|error| format!("Failed to locate app log directory: {error}"))
}

#[cfg(desktop)]
pub(crate) fn create_log_plugin(
    app: &tauri::AppHandle,
) -> Result<tauri::plugin::TauriPlugin<tauri::Wry>, String> {
    let log_directory = app_log_directory(app)?;
    let process_id = std::process::id();
    let rust_log_file_name = format!("{RUST_LOG_FILE_NAME}-{process_id}");
    let webview_log_file_name = format!("{WEBVIEW_LOG_FILE_NAME}-{process_id}");
    Ok(tauri_plugin_log::Builder::default()
        .clear_targets()
        .level(if cfg!(debug_assertions) {
            log::LevelFilter::Trace
        } else {
            log::LevelFilter::Info
        })
        .target(
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: log_directory.clone(),
                file_name: Some(rust_log_file_name),
            })
            .filter(|metadata| {
                !metadata
                    .target()
                    .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
            }),
        )
        .target(
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                path: log_directory,
                file_name: Some(webview_log_file_name),
            })
            .filter(|metadata| {
                metadata
                    .target()
                    .starts_with(tauri_plugin_log::WEBVIEW_TARGET)
            }),
        )
        .build())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn get_app_log_directory(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app_log_directory(&app)?.to_string_lossy().to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn open_app_log_directory(app: tauri::AppHandle) -> Result<(), String> {
    let log_directory = app_log_directory(&app)?;
    std::fs::create_dir_all(&log_directory)
        .map_err(|error| format!("Failed to create app log directory: {error}"))?;

    #[cfg(target_os = "macos")]
    let output = std::process::Command::new("open")
        .arg(&log_directory)
        .output()
        .map_err(|error| format!("Failed to run macOS open command: {error}"))?;

    #[cfg(target_os = "windows")]
    let output = std::process::Command::new("explorer")
        .arg(&log_directory)
        .output()
        .map_err(|error| format!("Failed to run Windows explorer command: {error}"))?;

    #[cfg(target_os = "linux")]
    let output = std::process::Command::new("xdg-open")
        .arg(&log_directory)
        .output()
        .map_err(|error| format!("Failed to run xdg-open command: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err("Failed to open app log directory".to_string())
    } else {
        Err(stderr)
    }
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn get_app_log_directory(_app: tauri::AppHandle) -> Result<String, String> {
    Err("App log directory is only available on desktop".to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn open_app_log_directory(_app: tauri::AppHandle) -> Result<(), String> {
    Err("App log directory is only available on desktop".to_string())
}

#[cfg(desktop)]
pub(crate) fn env_flag_enabled(key: &str) -> bool {
    std::env::var(key)
        .ok()
        .and_then(normalized_non_empty)
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
}
