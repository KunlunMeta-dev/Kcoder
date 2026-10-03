//! Native window, tray, logging, and preference constants.

#[cfg(desktop)]
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
pub(crate) const TRAY_OPEN_SETTINGS_EVENT: &str = "kcoder-tray-open-settings";
#[cfg(desktop)]
pub(crate) const TRAY_OPEN_TASK_EVENT: &str = "kcoder-tray-open-task";
#[cfg(desktop)]
pub(crate) const LOCAL_WORKSPACE_OPEN_REQUESTED_EVENT: &str =
    "kcoder-open-local-workspace-requested";
#[cfg(desktop)]
pub(crate) const CLOSE_TO_TRAY_HINT_REQUESTED_EVENT: &str = "kcoder-close-to-tray-hint-requested";
#[cfg(desktop)]
pub(crate) const TRAY_MENU_OPEN_ID: &str = "open";
#[cfg(desktop)]
pub(crate) const TRAY_MENU_SETTINGS_ID: &str = "settings";
#[cfg(desktop)]
pub(crate) const TRAY_MENU_QUIT_ID: &str = "quit";
#[cfg(desktop)]
pub(crate) const TRAY_MENU_TASK_PREFIX: &str = "task:";

#[cfg(desktop)]
pub(crate) const TRAY_ID: &str = "wework-main";
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_ICON_HEIGHT: u32 = 22;
#[cfg(all(desktop, target_os = "macos"))]
pub(crate) const TRAY_STATUS_ICON_SIZE: u32 = TRAY_USAGE_ICON_HEIGHT;
#[cfg(all(desktop, not(target_os = "macos")))]
pub(crate) const TRAY_STATUS_ICON_SIZE: u32 = 32;
#[cfg(all(desktop, target_os = "windows"))]
pub(crate) const WINDOWS_TRAY_ICON_BYTES: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icons/128x128.png"));
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_ICON_LEFT_PADDING: u32 = 0;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_ICON_TEXT_GAP: u32 = 2;
#[cfg(desktop)]
pub(crate) const TRAY_STATUS_METER_WIDTH: u32 = 7;
#[cfg(desktop)]
pub(crate) const TRAY_STATUS_METER_GAP: u32 = 6;
#[cfg(desktop)]
pub(crate) const TRAY_STATUS_METER_TEXT_GAP_OFFSET: u32 = 2;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_TEXT_LEFT_EXTRA_GAP: u32 = 2;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_ICON_SCALE: u32 = 2;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_GLYPH_WIDTH: u32 = 3;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_GLYPH_HEIGHT: u32 = 5;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_GLYPH_GAP: u32 = 1;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_SPACE_WIDTH: u32 = 1;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_LINE_GAP: u32 = 2;
#[cfg(desktop)]
pub(crate) const TRAY_USAGE_MAX_LINE: &str = "7d 100%";
#[cfg(desktop)]
pub(crate) const FRONTEND_RESUME_PROBE_FUNCTION: &str = "__KCODER_STUDIO_NATIVE_RESUME_PROBE__";
#[cfg(desktop)]
pub(crate) const FRONTEND_RESUME_PROBE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(5);
#[cfg(desktop)]
pub(crate) const FRONTEND_RESUME_MIN_UNFOCUSED_DURATION: std::time::Duration =
    std::time::Duration::from_secs(60);
#[cfg(desktop)]
pub(crate) const MAIN_WINDOW_RECREATE_DELAY: std::time::Duration =
    std::time::Duration::from_millis(100);
#[cfg(desktop)]
pub(crate) const LOG_DIRECTORY_APP_NAME: &str = "Wework";
#[cfg(desktop)]
pub(crate) const LOG_DIRECTORY_VENDOR_NAME: &str = "Wegent";
#[cfg(desktop)]
pub(crate) const RUST_LOG_FILE_NAME: &str = "wework-tauri";
#[cfg(desktop)]
pub(crate) const WEBVIEW_LOG_FILE_NAME: &str = "wework-frontend";
#[cfg(desktop)]
pub(crate) const WEBVIEW_DEVTOOLS_ENV: &str = "KCODER_STUDIO_WEBVIEW_DEVTOOLS";
#[cfg(desktop)]
pub(crate) const APP_PREFERENCES_FILE_NAME: &str = "app-preferences.json";
#[cfg(all(desktop, target_os = "macos"))]
pub(crate) const KCODER_STUDIO_CLI_INSTALL_DIR: &str = ".local/bin";
#[cfg(all(desktop, target_os = "macos"))]
pub(crate) const KCODER_STUDIO_CLI_INSTALL_NAME: &str = "kcoder-studio";
#[cfg(all(desktop, target_os = "macos"))]
pub(crate) const KCODER_STUDIO_CLI_MANAGED_MARKER: &str = "# Wework CLI launcher";
