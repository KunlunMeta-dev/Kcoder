//! WebView inspection commands and platform capability boundaries.

use crate::*;

#[cfg(all(desktop, any(debug_assertions, feature = "release-devtools")))]
pub(crate) fn open_main_webview_devtools_impl(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| format!("WebView window '{MAIN_WINDOW_LABEL}' was not found"))?;
    #[cfg(target_os = "macos")]
    make_webview_inspectable(&window)?;
    window.open_devtools();
    Ok(())
}

#[cfg(all(
    target_os = "macos",
    any(debug_assertions, feature = "release-devtools")
))]
pub(crate) fn make_webview_inspectable(window: &tauri::WebviewWindow) -> Result<(), String> {
    use objc2::{msg_send, runtime::AnyObject, sel};

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |platform_webview| {
            let supported = unsafe {
                let webview: &AnyObject = &*platform_webview.inner().cast();
                let supported: bool = msg_send![webview, respondsToSelector: sel!(setInspectable:)];
                if supported {
                    let _: () = msg_send![webview, setInspectable: true];
                }
                supported
            };
            let _ = sender.send(supported);
        })
        .map_err(|error| format!("Failed to access main WebView: {error}"))?;

    match receiver.recv() {
        Ok(true) => Ok(()),
        Ok(false) => Err("Web Inspector requires macOS 13.3 or newer".to_string()),
        Err(error) => Err(format!("Failed to enable Web Inspector: {error}")),
    }
}

#[cfg(all(desktop, not(any(debug_assertions, feature = "release-devtools"))))]
pub(crate) fn open_main_webview_devtools_impl(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("Web Inspector is only available in debug builds or release-devtools builds".to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn open_main_webview_devtools(app: tauri::AppHandle) -> Result<(), String> {
    open_main_webview_devtools_impl(&app)
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn open_main_webview_devtools(_app: tauri::AppHandle) -> Result<(), String> {
    Err("Web Inspector is only available on desktop".to_string())
}
