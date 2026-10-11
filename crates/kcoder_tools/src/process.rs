use crate::{ToolContext, ToolError, ToolOutput, truncate_text};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::task::JoinHandle;
use tokio::time::{Duration, Instant};

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
    flush_interval: Duration,
}

struct LiveOutputState {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    path: Option<PathBuf>,
    revision: u64,
    published_revision: u64,
    failed_revision: Option<u64>,
    last_attempt: Option<Instant>,
    #[cfg(test)]
    snapshot_writes: usize,
    #[cfg(test)]
    before_publish: Option<Arc<dyn Fn() + Send + Sync>>,
}

impl LiveOutputCapture {
    pub(crate) fn new(limits: OutputLimits) -> Self {
        Self {
            inner: Arc::new(Mutex::new(LiveOutputState {
                stdout: Vec::new(),
                stderr: Vec::new(),
                path: None,
                revision: 0,
                published_revision: 0,
                failed_revision: None,
                last_attempt: None,
                #[cfg(test)]
                snapshot_writes: 0,
                #[cfg(test)]
                before_publish: None,
            })),
            write_gate: Arc::new(tokio::sync::Mutex::new(())),
            limits,
            flush_interval: Duration::from_millis(250),
        }
    }

    pub(crate) async fn attach(&self, path: impl Into<PathBuf>) {
        let path = path.into();
        let write = self.write_gate.clone().lock_owned().await;
        let destination = path.clone();
        let preparation = tokio::task::spawn_blocking(move || {
            let result = (|| -> std::io::Result<()> {
                let path = std::path::absolute(destination)?;
                let parent = path
                    .parent()
                    .ok_or_else(|| std::io::Error::other("output path has no parent"))?;
                std::fs::create_dir_all(parent)
            })();
            (write, result)
        })
        .await;
        // Only attachment prepares a new owner's directory. A late pipe flush
        // cannot recreate it after task cleanup. Keep the gate through registration.
        if !matches!(&preparation, Ok((_, Ok(())))) {
            tracing::warn!("failed to prepare live task output directory");
        }
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            inner.path = Some(path);
            inner.revision = inner.revision.wrapping_add(1);
            inner.last_attempt = None;
            inner.failed_revision = None;
        }
        drop(preparation);
        self.flush().await;
    }

    async fn push(&self, stream: OutputStream, chunk: &[u8]) {
        {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            let target = match stream {
                OutputStream::Stdout => &mut inner.stdout,
                OutputStream::Stderr => &mut inner.stderr,
            };
            append_live_bytes(target, chunk, self.limits.max_bytes);
            inner.revision = inner.revision.wrapping_add(1);
        }
        self.write_latest_snapshot(false).await;
    }

    fn flush_deadline(&self) -> Option<Instant> {
        let inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        (inner.path.is_some()
            && inner.revision != inner.published_revision
            && inner.failed_revision != Some(inner.revision)
            && (!inner.stdout.is_empty() || !inner.stderr.is_empty()))
        .then(|| {
            inner
                .last_attempt
                .map_or_else(Instant::now, |last| last + self.flush_interval)
        })
    }

    /// Final reads and attachment changes bypass coalescing. Pipe readers own
    /// quiet timers; in-flight blocking writes retain their gate after cancellation.
    pub(crate) async fn flush(&self) {
        self.write_latest_snapshot(true).await;
    }

    async fn write_latest_snapshot(&self, force: bool) {
        let write = self.write_gate.clone().lock_owned().await;
        let (path, snapshot, revision) = {
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if inner.published_revision == inner.revision
                || (!force
                    && inner
                        .last_attempt
                        .is_some_and(|last| last.elapsed() < self.flush_interval))
            {
                return;
            }
            let path = inner.path.clone();
            let snapshot = path.as_ref().and_then(|_| {
                (!inner.stdout.is_empty() || !inner.stderr.is_empty())
                    .then(|| format_process_output(&inner.stdout, &inner.stderr, &self.limits))
            });
            if snapshot.is_some() {
                inner.last_attempt = Some(Instant::now());
            }
            (path, snapshot, inner.revision)
        };
        if let (Some(path), Some(snapshot)) = (path, snapshot) {
            let destination = path.clone();
            #[cfg(test)]
            let before_publish = self.inner.lock().unwrap().before_publish.clone();
            let result = tokio::task::spawn_blocking(move || {
                // Cancelling the async waiter cannot release the gate while an
                // older atomic replacement is still running on this thread.
                let result = (|| -> anyhow::Result<()> {
                    #[cfg(test)]
                    if let Some(hook) = before_publish {
                        hook();
                    }
                    let path = std::path::absolute(destination)?;
                    let parent = path
                        .parent()
                        .ok_or_else(|| anyhow::anyhow!("output path has no parent"))?;
                    kcoder_config::PrivateDirectory::open_existing(parent)?.atomic_replace(
                        path.file_name()
                            .ok_or_else(|| anyhow::anyhow!("output path has no file name"))?,
                        snapshot.as_bytes(),
                    )
                })();
                (write, result)
            })
            .await;
            let mut inner = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if matches!(&result, Ok((_, Ok(())))) {
                if inner.path.as_ref() == Some(&path) {
                    inner.published_revision = revision;
                    inner.failed_revision = None;
                }
                #[cfg(test)]
                {
                    inner.snapshot_writes += 1;
                }
            } else {
                if inner.path.as_ref() == Some(&path) {
                    inner.failed_revision = Some(revision);
                }
                // Keep the last complete file and retry on new data or final flush.
                tracing::warn!("failed to publish live task output snapshot");
            }
        }
    }
}

async fn read_live_chunk(
    pipe: &mut (impl AsyncRead + Unpin),
    chunk: &mut [u8],
    live: &Option<(LiveOutputCapture, OutputStream)>,
) -> std::io::Result<usize> {
    loop {
        let deadline = live
            .as_ref()
            .and_then(|(capture, _)| capture.flush_deadline());
        tokio::select! {
            result = pipe.read(chunk) => {
                if matches!(&result, Ok(0) | Err(_))
                    && let Some((capture, _)) = live {
                    capture.flush().await;
                }
                return result;
            }
            _ = async {
                match deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                if let Some((capture, _)) = live { capture.flush().await; }
            }
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
            let read = read_live_chunk(&mut pipe, &mut chunk, &live).await?;
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
        let read = read_live_chunk(&mut pipe, &mut chunk, &live).await?;
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
    use tokio::io::AsyncWriteExt;

    fn live_limits(max_bytes: usize) -> OutputLimits {
        OutputLimits {
            max_bytes,
            head_bytes: max_bytes / 2,
            tail_bytes: max_bytes / 2,
            spill_dir: None,
        }
    }

    #[tokio::test]
    async fn live_output_pipe_eof_flushes_the_last_chunk_with_bounded_and_unlimited_output() {
        for max_bytes in [1024, 0] {
            let tmp = tempfile::tempdir().unwrap();
            let path = tmp.path().join("output.txt");
            let limits = live_limits(max_bytes);
            let mut capture = LiveOutputCapture::new(limits.clone());
            capture.flush_interval = Duration::from_secs(3600);
            capture.attach(&path).await;
            let mut bytes = vec![b'x'; 24_000];
            bytes.extend_from_slice(b"\nlast output before EOF\n");
            let result = read_output_pipe(
                std::io::Cursor::new(bytes.clone()),
                limits,
                Some((capture, OutputStream::Stdout)),
            )
            .await
            .unwrap();
            assert!(
                std::fs::read_to_string(path)
                    .unwrap()
                    .contains("last output before EOF")
            );
            assert!(String::from_utf8_lossy(&result).contains("last output before EOF"));
            if max_bytes == 0 {
                assert_eq!(result, bytes);
            }
        }
    }

    #[tokio::test]
    async fn live_output_quiet_pipe_publishes_pending_data_without_waiting_for_exit() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("output.txt");
        let limits = live_limits(4096);
        let mut capture = LiveOutputCapture::new(limits.clone());
        capture.flush_interval = Duration::from_millis(20);
        capture.attach(&path).await;
        let (mut producer, consumer) = tokio::io::duplex(4096);
        let observer = capture.clone();
        let reader = tokio::spawn(read_output_pipe(
            consumer,
            limits,
            Some((capture, OutputStream::Stdout)),
        ));
        producer.write_all(b"first chunk\n").await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while observer.inner.lock().unwrap().snapshot_writes == 0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        producer.write_all(b"quiet pending chunk\n").await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if std::fs::read_to_string(&path)
                    .unwrap()
                    .contains("quiet pending chunk")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            !reader.is_finished(),
            "the producer has not closed its pipe"
        );
        drop(producer);
        reader.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn live_output_pipe_error_flushes_already_received_tail() {
        struct FailingPipe {
            chunks: usize,
        }
        impl AsyncRead for FailingPipe {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
                buffer: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                let data = match self.chunks {
                    0 => b"first chunk\n".as_slice(),
                    1 => b"last chunk before pipe error\n".as_slice(),
                    _ => {
                        return std::task::Poll::Ready(Err(std::io::Error::other(
                            "owned fixture read failure",
                        )));
                    }
                };
                self.chunks += 1;
                buffer.put_slice(data);
                std::task::Poll::Ready(Ok(()))
            }
        }
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("output.txt");
        let limits = live_limits(4096);
        let mut capture = LiveOutputCapture::new(limits.clone());
        capture.flush_interval = Duration::from_secs(3600);
        capture.attach(&path).await;
        assert!(
            read_output_pipe(
                FailingPipe { chunks: 0 },
                limits,
                Some((capture, OutputStream::Stdout))
            )
            .await
            .is_err()
        );
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("last chunk before pipe error")
        );
    }

    #[tokio::test]
    async fn live_output_stdout_and_stderr_are_retained_after_concurrent_pipe_reads() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("output.txt");
        let limits = live_limits(4096);
        let capture = LiveOutputCapture::new(limits.clone());
        capture.attach(&path).await;
        let (stdout, stderr) = tokio::join!(
            read_output_pipe(
                std::io::Cursor::new(b"stdout terminal chunk\n"),
                limits.clone(),
                Some((capture.clone(), OutputStream::Stdout))
            ),
            read_output_pipe(
                std::io::Cursor::new(b"stderr terminal chunk\n"),
                limits,
                Some((capture, OutputStream::Stderr))
            ),
        );
        stdout.unwrap();
        stderr.unwrap();
        let content = std::fs::read_to_string(path).unwrap();
        assert!(
            content.contains("stdout terminal chunk") && content.contains("stderr terminal chunk")
        );
    }

    #[tokio::test]
    async fn live_output_failed_publication_preserves_pending_data_for_final_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("tasks");
        let path = parent.join("output.txt");
        let mut capture = LiveOutputCapture::new(live_limits(4096));
        capture.flush_interval = Duration::from_secs(3600);
        capture.attach(&path).await;
        capture
            .push(OutputStream::Stdout, b"last complete file\n")
            .await;
        let parked = tmp.path().join("parked-tasks");
        std::fs::rename(&parent, &parked).unwrap();
        std::fs::write(&parent, b"owned path obstruction").unwrap();
        capture
            .push(OutputStream::Stdout, b"pending final chunk\n")
            .await;
        capture.flush().await;
        assert_eq!(
            std::fs::read(parent.clone()).unwrap(),
            b"owned path obstruction"
        );
        assert_eq!(
            std::fs::read_to_string(parked.join("output.txt")).unwrap(),
            "stdout:\nlast complete file\n"
        );
        assert!(
            capture.flush_deadline().is_none(),
            "failed revisions must not spin on a timer"
        );
        std::fs::remove_file(&parent).unwrap();
        std::fs::rename(parked, &parent).unwrap();
        capture.flush().await;
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("pending final chunk")
        );
    }

    #[tokio::test]
    async fn live_output_reattachment_publishes_pending_data_to_the_new_task_file() {
        let tmp = tempfile::tempdir().unwrap();
        let old_path = tmp.path().join("old.txt");
        let new_path = tmp.path().join("new.txt");
        let mut capture = LiveOutputCapture::new(live_limits(4096));
        capture.flush_interval = Duration::from_secs(3600);
        capture.attach(&old_path).await;
        capture.push(OutputStream::Stdout, b"first\n").await;
        capture.push(OutputStream::Stdout, b"pending\n").await;
        capture.attach(&new_path).await;
        assert!(
            !std::fs::read_to_string(old_path)
                .unwrap()
                .contains("pending")
        );
        assert!(
            std::fs::read_to_string(new_path)
                .unwrap()
                .contains("pending")
        );
    }

    #[tokio::test]
    async fn live_output_burst_coalesces_actual_disk_snapshots() {
        let tmp = tempfile::tempdir().unwrap();
        let mut capture = LiveOutputCapture::new(OutputLimits {
            max_bytes: 4096,
            head_bytes: 2048,
            tail_bytes: 2048,
            spill_dir: None,
        });
        capture.flush_interval = Duration::from_secs(3600);
        capture.attach(tmp.path().join("output.txt")).await;
        for _ in 0..64 {
            capture.push(OutputStream::Stdout, b"burst\n").await;
        }
        assert!(
            capture.inner.lock().unwrap().snapshot_writes <= 2,
            "a burst must not write the entire output file for every pipe chunk"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn live_output_owned_process_cancellation_flushes_pending_tail() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("output.txt");
        let limits = live_limits(4096);
        let mut capture = LiveOutputCapture::new(limits.clone());
        capture.flush_interval = Duration::from_secs(3600);
        capture.attach(&path).await;
        let observer = capture.clone();
        let mut child = tokio::process::Command::new("/bin/sh")
            .env_clear()
            .args(["-c", "printf 'first\\n'; /bin/sleep 0.05; printf 'tail before cancellation\\n'; exec /bin/sleep 30"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let reader = tokio::spawn(read_output_pipe(
            child.stdout.take().unwrap(),
            limits,
            Some((capture, OutputStream::Stdout)),
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if String::from_utf8_lossy(&observer.inner.lock().unwrap().stdout)
                    .contains("tail before cancellation")
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        child.start_kill().unwrap();
        child.wait().await.unwrap();
        tokio::time::timeout(Duration::from_secs(2), reader)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("tail before cancellation")
        );
    }

    #[tokio::test]
    async fn live_output_cancelled_waiter_keeps_the_disk_writer_serialized() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("output.txt");
        let mut capture = LiveOutputCapture::new(live_limits(4096));
        capture.flush_interval = Duration::ZERO;
        capture.attach(&path).await;
        let barrier = Arc::new((Mutex::new((false, false)), std::sync::Condvar::new()));
        let hook_barrier = barrier.clone();
        capture.inner.lock().unwrap().before_publish = Some(Arc::new(move || {
            let (lock, changed) = &*hook_barrier;
            let mut state = lock.lock().unwrap();
            if state.0 {
                return;
            }
            state.0 = true;
            while !state.1 {
                state = changed.wait(state).unwrap();
            }
        }));
        let first = capture.clone();
        let old_waiter = tokio::spawn(async move {
            first.push(OutputStream::Stdout, b"old chunk\n").await;
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !barrier.0.lock().unwrap().0 {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        old_waiter.abort();
        let _ = old_waiter.await;
        let next = capture.clone();
        let mut newer = tokio::spawn(async move {
            next.push(OutputStream::Stdout, b"newer chunk\n").await;
        });
        let blocked = tokio::time::timeout(Duration::from_millis(30), &mut newer)
            .await
            .is_err();
        // Always release the owned blocking fixture before assertions/runtime shutdown.
        barrier.0.lock().unwrap().1 = true;
        barrier.1.notify_all();
        if blocked {
            newer.await.unwrap();
        }
        assert!(
            blocked,
            "the cancelled old writer must retain its gate until disk publication finishes"
        );
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .contains("newer chunk")
        );
    }

    #[tokio::test]
    async fn live_output_does_not_recreate_a_task_directory_after_owner_cleanup() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("owned-task");
        std::fs::create_dir(&parent).unwrap();
        let path = parent.join("output.txt");
        let capture = LiveOutputCapture::new(live_limits(4096));
        capture.attach(&path).await;
        capture.push(OutputStream::Stdout, b"first\n").await;
        std::fs::remove_dir_all(&parent).unwrap();
        capture
            .push(OutputStream::Stdout, b"late pipe output\n")
            .await;
        capture.flush().await;
        assert!(
            !parent.exists(),
            "late pipe EOF must not recreate a removed owner directory"
        );
    }

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
        capture.flush().await;
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
            background_started_output_after_foreground_budget(
                "PowerShell",
                "job",
                "Write-Output fixture",
                1000,
                100,
                Path::new("/fixture"),
            ),
        ];
        for output in outputs {
            let text = output
                .content
                .iter()
                .filter_map(|block| {
                    if let kcoder_types::ContentBlock::Text { text } = block {
                        Some(text.as_str())
                    } else {
                        None
                    }
                })
                .collect::<String>();
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["task_id"], "job");
            let hint = value["next_action"].as_str().unwrap();
            assert!(!hint.contains("TaskOutput") && !hint.contains("TaskStop"));
            assert!(hint.contains("attached to this request"));
        }
    }
}
