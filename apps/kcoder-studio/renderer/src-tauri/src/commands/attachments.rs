//! Dropped-file reads, downloads and executor-scoped attachment staging.

use crate::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DroppedFilePayload {
    pub(crate) name: String,
    pub(crate) relative_path: String,
    pub(crate) bytes: Vec<u8>,
}

pub(crate) fn collect_selected_files(
    path: &std::path::Path,
    relative_path: &std::path::Path,
    files: &mut Vec<DroppedFilePayload>,
) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("Failed to inspect selected path: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    if metadata.is_dir() {
        let entries = std::fs::read_dir(path)
            .map_err(|error| format!("Failed to read selected directory: {error}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
            collect_selected_files(&entry.path(), &relative_path.join(entry.file_name()), files)?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Ok(());
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(String::from)
        .ok_or_else(|| "Selected file name is invalid".to_string())?;
    let relative_path = relative_path
        .to_str()
        .map(|value| value.replace('\\', "/"))
        .ok_or_else(|| "Selected file path is invalid".to_string())?;
    let bytes = std::fs::read(path)
        .map_err(|error| format!("Failed to read selected file {name}: {error}"))?;
    files.push(DroppedFilePayload {
        name,
        relative_path,
        bytes,
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn read_dropped_files(paths: Vec<String>) -> Result<Vec<DroppedFilePayload>, String> {
    let mut files = Vec::new();

    for raw_path in paths {
        let Some(path) = normalized_non_empty(raw_path) else {
            continue;
        };
        let path = std::path::PathBuf::from(path);
        if !path.exists() {
            continue;
        }
        let root_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Selected path name is invalid".to_string())?;
        collect_selected_files(&path, std::path::Path::new(root_name), &mut files)?;
    }

    Ok(files)
}

pub(crate) fn sanitized_download_filename(filename: &str, fallback: &std::path::Path) -> String {
    let raw = normalized_non_empty(filename.to_string()).or_else(|| {
        fallback
            .file_name()
            .and_then(|value| value.to_str())
            .map(String::from)
    });

    let sanitized = raw
        .unwrap_or_else(|| "image".to_string())
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();

    if sanitized.is_empty() {
        "image".to_string()
    } else {
        sanitized
    }
}

pub(crate) fn unique_download_path(
    directory: &std::path::Path,
    filename: &str,
) -> std::path::PathBuf {
    let candidate = directory.join(filename);
    if !candidate.exists() {
        return candidate;
    }

    let path = std::path::Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    let extension = path.extension().and_then(|value| value.to_str());

    for index in 1..1000 {
        let filename = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = directory.join(filename);
        if !candidate.exists() {
            return candidate;
        }
    }

    directory.join(filename)
}

#[cfg(target_os = "macos")]
pub(crate) fn notify_download_finished(path: &std::path::Path) {
    use objc2_foundation::{NSDistributedNotificationCenter, NSString};

    let notification_name = NSString::from_str("com.apple.DownloadFileFinished");
    let file_path = NSString::from_str(&path.to_string_lossy());
    unsafe {
        NSDistributedNotificationCenter::defaultCenter()
            .postNotificationName_object(&notification_name, Some(&file_path));
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn notify_download_finished(_path: &std::path::Path) {}

#[tauri::command]
pub(crate) fn download_local_file_to_downloads(
    app: tauri::AppHandle,
    source_path: String,
    filename: String,
) -> Result<String, String> {
    let Some(source_path) = normalized_non_empty(source_path) else {
        return Err("Source path is empty".to_string());
    };

    let source_path = std::path::PathBuf::from(source_path);
    if !source_path.is_file() {
        return Err("Source file does not exist".to_string());
    }

    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Failed to locate Downloads directory: {error}"))?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("Failed to create Downloads directory: {error}"))?;

    let filename = sanitized_download_filename(&filename, &source_path);
    let target_path = unique_download_path(&downloads_dir, &filename);
    std::fs::copy(&source_path, &target_path)
        .map_err(|error| format!("Failed to copy file to Downloads: {error}"))?;
    notify_download_finished(&target_path);

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub(crate) fn save_text_file_to_downloads(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    if content.is_empty() {
        return Err("File content is empty".to_string());
    }

    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|error| format!("Failed to locate Downloads directory: {error}"))?;
    std::fs::create_dir_all(&downloads_dir)
        .map_err(|error| format!("Failed to create Downloads directory: {error}"))?;

    let filename = sanitized_download_filename(&filename, std::path::Path::new("plan.md"));
    let target_path = unique_download_path(&downloads_dir, &filename);
    std::fs::write(&target_path, content)
        .map_err(|error| format!("Failed to save file to Downloads: {error}"))?;
    notify_download_finished(&target_path);

    Ok(target_path.to_string_lossy().to_string())
}

pub(crate) fn default_executor_home(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(home) = std::env::var("WEGENT_EXECUTOR_HOME") {
        if let Some(home) = normalized_non_empty(home) {
            return Ok(std::path::PathBuf::from(home));
        }
    }

    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Failed to locate home directory: {error}"))?;
    Ok(home.join(".wegent-executor"))
}

pub(crate) fn executor_home_attachment_root(executor_home: &std::path::Path) -> std::path::PathBuf {
    executor_home
        .join("workspace")
        .join("attachments")
        .join("draft")
}

pub(crate) fn local_attachment_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(executor_home_attachment_root(&default_executor_home(app)?))
}

pub(crate) fn unique_attachment_directory(
    root: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock is before UNIX epoch: {error}"))?
        .as_millis();

    for index in 0..1000 {
        let directory_name = if index == 0 {
            millis.to_string()
        } else {
            format!("{millis}-{index}")
        };
        let directory = root.join(directory_name);
        if !directory.exists() {
            return Ok(directory);
        }
    }

    Err("Failed to allocate attachment directory".to_string())
}

#[tauri::command]
pub(crate) fn save_local_attachment_file(
    app: tauri::AppHandle,
    _workspace_path: Option<String>,
    filename: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("Attachment file is empty".to_string());
    }

    let root = local_attachment_root(&app)?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create attachment directory: {error}"))?;
    let directory = unique_attachment_directory(&root)?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Failed to create attachment directory: {error}"))?;

    let filename = sanitized_download_filename(&filename, std::path::Path::new("attachment"));
    let target_path = unique_download_path(&directory, &filename);
    std::fs::write(&target_path, bytes)
        .map_err(|error| format!("Failed to save attachment file: {error}"))?;

    Ok(target_path.to_string_lossy().to_string())
}
