//! Native clipboard/drop path inspection without reading file contents.

use crate::*;

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn workspace_paths_from_macos_pasteboard(
    pasteboard: &objc2_app_kit::NSPasteboard,
) -> Result<Vec<PickedWorkspacePath>, String> {
    use objc2::{runtime::AnyClass, ClassType};
    use objc2_foundation::{NSArray, NSURL};

    let classes = NSArray::<AnyClass>::arrayWithObject(NSURL::class());
    let Some(values) = (unsafe { pasteboard.readObjectsForClasses_options(&classes, None) }) else {
        return Ok(Vec::new());
    };
    let mut raw_paths = Vec::new();
    for value in values {
        let url = value
            .downcast::<NSURL>()
            .map_err(|_| "The macOS clipboard contains an invalid file URL".to_string())?;
        if let Some(path) = url.path() {
            raw_paths.push(path.to_string());
        }
    }

    Ok(inspect_workspace_path_candidates(raw_paths))
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn clipboard_workspace_paths_on_macos() -> Result<Vec<PickedWorkspacePath>, String> {
    let pasteboard = objc2_app_kit::NSPasteboard::generalPasteboard();
    workspace_paths_from_macos_pasteboard(&pasteboard)
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn dropped_workspace_paths_on_macos() -> Result<Vec<PickedWorkspacePath>, String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};

    let pasteboard = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
    workspace_paths_from_macos_pasteboard(&pasteboard)
}

#[tauri::command]
pub(crate) async fn read_clipboard_workspace_paths(
    app: tauri::AppHandle,
    fallback_paths: Option<Vec<String>>,
) -> Result<Vec<PickedWorkspacePath>, String> {
    let fallback_paths = fallback_paths.unwrap_or_default();

    #[cfg(all(desktop, target_os = "macos"))]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(clipboard_workspace_paths_on_macos());
        })
        .map_err(|error| format!("Failed to inspect the macOS clipboard: {error}"))?;
        let native_paths = tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv()
                .map_err(|_| "The macOS clipboard inspection stopped unexpectedly".to_string())?
        })
        .await
        .map_err(|error| format!("Failed to join clipboard inspection: {error}"))??;
        let mut paths = native_paths
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();
        paths.extend(fallback_paths);
        Ok(inspect_workspace_path_candidates(paths))
    }

    #[cfg(not(all(desktop, target_os = "macos")))]
    {
        let _ = app;
        Ok(inspect_workspace_path_candidates(fallback_paths))
    }
}

#[tauri::command]
pub(crate) async fn read_dropped_workspace_paths(
    app: tauri::AppHandle,
    fallback_paths: Option<Vec<String>>,
) -> Result<Vec<PickedWorkspacePath>, String> {
    let fallback_paths = fallback_paths.unwrap_or_default();

    #[cfg(all(desktop, target_os = "macos"))]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(dropped_workspace_paths_on_macos());
        })
        .map_err(|error| format!("Failed to inspect the macOS drag pasteboard: {error}"))?;
        let native_paths = tauri::async_runtime::spawn_blocking(move || {
            receiver.recv().map_err(|_| {
                "The macOS drag pasteboard inspection stopped unexpectedly".to_string()
            })?
        })
        .await
        .map_err(|error| format!("Failed to join drag pasteboard inspection: {error}"))??;
        let mut paths = native_paths
            .into_iter()
            .map(|entry| entry.path)
            .collect::<Vec<_>>();
        paths.extend(fallback_paths);
        Ok(inspect_workspace_path_candidates(paths))
    }

    #[cfg(not(all(desktop, target_os = "macos")))]
    {
        let _ = app;
        Ok(inspect_workspace_path_candidates(fallback_paths))
    }
}
