use crate::{ToolContext, ToolError, ToolOutput, truncate_text};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;

const GIT_TRANSPORT_RESTRICTION_ENV: &[&str] = &[
    "GIT_ALLOW_PROTOCOL",
    "GIT_PROTOCOL_FROM_USER",
    "GIT_TERMINAL_PROMPT",
];

pub(crate) fn configure_isolated_process_environment(
    command: &mut tokio::process::Command,
    cwd: &Path,
) {
    command.env_clear();
    for (name, value) in isolated_process_environment(cwd) {
        command.env(name, value);
    }
}

#[allow(clippy::vec_init_then_push)]
pub(crate) fn isolated_process_environment(cwd: &Path) -> Vec<(OsString, OsString)> {
    let mut environment = Vec::new();
    #[cfg(windows)]
    for name in [
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "PATH",
        "TEMP",
        "TMP",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERPROFILE",
        "USERNAME",
        "USERDOMAIN",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "ALLUSERSPROFILE",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "CommonProgramFiles",
        "CommonProgramFiles(x86)",
        "CommonProgramW6432",
        "PSModulePath",
    ] {
        if let Some(value) = std::env::var_os(name) {
            environment.push((OsString::from(name), value));
        }
    }
    #[cfg(not(windows))]
    environment.push((
        OsString::from("PATH"),
        OsString::from("/usr/local/bin:/usr/bin:/bin"),
    ));
    environment.push((OsString::from("TERM"), OsString::from("xterm-256color")));
    environment.push((OsString::from("PWD"), cwd.as_os_str().to_os_string()));
    append_git_transport_restrictions(&mut environment, |name| std::env::var_os(name));
    environment
}

fn append_git_transport_restrictions(
    environment: &mut Vec<(OsString, OsString)>,
    mut lookup: impl FnMut(&str) -> Option<OsString>,
) {
    for name in GIT_TRANSPORT_RESTRICTION_ENV {
        if let Some(value) = lookup(name) {
            environment.push((OsString::from(name), value));
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct OutputLimits {
    max_bytes: usize,
    head_bytes: usize,
    tail_bytes: usize,
    spill_dir: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum OutputStream {
    Stdout,
    Stderr,
}

#[derive(Clone)]
pub(crate) struct LiveOutputCapture {
    inner: Arc<Mutex<LiveOutputState>>,
    write_gate: Arc<tokio::sync::Mutex<()>>,
    limits: OutputLimits,
}

struct LiveOutputState {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    path: Option<PathBuf>,
}

impl LiveOutputCapture {
    pub(crate) fn new(limits: OutputLimits) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LiveOutputState {
                stdout: Vec::new(),
                stderr: Vec::new(),
                path: None,
            })),
            write_gate: Arc::new(tokio::sync::Mutex::new(())),
            limits,
        }
    }

    pub(crate) async fn attach(&self, path: impl Into<PathBuf>) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.path = Some(path.into());
        }
        self.write_latest_snapshot().await;
    }

    async fn push(&self, stream: OutputStream, chunk: &[u8]) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let target = match stream {
                OutputStream::Stdout => &mut inner.stdout,
                OutputStream::Stderr => &mut inner.stderr,
            };
            append_live_bytes(target, chunk, self.limits.max_bytes);
        }
        self.write_latest_snapshot().await;
    }

    async fn write_latest_snapshot(&self) {
        let _write = self.write_gate.lock().await;
        let (path, snapshot) = {
            let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let path = inner.path.clone();
            let snapshot = path.as_ref().and_then(|_| {
                (!inner.stdout.is_empty() || !inner.stderr.is_empty())
                    .then(|| format_process_output(&inner.stdout, &inner.stderr, &self.limits))
            });
            (path, snapshot)
        };
        if let (Some(path), Some(snapshot)) = (path, snapshot) {
            if let Some(parent) = path.parent() {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
            let _ = tokio::fs::write(path, snapshot).await;
        }
    }
}

fn append_live_bytes(target: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) {
    target.extend_from_slice(chunk);
    if max_bytes > 0 && target.len() > max_bytes {
        target.drain(..target.len() - max_bytes);
    }
}

pub(crate) async fn read_output_pipe(
    mut pipe: impl AsyncRead + Unpin,
    limits: OutputLimits,
    live: Option<(LiveOutputCapture, OutputStream)>,
) -> std::io::Result<Vec<u8>> {
    let (max_bytes, head_limit, tail_limit) = limits.pipe_capture_limits();
    if max_bytes == 0 {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = pipe.read(&mut chunk).await?;
            if read == 0 {
                break;
            }
            if let Some((capture, stream)) = &live {
                capture.push(*stream, &chunk[..read]).await;
            }
            bytes.extend_from_slice(&chunk[..read]);
        }
        return Ok(bytes);
    }

    let mut head = Vec::with_capacity(head_limit);
    let mut tail = Vec::with_capacity(tail_limit);
    let mut total = 0usize;
    let mut chunk = [0u8; 8192];
    loop {
        let read = pipe.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        if let Some((capture, stream)) = &live {
            capture.push(*stream, &chunk[..read]).await;
        }
        total = total.saturating_add(read);
        let mut unread = &chunk[..read];
        if head.len() < head_limit {
            let take = unread.len().min(head_limit - head.len());
            head.extend_from_slice(&unread[..take]);
            unread = &unread[take..];
        }
        if tail_limit > 0 && !unread.is_empty() {
            if unread.len() >= tail_limit {
                tail.clear();
                tail.extend_from_slice(&unread[unread.len() - tail_limit..]);
            } else {
                let overflow = tail
                    .len()
                    .saturating_add(unread.len())
                    .saturating_sub(tail_limit);
                if overflow > 0 {
                    tail.drain(..overflow);
                }
                tail.extend_from_slice(unread);
            }
        }
    }

    if total <= head.len().saturating_add(tail.len()) {
        head.extend_from_slice(&tail);
        return Ok(head);
    }
    let omitted = total.saturating_sub(head.len()).saturating_sub(tail.len());
    head.extend_from_slice(format!("\n...[truncated {omitted} bytes]...\n").as_bytes());
    head.extend_from_slice(&tail);
    Ok(head)
}

pub(crate) async fn join_output_pipe(
    reader: Option<JoinHandle<std::io::Result<Vec<u8>>>>,
    name: &str,
) -> Result<Vec<u8>, ToolError> {
    reader
        .ok_or_else(|| ToolError::Execution(format!("process {name} reader was missing")))?
        .await
        .map_err(|error| ToolError::Execution(format!("process {name} reader failed: {error}")))?
        .map_err(|error| ToolError::Execution(format!("failed to read process {name}: {error}")))
}

impl OutputLimits {
    pub(crate) fn from_context(ctx: &ToolContext) -> Self {
        Self {
            max_bytes: ctx.max_output_bytes,
            head_bytes: ctx.output_head_bytes,
            tail_bytes: ctx.output_tail_bytes,
            spill_dir: Some(crate::truncate::spill_dir_for_state(&ctx.state)),
        }
    }

    pub(crate) fn truncate(&self, text: &str) -> String {
        match &self.spill_dir {
            Some(dir) => crate::truncate::truncate_and_spill(
                text,
                self.max_bytes,
                self.head_bytes,
                self.tail_bytes,
                dir,
            ),
            None => truncate_text(text, self.max_bytes, self.head_bytes, self.tail_bytes).text,
        }
    }

    pub(crate) fn pipe_capture_limits(&self) -> (usize, usize, usize) {
        if self.max_bytes == 0 {
            return (0, 0, 0);
        }
        let requested = self.head_bytes.saturating_add(self.tail_bytes);
        let (head, tail) = if requested > self.max_bytes {
            let head = self.head_bytes.saturating_mul(self.max_bytes) / requested;
            (head, self.max_bytes.saturating_sub(head))
        } else {
            (self.head_bytes, self.tail_bytes)
        };
        if requested == 0 {
            (self.max_bytes, self.max_bytes, 0)
        } else {
            (self.max_bytes, head, tail)
        }
    }
}

pub(crate) fn format_process_output(stdout: &[u8], stderr: &[u8], limits: &OutputLimits) -> String {
    let stdout = decode_process_output(stdout);
    let stderr = decode_process_output(stderr);
    let mut text = String::new();

    if !stdout.is_empty() {
        text.push_str(&format!("stdout:\n{stdout}"));
    }
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("stderr:\n{stderr}"));
    }
    if stdout.is_empty() && stderr.is_empty() {
        text.push_str("(no output)");
    }

    limits.truncate(&text)
}

fn decode_process_output(bytes: &[u8]) -> String {
    let (utf16, big_endian) = if bytes.starts_with(&[0xff, 0xfe]) {
        (&bytes[2..], false)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        (&bytes[2..], true)
    } else {
        let pairs = bytes.len() / 2;
        let odd_nuls = bytes
            .iter()
            .skip(1)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count();
        if pairs >= 2 && odd_nuls * 2 >= pairs {
            (bytes, false)
        } else {
            return String::from_utf8_lossy(bytes).into_owned();
        }
    };
    let units = utf16.chunks_exact(2).map(|pair| {
        let pair = [pair[0], pair[1]];
        if big_endian {
            u16::from_be_bytes(pair)
        } else {
            u16::from_le_bytes(pair)
        }
    });
    char::decode_utf16(units)
        .map(|character| character.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

pub(crate) fn redact_command_for_log(command: &str) -> String {
    let mut redact_next = false;
    let mut parts = Vec::new();
    for token in command.split_whitespace() {
        let lower = token
            .trim_matches(|c: char| c == '\'' || c == '"' || c == '`' || c == ',' || c == ';')
            .to_ascii_lowercase();
        if redact_next {
            parts.push("[redacted]".to_string());
            redact_next = false;
            continue;
        }
        if lower == "bearer" {
            parts.push(token.to_string());
            redact_next = true;
            continue;
        }
        if lower.contains("api_key")
            || lower.contains("apikey")
            || lower.contains("authorization")
            || lower.contains("password")
            || lower.contains("token")
            || lower.contains("secret")
            || lower.contains("sk-")
            || lower.contains("sk_")
        {
            parts.push("[redacted]".to_string());
        } else {
            parts.push(token.to_string());
        }
    }
    let redacted = parts.join(" ");
    let max_chars = 240;
    if redacted.chars().count() <= max_chars {
        redacted
    } else {
        format!(
            "{}…[truncated, {} chars]",
            redacted.chars().take(max_chars).collect::<String>(),
            command.chars().count()
        )
    }
}

pub(crate) fn background_started_output(
    tool_name: &str,
    task_id: &str,
    command: &str,
    command_timeout_ms: u64,
    workdir: &Path,
) -> ToolOutput {
    let task_type = tool_name.to_ascii_lowercase();
    let started_at_ms = unix_time_ms();
    let expires_at_ms = started_at_ms.saturating_add(command_timeout_ms);
    ToolOutput::text(
        serde_json::json!({
            "task_id": task_id,
            "task_type": task_type,
            "tool": tool_name,
            "status": "running",
            "command": command,
            "workdir": workdir,
            "workdir_scope": "invocation_only",
            "command_timeout_ms": command_timeout_ms,
            "total_lifetime_ms": command_timeout_ms,
            "started_at_ms": started_at_ms,
            "expires_at_ms": expires_at_ms,
            "lifecycle_scope": "kcoder_session",
            "next_action": format!(
                "The command is running in the background as `{task_id}`. Continue other useful work. Use status or cancellation controls only when they are attached to this request; otherwise rely on managed completion notifications. Wait only when the result blocks the next step."
            ),
        })
        .to_string(),
    )
}

pub(crate) fn background_started_output_after_foreground_budget(
    tool_name: &str,
    task_id: &str,
    command: &str,
    command_timeout_ms: u64,
    foreground_budget_ms: u64,
    workdir: &Path,
) -> ToolOutput {
    let task_type = tool_name.to_ascii_lowercase();
    let started_at_ms = unix_time_ms().saturating_sub(foreground_budget_ms);
    let expires_at_ms = started_at_ms.saturating_add(command_timeout_ms);
    ToolOutput::text(
        serde_json::json!({
            "task_id": task_id,
            "task_type": task_type,
            "tool": tool_name,
            "status": "running",
            "command": command,
            "workdir": workdir,
            "workdir_scope": "invocation_only",
            "command_timeout_ms": command_timeout_ms,
            "total_lifetime_ms": command_timeout_ms,
            "started_at_ms": started_at_ms,
            "expires_at_ms": expires_at_ms,
            "lifecycle_scope": "kcoder_session",
            "foreground_budget_ms": foreground_budget_ms,
            "automatically_backgrounded": true,
            "next_action": format!(
                "The command exceeded the {foreground_budget_ms} ms foreground blocking budget and is still running as `{task_id}`. Its total lifetime timeout remains {command_timeout_ms} ms from the original start. Continue other useful work. Use status or cancellation controls only when attached to this request; otherwise rely on managed completion notifications."
            ),
        })
        .to_string(),
    )
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_shell_environment_forwards_only_explicit_git_restrictions() {
        let mut environment = vec![(OsString::from("PATH"), OsString::from("/bin"))];
        append_git_transport_restrictions(&mut environment, |name| match name {
            "GIT_ALLOW_PROTOCOL" => Some(OsString::from("file")),
            "GIT_PROTOCOL_FROM_USER" | "GIT_TERMINAL_PROMPT" => Some(OsString::from("0")),
            _ => Some(OsString::from("must-not-be-forwarded")),
        });

        assert_eq!(environment.len(), 4);
        assert!(
            environment.contains(&(OsString::from("GIT_ALLOW_PROTOCOL"), OsString::from("file")))
        );
        assert!(environment.contains(&(
            OsString::from("GIT_PROTOCOL_FROM_USER"),
            OsString::from("0")
        )));
        assert!(
            environment.contains(&(OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0")))
        );
        assert!(!environment.iter().any(|(name, _)| name == "OPENAI_API_KEY"));
    }

    #[test]
    fn command_log_redaction_hides_common_secret_shapes() {
        let redacted = redact_command_for_log(
            "OPENAI_API_KEY=sk-secret curl -H 'Authorization: Bearer token-value' https://example.test",
        );

        assert!(redacted.contains("[redacted]"));
        assert!(!redacted.contains("sk-secret"));
        assert!(!redacted.contains("token-value"));
        assert!(!redacted.contains("OPENAI_API_KEY=sk-secret"));
    }

    #[test]
    fn command_log_redaction_keeps_non_sensitive_command_shape() {
        let redacted = redact_command_for_log("cargo test -p kcoder_tools");

        assert_eq!(redacted, "cargo test -p kcoder_tools");
    }

    #[test]
    fn process_output_decodes_utf16le_with_or_without_bom() {
        let text = "Access is denied. 拒绝访问。";
        let encoded = text
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(decode_process_output(&encoded), text);

        let with_bom = [vec![0xff, 0xfe], encoded].concat();
        assert_eq!(decode_process_output(&with_bom), text);
    }

    #[test]
    fn background_start_payload_keeps_adapter_task_type() {
        for (tool, expected) in [
            ("bash", "bash"),
            ("PowerShell", "powershell"),
            ("ocr", "ocr"),
        ] {
            let output =
                background_started_output(tool, "job-1", "command", 1000, Path::new("/tmp"));
            let text = output
                .content
                .iter()
                .filter_map(|block| match block {
                    kcoder_types::ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<String>();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["task_type"], expected);
            assert_eq!(value["lifecycle_scope"], "kcoder_session");
            assert_eq!(value["total_lifetime_ms"], 1000);
            assert_eq!(value["command_timeout_ms"], 1000);
            assert_eq!(value["workdir"], "/tmp");
            assert_eq!(value["workdir_scope"], "invocation_only");
            assert!(value["started_at_ms"].as_u64().unwrap() > 0);
            assert!(
                value["expires_at_ms"].as_u64().unwrap()
                    >= value["started_at_ms"].as_u64().unwrap() + 1000
            );
        }
    }

    #[tokio::test]
    async fn live_output_capture_updates_attached_task_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("tasks/job-1/output.txt");
        let limits = OutputLimits {
            max_bytes: 4096,
            head_bytes: 2048,
            tail_bytes: 2048,
            spill_dir: None,
        };
        let capture = LiveOutputCapture::new(limits);
        capture.attach(&path).await;

        capture.push(OutputStream::Stdout, b"early stdout\n").await;
        let first = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(first.contains("stdout:\nearly stdout"));

        capture.push(OutputStream::Stderr, b"early stderr\n").await;
        let second = tokio::fs::read_to_string(&path).await.unwrap();
        assert!(second.contains("stdout:\nearly stdout"));
        assert!(second.contains("stderr:\nearly stderr"));
    }
}

#[cfg(test)]
mod background_hint_contract_tests {
    use super::*;
    #[test]
    fn background_results_do_not_advertise_unscoped_peer_tools() {
        let outputs = [
            background_started_output("bash", "job", "echo fixture", 1000, Path::new("/fixture")),
            background_started_output_after_foreground_budget("PowerShell", "job", "Write-Output fixture", 1000, 100, Path::new("/fixture")),
        ];
        for output in outputs {
            let text = output.content.iter().filter_map(|block| if let kcoder_types::ContentBlock::Text {text} = block {Some(text.as_str())} else {None}).collect::<String>();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["task_id"], "job");
            let hint = value["next_action"].as_str().unwrap();
            assert!(!hint.contains("TaskOutput") && !hint.contains("TaskStop"));
            assert!(hint.contains("attached to this request"));
        }
    }
}
