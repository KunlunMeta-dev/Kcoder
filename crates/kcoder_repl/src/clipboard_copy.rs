//! Clipboard copy backend for transcript selection, the TUI's `/copy` command,
//! and the `Ctrl+O` hotkey.
//!
//! SSH sessions use the terminal's OSC 52 clipboard channel. Local sessions
//! prefer the native clipboard and retain its owner on Linux.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use std::io::Write;

const OSC52_MAX_RAW_BYTES: usize = 100_000;

pub(crate) const OSC52_COPY_NOTICE: &str = "Sent an OSC 52 copy request; if the clipboard remains empty, check whether the terminal allows OSC 52";

pub(crate) fn copy_to_clipboard(text: &str) -> Result<ClipboardCopyResult, String> {
    copy_to_clipboard_with(
        text,
        CopyEnvironment {
            ssh_session: is_ssh_session(),
            wsl_session: is_wsl_session(),
        },
        arboard_copy,
        wsl_clipboard_copy,
        osc52_copy,
    )
}

pub(crate) enum ClipboardCopyResult {
    Native(Option<ClipboardLease>),
    Osc52,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClipboardCopyKind {
    Native,
    Osc52,
}

impl ClipboardCopyResult {
    pub(crate) fn into_parts(self) -> (Option<ClipboardLease>, ClipboardCopyKind) {
        match self {
            Self::Native(lease) => (lease, ClipboardCopyKind::Native),
            Self::Osc52 => (None, ClipboardCopyKind::Osc52),
        }
    }
}

/// Keeps a native Linux clipboard owner alive for as long as the TUI needs it.
pub(crate) struct ClipboardLease {
    #[cfg(target_os = "linux")]
    _clipboard: Option<arboard::Clipboard>,
}

impl ClipboardLease {
    #[cfg(target_os = "linux")]
    fn native_linux(clipboard: arboard::Clipboard) -> Self {
        Self {
            _clipboard: Some(clipboard),
        }
    }

    #[cfg(test)]
    pub(crate) fn test() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            _clipboard: None,
        }
    }
}

#[derive(Clone, Copy)]
struct CopyEnvironment {
    ssh_session: bool,
    wsl_session: bool,
}

fn copy_to_clipboard_with(
    text: &str,
    environment: CopyEnvironment,
    arboard_copy_fn: impl Fn(&str) -> Result<Option<ClipboardLease>, String>,
    wsl_copy_fn: impl Fn(&str) -> Result<(), String>,
    osc52_copy_fn: impl FnOnce(&str) -> Result<(), String>,
) -> Result<ClipboardCopyResult, String> {
    if environment.ssh_session {
        osc52_copy_fn(text)?;
        return Ok(ClipboardCopyResult::Osc52);
    }

    match arboard_copy_fn(text) {
        Ok(lease) => Ok(ClipboardCopyResult::Native(lease)),
        Err(native_error) => {
            let mut unavailable = format!("native clipboard: {native_error}");
            if environment.wsl_session {
                tracing::warn!(
                    "native clipboard copy failed: {native_error}, falling back to WSL PowerShell"
                );
                match wsl_copy_fn(text) {
                    Ok(()) => return Ok(ClipboardCopyResult::Native(None)),
                    Err(wsl_error) => {
                        unavailable.push_str(&format!("; WSL fallback: {wsl_error}"));
                    }
                }
            }

            // Linux terminals without a desktop may still support OSC 52, independently
            // of SSH environment markers. The channel has no acknowledgement, so report
            // only that a request was sent rather than claiming client-side copy success.
            osc52_copy_fn(text)
                .map(|()| ClipboardCopyResult::Osc52)
                .map_err(|error| format!("{unavailable}; terminal clipboard: {error}"))
        }
    }
}

fn osc52_copy(text: &str) -> Result<(), String> {
    let sequence = osc52_sequence(text, is_terminal_multiplexer_session())?;
    #[cfg(unix)]
    {
        match std::fs::OpenOptions::new().write(true).open("/dev/tty") {
            Ok(tty) => match write_osc52_to_writer(tty, &sequence) {
                Ok(()) => return Ok(()),
                Err(error) => tracing::debug!(
                    "failed to write OSC 52 to /dev/tty: {error}; falling back to stdout"
                ),
            },
            Err(error) => tracing::debug!(
                "failed to open /dev/tty for OSC 52: {error}; falling back to stdout"
            ),
        }
    }

    write_osc52_to_writer(std::io::stdout().lock(), &sequence)
}

fn write_osc52_to_writer(mut writer: impl Write, sequence: &str) -> Result<(), String> {
    writer
        .write_all(sequence.as_bytes())
        .map_err(|error| format!("failed to write OSC 52 sequence: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("failed to flush OSC 52 sequence: {error}"))
}

fn osc52_sequence(text: &str, multiplexer_session: bool) -> Result<String, String> {
    let raw_bytes = text.len();
    if raw_bytes > OSC52_MAX_RAW_BYTES {
        return Err(format!(
            "OSC 52 payload too large ({raw_bytes} bytes; max {OSC52_MAX_RAW_BYTES})"
        ));
    }

    let payload = BASE64_STANDARD.encode(text.as_bytes());
    let sequence = format!("\x1b]52;c;{payload}\x07");
    if multiplexer_session {
        Ok(format!("\x1bPtmux;\x1b{sequence}\x1b\\"))
    } else {
        Ok(sequence)
    }
}

fn is_terminal_multiplexer_session() -> bool {
    std::env::var_os("TMUX").is_some() || std::env::var_os("STY").is_some()
}

fn is_ssh_session() -> bool {
    std::env::var_os("SSH_TTY").is_some() || std::env::var_os("SSH_CONNECTION").is_some()
}

#[cfg(target_os = "linux")]
fn is_wsl_session() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::env::var_os("WSL_INTEROP").is_some()
        || std::fs::read_to_string("/proc/version").is_ok_and(|version| {
            let version = version.to_ascii_lowercase();
            version.contains("microsoft") || version.contains("wsl")
        })
}

#[cfg(not(target_os = "linux"))]
fn is_wsl_session() -> bool {
    false
}

#[cfg(all(not(target_os = "android"), not(target_os = "linux")))]
fn arboard_copy(text: &str) -> Result<Option<ClipboardLease>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("failed to set clipboard text: {error}"))?;
    Ok(None)
}

#[cfg(target_os = "linux")]
fn arboard_copy(text: &str) -> Result<Option<ClipboardLease>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
    clipboard
        .set_text(text)
        .map_err(|error| format!("failed to set clipboard text: {error}"))?;
    Ok(Some(ClipboardLease::native_linux(clipboard)))
}

#[cfg(target_os = "android")]
fn arboard_copy(_text: &str) -> Result<Option<ClipboardLease>, String> {
    Err("native clipboard unavailable on Android".to_string())
}

#[cfg(target_os = "linux")]
fn wsl_clipboard_copy(text: &str) -> Result<(), String> {
    let mut child = std::process::Command::new("powershell.exe")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .args([
            "-NoProfile",
            "-Command",
            "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; $text = [Console]::In.ReadToEnd(); Set-Clipboard -Value $text",
        ])
        .spawn()
        .map_err(|error| format!("failed to spawn powershell.exe: {error}"))?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("failed to open powershell.exe stdin".to_string());
    };
    if let Err(error) = stdin.write_all(text.as_bytes()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("failed to write to powershell.exe: {error}"));
    }
    drop(stdin);
    command_result(child.wait_with_output(), "powershell.exe")
}

#[cfg(not(target_os = "linux"))]
fn wsl_clipboard_copy(_text: &str) -> Result<(), String> {
    Err("WSL clipboard fallback unavailable on this platform".to_string())
}

#[cfg(target_os = "linux")]
fn command_result(
    output: std::io::Result<std::process::Output>,
    command: &str,
) -> Result<(), String> {
    let output = output.map_err(|error| format!("failed to wait for {command}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!("{command} exited with status {}", output.status))
    } else {
        Err(format!("{command} failed: {stderr}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ssh_uses_osc52_without_native_clipboard() {
        let mut copied = None;
        let result = copy_to_clipboard_with(
            "copy me",
            CopyEnvironment {
                ssh_session: true,
                wsl_session: false,
            },
            |_| panic!("native clipboard should not be used over SSH"),
            |_| panic!("WSL fallback should not be used over SSH"),
            |text| {
                copied = Some(text.to_string());
                Ok(())
            },
        );

        assert!(matches!(result, Ok(ClipboardCopyResult::Osc52)));
        assert_eq!(copied.as_deref(), Some("copy me"));
    }

    #[test]
    fn local_session_prefers_native_clipboard() {
        let result = copy_to_clipboard_with(
            "copy me",
            CopyEnvironment {
                ssh_session: false,
                wsl_session: false,
            },
            |_| Ok(Some(ClipboardLease::test())),
            |_| panic!("WSL should not be used"),
            |_| panic!("OSC 52 should not be used for a local native clipboard"),
        );

        assert!(matches!(result, Ok(ClipboardCopyResult::Native(Some(_)))));
    }

    #[test]
    fn unavailable_local_clipboard_falls_back_to_terminal() {
        let result = copy_to_clipboard_with(
            "复制原文",
            CopyEnvironment {
                ssh_session: false,
                wsl_session: false,
            },
            |_| Err("no display".to_string()),
            |_| panic!("不是 WSL"),
            |text| {
                assert_eq!(text, "复制原文");
                Ok(())
            },
        );
        assert!(matches!(result, Ok(ClipboardCopyResult::Osc52)));
    }

    #[test]
    fn clipboard_failure_reports_all_attempted_channels() {
        let result = copy_to_clipboard_with(
            "text",
            CopyEnvironment {
                ssh_session: false,
                wsl_session: true,
            },
            |_| Err("native failed".to_string()),
            |_| Err("WSL failed".to_string()),
            |_| Err("terminal failed".to_string()),
        );
        let Err(error) = result else {
            panic!("不能误报复制成功")
        };
        assert!(
            error.contains("native failed")
                && error.contains("WSL failed")
                && error.contains("terminal failed")
        );
    }

    #[test]
    fn wsl_native_fallback_precedes_terminal_clipboard() {
        let result = copy_to_clipboard_with(
            "text",
            CopyEnvironment {
                ssh_session: false,
                wsl_session: true,
            },
            |_| Err("no display".to_string()),
            |_| Ok(()),
            |_| panic!("WSL 已复制，不应再发 OSC 52"),
        );
        assert!(matches!(result, Ok(ClipboardCopyResult::Native(None))));
    }

    #[test]
    fn osc52_sequence_encodes_utf8_text() {
        assert_eq!(
            osc52_sequence("复制 me", false).unwrap(),
            "\x1b]52;c;5aSN5Yi2IG1l\x07"
        );
    }

    #[test]
    fn osc52_sequence_wraps_tmux_sessions() {
        assert_eq!(
            osc52_sequence("copy me", true).unwrap(),
            "\x1bPtmux;\x1b\x1b]52;c;Y29weSBtZQ==\x07\x1b\\"
        );
    }
}
