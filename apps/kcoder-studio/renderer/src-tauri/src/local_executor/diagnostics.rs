//! Bounded log tails, process diagnostics, audit output and native debug clipboard.

use super::*;

#[derive(Clone, Copy)]
pub(super) enum LocalExecutorOutputStream {
    Stderr,
}

impl LocalExecutorOutputStream {
    pub(super) fn log_label(self) -> &'static str {
        match self {
            Self::Stderr => "Local executor diagnostic",
        }
    }

    pub(super) fn log_line(self, line: &str) {
        log::info!("{}: {}", self.log_label(), line);
    }
}

pub(super) fn audit_local_executor_signal(message: String) {
    log::warn!("Tauri local executor signal audit: {message}");

    let Ok(log_dir) = local_executor_log_dir_path() else {
        return;
    };
    if fs::create_dir_all(&log_dir).is_err() {
        return;
    }

    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let audit_path = log_dir.join(LOCAL_EXECUTOR_SIGNAL_AUDIT_FILE_NAME);
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(audit_path)
    {
        let _ = writeln!(file, "timestamp_ms={timestamp_ms} {message}");
    }
}

pub(super) fn read_local_executor_log_tail(
    path: &Path,
    max_bytes: u64,
) -> Result<LocalExecutorLogTail, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("Failed to open local executor log: {error}"))?;
    let len = file
        .metadata()
        .map_err(|error| format!("Failed to inspect local executor log: {error}"))?
        .len();
    let byte_truncated = len > max_bytes;
    let offset = if byte_truncated { len - max_bytes } else { 0 };
    let starts_on_line_boundary = if offset == 0 {
        true
    } else {
        file.seek(SeekFrom::Start(offset - 1))
            .map_err(|error| format!("Failed to seek local executor log: {error}"))?;
        let mut previous = [0_u8; 1];
        file.read_exact(&mut previous)
            .map_err(|error| format!("Failed to read local executor log: {error}"))?;
        previous[0] == b'\n'
    };
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Failed to seek local executor log: {error}"))?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read local executor log: {error}"))?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if byte_truncated && !starts_on_line_boundary {
        if let Some(index) = content.find('\n') {
            content = content[index + 1..].to_string();
        }
    }
    let (content, line_truncated, line_count) =
        limit_log_lines(&content, LOCAL_EXECUTOR_LOG_TAIL_LINES);

    Ok(LocalExecutorLogTail {
        path: path.display().to_string(),
        content,
        truncated: byte_truncated || line_truncated,
        line_count,
    })
}

pub(super) fn limit_log_lines(content: &str, max_lines: usize) -> (String, bool, usize) {
    let has_trailing_newline = content.ends_with('\n');
    let lines = content.lines().collect::<Vec<_>>();
    let line_count = lines.len();
    let line_truncated = line_count > max_lines;
    let kept = if line_truncated {
        &lines[line_count - max_lines..]
    } else {
        &lines[..]
    };
    let mut content = kept.join("\n");
    if has_trailing_newline && !content.is_empty() {
        content.push('\n');
    }

    (content, line_truncated, kept.len())
}

pub(super) fn parse_executor_processes(output: &str) -> Vec<LocalExecutorProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, ' ');
            let pid = parts.next()?.parse::<u32>().ok()?;
            let command = parts.next()?.trim();
            // Executable paths may contain spaces (macOS app bundles such as
            // "/Applications/KCoder Studio.app/..."), so take everything from
            // the first path segment up to the first argument separator and
            // match on the binary file name.
            let start = command.find('/')?;
            let end = command[start..]
                .find(" --")
                .map(|index| start + index)
                .unwrap_or(command.len());
            let executable = command[start..end].trim_end();
            let file_name = Path::new(executable)
                .file_name()
                .and_then(|name| name.to_str())?;
            if file_name != "wegent-executor" {
                return None;
            }
            Some(LocalExecutorProcessInfo {
                pid,
                path: executable.to_string(),
            })
        })
        .collect()
}

#[cfg(unix)]
pub(super) fn local_executor_processes() -> Vec<LocalExecutorProcessInfo> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,command="]).output() else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_executor_processes(&stdout)
}

#[cfg(not(unix))]
pub(super) fn local_executor_processes() -> Vec<LocalExecutorProcessInfo> {
    Vec::new()
}

#[cfg(target_os = "macos")]
pub(super) fn write_text_to_native_clipboard(text: &str) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let text = NSString::from_str(text);
    let string_type = unsafe { NSPasteboardTypeString };
    if pasteboard.setString_forType(&text, string_type) {
        Ok(())
    } else {
        Err("Failed to write text to the macOS pasteboard".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn write_text_to_native_clipboard(_text: &str) -> Result<(), String> {
    Err("Native clipboard copy is only available in the desktop macOS app".to_string())
}
