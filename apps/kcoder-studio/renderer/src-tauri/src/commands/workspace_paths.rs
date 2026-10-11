//! Workspace candidate inspection and platform-native pickers.

use crate::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickedWorkspacePath {
    pub(crate) path: String,
    pub(crate) is_directory: bool,
}

pub(crate) fn inspect_workspace_path_candidates(paths: Vec<String>) -> Vec<PickedWorkspacePath> {
    let mut selected = Vec::new();
    let mut seen = HashSet::new();

    for raw_path in paths {
        let path = raw_path.trim();
        if path.is_empty() {
            continue;
        }
        let path = std::path::PathBuf::from(path);
        if !path.exists() {
            continue;
        }
        let normalized = path.to_string_lossy().into_owned();
        if !seen.insert(normalized.clone()) {
            continue;
        }
        selected.push(PickedWorkspacePath {
            is_directory: path.is_dir(),
            path: normalized,
        });
    }

    selected
}

#[tauri::command]
pub(crate) fn inspect_workspace_paths(paths: Vec<String>) -> Vec<PickedWorkspacePath> {
    inspect_workspace_path_candidates(paths)
}

#[cfg(all(desktop, target_os = "macos"))]
pub(crate) fn pick_workspace_paths_on_macos(
    initial_directory: Option<String>,
    directories_only: bool,
    multiple: bool,
) -> Result<Vec<PickedWorkspacePath>, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSModalResponseOK, NSOpenPanel};
    use objc2_foundation::{NSString, NSURL};

    let main_thread = MainThreadMarker::new()
        .ok_or_else(|| "The workspace picker must run on the main thread".to_string())?;
    let panel = NSOpenPanel::openPanel(main_thread);
    panel.setCanChooseFiles(!directories_only);
    panel.setCanChooseDirectories(true);
    panel.setAllowsMultipleSelection(multiple);
    panel.setCanCreateDirectories(true);
    if let Some(directory) = initial_directory.filter(|path| !path.trim().is_empty()) {
        let directory = NSString::from_str(&directory);
        let url = NSURL::fileURLWithPath_isDirectory(&directory, true);
        panel.setDirectoryURL(Some(&url));
    }
    let response = panel.runModal();
    if response != NSModalResponseOK {
        return Ok(Vec::new());
    }

    let mut selected = Vec::new();
    for url in panel.URLs() {
        let Some(path) = url.path() else {
            continue;
        };
        let path = path.to_string();
        selected.push(PickedWorkspacePath {
            is_directory: std::path::Path::new(&path).is_dir(),
            path,
        });
    }
    Ok(selected)
}

#[tauri::command]
pub(crate) async fn pick_workspace_paths(
    app: tauri::AppHandle,
    initial_directory: Option<String>,
    directories_only: Option<bool>,
    multiple: Option<bool>,
    default_to_home: Option<bool>,
) -> Result<Vec<PickedWorkspacePath>, String> {
    let directories_only = directories_only.unwrap_or(false);
    let multiple = multiple.unwrap_or(true);
    let initial_directory = initial_directory
        .filter(|path| !path.trim().is_empty())
        .or_else(|| {
            default_to_home
                .unwrap_or(false)
                .then(|| app.path().home_dir().ok())
                .flatten()
                .map(|path| path.to_string_lossy().into_owned())
        });

    #[cfg(all(desktop, target_os = "macos"))]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(pick_workspace_paths_on_macos(
                initial_directory,
                directories_only,
                multiple,
            ));
        })
        .map_err(|error| format!("Failed to open the workspace picker: {error}"))?;
        tauri::async_runtime::spawn_blocking(move || {
            receiver
                .recv()
                .map_err(|_| "Workspace picker closed unexpectedly".to_string())?
        })
        .await
        .map_err(|error| format!("Failed to join workspace picker task: {error}"))?
    }

    #[cfg(not(all(desktop, target_os = "macos")))]
    {
        use tauri_plugin_dialog::DialogExt;

        let mut picker = app.dialog().file();
        if let Some(directory) = initial_directory {
            picker = picker.set_directory(directory);
        }
        let files = tauri::async_runtime::spawn_blocking(move || {
            if directories_only {
                if multiple {
                    picker.blocking_pick_folders().unwrap_or_default()
                } else {
                    picker.blocking_pick_folder().into_iter().collect()
                }
            } else if multiple {
                picker.blocking_pick_files().unwrap_or_default()
            } else {
                picker.blocking_pick_file().into_iter().collect()
            }
        })
        .await
        .map_err(|error| format!("Failed to join workspace picker task: {error}"))?;
        return Ok(files
            .into_iter()
            .filter_map(|file| file.into_path().ok())
            .map(|path| PickedWorkspacePath {
                is_directory: path.is_dir(),
                path: path.to_string_lossy().into_owned(),
            })
            .collect());
    }
}
