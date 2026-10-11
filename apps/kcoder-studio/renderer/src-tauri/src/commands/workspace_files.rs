//! Local path/open/reveal handlers and native file opener metadata.

use crate::*;

#[tauri::command]
pub(crate) fn local_path_exists(path: String) -> bool {
    let Some(path) = normalized_non_empty(path) else {
        return false;
    };

    std::path::Path::new(&path).exists()
}

#[tauri::command]
pub(crate) fn get_local_path_kind(path: String) -> Option<&'static str> {
    let path = normalized_non_empty(path)?;
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.is_dir() {
        Some("directory")
    } else if metadata.is_file() {
        Some("file")
    } else {
        Some("other")
    }
}

pub(crate) fn local_workspace_opener_app_name(opener: &str) -> Option<&'static str> {
    match opener {
        "vscode" => Some("Visual Studio Code"),
        "vscode-insiders" => Some("Visual Studio Code - Insiders"),
        "cursor" => Some("Cursor"),
        "sublime-text" => Some("Sublime Text"),
        "windsurf" => Some("Windsurf"),
        "finder" => Some("Finder"),
        "terminal" => Some("Terminal"),
        "iterm2" => Some("iTerm"),
        "ghostty" => Some("Ghostty"),
        "warp" => Some("Warp"),
        "xcode" => Some("Xcode"),
        "android-studio" => Some("Android Studio"),
        "intellij-idea" => Some("IntelliJ IDEA"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn open_local_workspace_with_app(app_name: &str, path: &str) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .args(["-a", app_name, path])
        .output()
        .map_err(|error| format!("Failed to run macOS open command: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("Failed to open workspace with {app_name}"))
    } else {
        Err(stderr)
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn open_local_workspace_with_app(_app_name: &str, _path: &str) -> Result<(), String> {
    Err("Opening a local workspace is only supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn open_local_file_with_default_app(path: &str) -> Result<(), String> {
    let output = std::process::Command::new("open")
        .arg(path)
        .output()
        .map_err(|error| format!("Failed to run macOS open command: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err("Failed to open local file".to_string())
    } else {
        Err(stderr)
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn open_local_file_with_default_app(_path: &str) -> Result<(), String> {
    Err("Opening a local file is only supported on macOS".to_string())
}

#[tauri::command]
pub(crate) fn open_local_workspace(opener: String, path: String) -> Result<(), String> {
    let opener =
        normalized_non_empty(opener).ok_or_else(|| "Workspace opener is empty".to_string())?;
    let path = normalized_non_empty(path).ok_or_else(|| "Workspace path is empty".to_string())?;
    let app_name = local_workspace_opener_app_name(&opener)
        .ok_or_else(|| format!("Unsupported workspace opener: {opener}"))?;

    if !std::path::Path::new(&path).exists() {
        return Err("Workspace path does not exist".to_string());
    }

    open_local_workspace_with_app(app_name, &path)
}

#[tauri::command]
pub(crate) fn open_local_file(path: String) -> Result<(), String> {
    let path = normalized_non_empty(path).ok_or_else(|| "Local file path is empty".to_string())?;

    if !std::path::Path::new(&path).exists() {
        return Err("Local path does not exist".to_string());
    }

    open_local_file_with_default_app(&path)
}

#[tauri::command]
pub(crate) fn reveal_local_file(path: String) -> Result<(), String> {
    let path = normalized_non_empty(path).ok_or_else(|| "Local file path is empty".to_string())?;
    if !std::path::Path::new(&path).exists() {
        return Err("Local path does not exist".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .args(["-R", &path])
            .status()
            .map_err(|error| format!("Failed to reveal local file: {error}"))?;
        if !status.success() {
            return Err("Failed to reveal local file".to_string());
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    Err("Revealing local files is only supported on macOS".to_string())
}

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct LocalFileOpener {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) icon_path: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct LocalFileOpeners {
    pub(crate) default_path: Option<String>,
    pub(crate) applications: Vec<LocalFileOpener>,
}

#[cfg(target_os = "macos")]
pub(crate) fn local_file_openers(path: &str) -> Result<LocalFileOpeners, String> {
    const SCRIPT: &str = r#"
ObjC.import('AppKit');
const args = $.NSProcessInfo.processInfo.arguments;
const filePath = ObjC.unwrap(args.objectAtIndex(args.count - 1));
const fileUrl = $.NSURL.fileURLWithPath(filePath);
const workspace = $.NSWorkspace.sharedWorkspace;
const defaultApplication = workspace.URLForApplicationToOpenURL(fileUrl);
const applications = workspace.URLsForApplicationsToOpenURL(fileUrl);
const result = {
  default_path: defaultApplication ? ObjC.unwrap(defaultApplication.path) : null,
  applications: []
};
function iconPath(applicationPath) {
  try {
    const bundle = $.NSBundle.bundleWithPath(applicationPath);
    const iconFile = ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleIconFile'));
    if (!iconFile) return null;
    const iconName = iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`;
    return `${applicationPath}/Contents/Resources/${iconName}`;
  } catch (_) {
    return null;
  }
}
for (let index = 0; index < applications.count; index += 1) {
  const application = applications.objectAtIndex(index);
  result.applications.push({
    name: ObjC.unwrap(application.lastPathComponent).replace(/\.app$/, ''),
    path: ObjC.unwrap(application.path),
    icon_path: iconPath(ObjC.unwrap(application.path))
  });
}
JSON.stringify(result);
"#;
    let output = std::process::Command::new("osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT, "--", path])
        .output()
        .map_err(|error| format!("Failed to query local file applications: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Failed to decode local file applications: {error}"))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn local_file_openers(_path: &str) -> Result<LocalFileOpeners, String> {
    Err("Listing local file applications is only supported on macOS".to_string())
}

#[tauri::command]
pub(crate) fn list_local_file_openers(path: String) -> Result<LocalFileOpeners, String> {
    let path = normalized_non_empty(path).ok_or_else(|| "Local file path is empty".to_string())?;
    if !std::path::Path::new(&path).is_file() {
        return Err("Local file does not exist".to_string());
    }
    local_file_openers(&path)
}

#[tauri::command]
pub(crate) fn open_local_file_with_application(
    application_path: String,
    path: String,
) -> Result<(), String> {
    let application_path = normalized_non_empty(application_path)
        .ok_or_else(|| "Application path is empty".to_string())?;
    let path = normalized_non_empty(path).ok_or_else(|| "Local file path is empty".to_string())?;
    if !std::path::Path::new(&path).is_file() {
        return Err("Local file does not exist".to_string());
    }
    if !std::path::Path::new(&application_path).is_dir() {
        return Err("Application does not exist".to_string());
    }
    open_local_workspace_with_app(&application_path, &path)
}

#[cfg(target_os = "macos")]
pub(crate) fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        output.push(TABLE[((value >> 18) & 0x3f) as usize] as char);
        output.push(TABLE[((value >> 12) & 0x3f) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(target_os = "macos")]
pub(crate) fn local_file_opener_icon(icon_path: &str) -> Result<String, String> {
    let output_path = std::env::temp_dir().join(format!(
        "studio-opener-icon-{}-{}.png",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| format!("Failed to create icon path: {error}"))?
            .as_nanos()
    ));
    let status = std::process::Command::new("sips")
        .args(["-s", "format", "png", "-Z", "32", icon_path, "--out"])
        .arg(&output_path)
        .status()
        .map_err(|error| format!("Failed to render application icon: {error}"))?;
    if !status.success() {
        return Err("Failed to render application icon".to_string());
    }
    let bytes = std::fs::read(&output_path)
        .map_err(|error| format!("Failed to read rendered application icon: {error}"))?;
    let _ = std::fs::remove_file(output_path);
    Ok(format!("data:image/png;base64,{}", encode_base64(&bytes)))
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn local_file_opener_icon(_icon_path: &str) -> Result<String, String> {
    Err("Rendering local application icons is only supported on macOS".to_string())
}

#[tauri::command]
pub(crate) fn get_local_file_opener_icon(icon_path: String) -> Result<String, String> {
    let icon_path = normalized_non_empty(icon_path)
        .ok_or_else(|| "Application icon path is empty".to_string())?;
    if !std::path::Path::new(&icon_path).is_file() {
        return Err("Application icon does not exist".to_string());
    }
    local_file_opener_icon(&icon_path)
}
