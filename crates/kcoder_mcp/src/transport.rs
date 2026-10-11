use crate::sse::{
    SSE_MESSAGE_QUEUE_CAPACITY, SseEvent, SseParser, drain_sse_stream, enqueue_sse_message,
    pop_line,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdout};
use tracing::debug;

/// Transport abstraction for MCP communication.
#[async_trait]
pub trait McpTransport: Send + Sync {
    /// Send a single JSON-RPC line.
    async fn send(&mut self, line: &str) -> Result<()>;

    /// Receive the next JSON-RPC line, if any.
    async fn recv(&mut self) -> Result<Option<String>>;

    /// Passive local liveness only; it does not send requests or assert remote network health.
    fn is_healthy(&mut self) -> bool {
        true
    }

    /// Protocol versions supported for negotiation by this transport, with the first
    /// offered during initialize. The default is only `2024-11-05`, preserving stdio and legacy SSE behavior.
    fn supported_protocol_versions(&self) -> &'static [&'static str] {
        &["2024-11-05"]
    }

    /// Record the final version after initialize negotiation. Only transports that
    /// use it for later headers, such as Streamable HTTP `MCP-Protocol-Version`, override this method.
    fn set_negotiated_protocol_version(&mut self, _version: String) {}
}

/// Stdio transport for an MCP server.
///
/// The child communicates through stdin/stdout. Its stderr is drained in the
/// background and emitted at debug level instead of being inherited by the
/// terminal, because unmanaged stderr writes corrupt inline TUI output.
pub struct StdioTransport {
    process_tree: StdioProcessTreeTerminator,
    #[allow(dead_code)]
    child: Child,
    stdin: tokio::process::ChildStdin,
    stdout_lines: BufReader<ChildStdout>,
    stdout_buffer: Vec<u8>,
    pending_write: Vec<u8>,
    pending_write_offset: usize,
}

impl StdioTransport {
    pub async fn new(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
    ) -> Result<Self> {
        Self::new_private(command, args, env, false).await
    }

    pub(crate) async fn new_private(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
        private: bool,
    ) -> Result<Self> {
        let child_env = stdio_child_env(env);
        #[cfg(windows)]
        let program = which::which_in(
            command,
            child_env.get("PATH").map(std::ffi::OsString::from),
            std::env::current_dir().context("MCP command working directory is unavailable")?,
        )
        .unwrap_or_else(|_| std::path::PathBuf::from(command));
        #[cfg(not(windows))]
        let program = command;
        // Resolve Windows command shims before spawning; the standard process API retains argv quoting.
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(args)
            .env_clear()
            .envs(child_env)
            .stdout(std::process::Stdio::piped())
            .stdin(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);

        let mut child = cmd
            .spawn()
            .with_context(|| format!("failed to spawn MCP server: {}", command))?;
        let child_pid = child.id().context("spawned MCP server has no process ID")?;

        let stdin = child
            .stdin
            .take()
            .context("MCP server stdin was not piped")?;
        let stdout = child
            .stdout
            .take()
            .context("MCP server stdout was not piped")?;
        if let Some(stderr) = child.stderr.take() {
            drain_stderr(stderr, command.to_string(), private);
        }
        let stdout_lines = BufReader::new(stdout);

        Ok(Self {
            process_tree: StdioProcessTreeTerminator::new(child_pid),
            child,
            stdin,
            stdout_lines,
            stdout_buffer: Vec::new(),
            pending_write: Vec::new(),
            pending_write_offset: 0,
        })
    }

    async fn flush_pending_write(&mut self) -> Result<()> {
        while self.pending_write_offset < self.pending_write.len() {
            let written = self
                .stdin
                .write(&self.pending_write[self.pending_write_offset..])
                .await
                .context("failed to write to MCP server stdin")?;
            if written == 0 {
                return Err(std::io::Error::from(std::io::ErrorKind::WriteZero).into());
            }
            self.pending_write_offset += written;
        }
        self.stdin
            .flush()
            .await
            .context("failed to flush MCP server stdin")?;
        self.pending_write.clear();
        self.pending_write_offset = 0;
        Ok(())
    }
}

struct StdioProcessTreeTerminator {
    pid: u32,
    finished: AtomicBool,
}

impl StdioProcessTreeTerminator {
    fn new(pid: u32) -> Self {
        Self {
            pid,
            finished: AtomicBool::new(false),
        }
    }

    fn terminate(&self) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        unsafe {
            // The transport still owns its independent process group after leader exit.
            // Clean only that group and never fall back to a potentially reused leader PID.
            let _ = libc::kill(-(self.pid as libc::pid_t), libc::SIGKILL);
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }

    #[cfg(windows)]
    fn disarm(&self) {
        self.finished.store(true, Ordering::SeqCst);
    }
}

impl Drop for StdioProcessTreeTerminator {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl Drop for StdioTransport {
    fn drop(&mut self) {
        #[cfg(unix)]
        self.process_tree.terminate();
        #[cfg(windows)]
        if matches!(self.child.try_wait(), Ok(Some(_))) {
            self.process_tree.disarm();
        }
    }
}

fn stdio_child_env(configured: &HashMap<String, String>) -> HashMap<String, String> {
    let platform = if cfg!(windows) { "windows" } else { "unix" };
    let mut env = minimal_process_env_for(platform, |name| std::env::var(name).ok());
    env.extend(
        configured
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    env
}

fn minimal_process_env_for(
    platform: &str,
    get_env: impl Fn(&str) -> Option<String>,
) -> HashMap<String, String> {
    const WINDOWS_KEYS: &[&str] = &[
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATH",
        "PATHEXT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
    ];
    const UNIX_KEYS: &[&str] = &[
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "XDG_RUNTIME_DIR",
    ];
    let keys = if platform == "windows" {
        WINDOWS_KEYS
    } else {
        UNIX_KEYS
    };
    keys.iter()
        .filter_map(|key| get_env(key).map(|value| ((*key).to_string(), value)))
        .collect()
}

fn drain_stderr(stderr: ChildStderr, command: String, private: bool) {
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        while let Ok(Some(line)) = read_bounded_stderr_line(&mut reader).await {
            if private {
                debug!(code = "mcp_private_stderr", "Private MCP stderr received");
            } else {
                let line = redact_mcp_stderr_line(&line);
                debug!(%command, "MCP server stderr: {line}");
            }
        }
    });
}

const MAX_MCP_STDERR_LINE_BYTES: usize = 16 * 1024;

/// Consume the entire diagnostic line without keeping an unbounded allocation.
/// Oversized/invalid UTF-8 lines are omitted, not partially logged, and do not
/// close the pipe: a server writing diagnostics must still finish its stdout RPC.
async fn read_bounded_stderr_line(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
) -> std::io::Result<Option<String>> {
    let mut line = Vec::new();
    let mut oversized = false;
    let mut newline = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            break;
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        newline = available[count - 1] == b'\n';
        if !oversized {
            if count > (MAX_MCP_STDERR_LINE_BYTES + 2).saturating_sub(line.len()) {
                line.clear();
                oversized = true;
            } else {
                line.extend_from_slice(&available[..count]);
            }
        }
        reader.consume(count);
        if newline {
            break;
        }
    }
    if !oversized && line.is_empty() && !newline {
        return Ok(None);
    }
    if newline {
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
    }
    if oversized || line.len() > MAX_MCP_STDERR_LINE_BYTES {
        return Ok(Some("[MCP stderr line omitted: exceeds 16 KiB]".into()));
    }
    Ok(Some(String::from_utf8(line).unwrap_or_else(|_| {
        "[MCP stderr line omitted: invalid UTF-8]".into()
    })))
}

fn redact_mcp_stderr_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if lower.contains("api_key")
        || lower.contains("apikey")
        || lower.contains("authorization")
        || lower.contains("password")
        || lower.contains("token")
        || lower.contains("secret")
        || lower.contains("sk-")
    {
        "[redacted sensitive MCP stderr line]".to_string()
    } else {
        line.to_string()
    }
}

#[async_trait]
impl McpTransport for StdioTransport {
    async fn send(&mut self, line: &str) -> Result<()> {
        // Persist the frame and cursor across future cancellation. A subsequent
        // send completes this exact frame before starting another JSON-RPC line.
        self.flush_pending_write().await?;
        self.pending_write.extend_from_slice(line.as_bytes());
        self.pending_write.push(b'\n');
        self.flush_pending_write().await
    }

    fn is_healthy(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    async fn recv(&mut self) -> Result<Option<String>> {
        // Keep buffered bytes on cancellation; next recv resumes the same frame.
        let line = loop {
            let available = self
                .stdout_lines
                .fill_buf()
                .await
                .context("failed to read from MCP server stdout")?;
            if available.is_empty() {
                if self.stdout_buffer.is_empty() {
                    break None;
                }
                break Some(String::from_utf8(std::mem::take(&mut self.stdout_buffer))?);
            }
            let count = available
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(available.len(), |index| index + 1);
            if self.stdout_buffer.len().saturating_add(count) > crate::sse::MAX_MCP_FRAME_BYTES {
                self.process_tree.terminate();
                return Err(crate::failure::protocol(
                    "MCP stdio frame exceeds 16 MiB limit",
                ));
            }
            let complete = available[count - 1] == b'\n';
            self.stdout_buffer.extend_from_slice(&available[..count]);
            self.stdout_lines.consume(count);
            if complete {
                let mut frame = std::mem::take(&mut self.stdout_buffer);
                frame.pop();
                if frame.last() == Some(&b'\r') {
                    frame.pop();
                }
                break Some(
                    String::from_utf8(frame)
                        .map_err(|_| crate::failure::protocol("invalid UTF-8 MCP frame"))?,
                );
            }
        };
        #[cfg(windows)]
        if line.is_none() && matches!(self.child.try_wait(), Ok(Some(_))) {
            self.process_tree.disarm();
        }
        Ok(line)
    }
}

/// SSE transport for an MCP server over HTTP.
///
/// Opens a streaming GET connection to `sse_url`, waits for the `endpoint`
/// event that tells us where to POST client messages, then routes incoming
/// JSON-RPC responses through an internal channel.
pub struct SseTransport {
    client: reqwest::Client,
    post_url: reqwest::Url,
    receiver: tokio::sync::mpsc::Receiver<String>,
    reader: tokio::task::JoinHandle<()>,
    headers: reqwest::header::HeaderMap,
}

impl SseTransport {
    pub async fn new(sse_url: &str) -> Result<Self> {
        Self::with_headers(sse_url, &HashMap::new()).await
    }

    pub async fn with_headers(sse_url: &str, headers: &HashMap<String, String>) -> Result<Self> {
        // Bound only the TCP/TLS connect: the response body is an infinite
        // event stream and must not carry a total request timeout.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .context("failed to build MCP SSE HTTP client")?;
        let sse_url: reqwest::Url = sse_url
            .parse()
            .map_err(|_| crate::failure::protocol("invalid MCP SSE URL"))?;
        let mut header_map = reqwest::header::HeaderMap::new();
        for (name, value) in headers {
            let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| crate::failure::protocol("invalid MCP SSE header name"))?;
            let mut value = reqwest::header::HeaderValue::from_str(value)
                .map_err(|_| crate::failure::protocol("invalid MCP SSE header value"))?;
            value.set_sensitive(true);
            header_map.insert(name, value);
        }

        let (tx, receiver) = tokio::sync::mpsc::channel::<String>(SSE_MESSAGE_QUEUE_CAPACITY);

        let response = client
            .get(sse_url.clone())
            .headers(header_map.clone())
            .header("accept", "text/event-stream")
            .send()
            .await
            .map_err(|error| anyhow::Error::new(error.without_url()))?;

        if response.status().is_redirection() {
            return Err(crate::failure::protocol(
                "MCP SSE redirects require explicit endpoint configuration",
            ));
        }
        if !response.status().is_success() {
            return Err(response
                .error_for_status()
                .err()
                .map(|error| anyhow::Error::new(error.without_url()))
                .unwrap_or_else(|| {
                    crate::failure::protocol("MCP SSE endpoint returned unexpected HTTP status")
                }));
        }

        let mut post_url: Option<reqwest::Url> = None;
        let mut stream = response.bytes_stream();
        let mut buffer = Vec::new();
        let mut parser = SseParser::default();

        // Read SSE events until we see the endpoint announcement, bounded so
        // a server that accepts the connection but never speaks cannot hang
        // CLI startup forever.
        const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
        let handshake = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| anyhow::Error::new(error.without_url()))?;
                if buffer.len().saturating_add(chunk.len()) > crate::sse::MAX_MCP_FRAME_BYTES {
                    return Err(crate::failure::protocol(
                        "MCP SSE handshake frame exceeds 16 MiB limit",
                    ));
                }
                buffer.extend_from_slice(&chunk);

                while let Some(line) = pop_line(&mut buffer) {
                    if let Some(event) = parser.push_line(&line) {
                        match event {
                            SseEvent::Endpoint(endpoint) => {
                                let endpoint = sse_url.join(&endpoint).map_err(|_| {
                                    crate::failure::protocol("invalid MCP POST endpoint")
                                })?;
                                if endpoint.origin() != sse_url.origin()
                                    || !endpoint.username().is_empty()
                                    || endpoint.password().is_some()
                                {
                                    return Err(crate::failure::protocol(
                                        "MCP SSE POST endpoint changed the configured origin",
                                    ));
                                }
                                post_url = Some(endpoint);
                            }
                            SseEvent::Message(data) => {
                                enqueue_sse_message(&tx, data);
                            }
                            SseEvent::LimitExceeded => {
                                return Err(crate::failure::protocol(
                                    "MCP SSE event exceeds 16 MiB limit",
                                ));
                            }
                            SseEvent::Comment | SseEvent::Empty => {}
                        }
                    }
                    if post_url.is_some() {
                        break;
                    }
                }
                if post_url.is_some() {
                    break;
                }
            }
            Ok::<_, anyhow::Error>((stream, buffer, parser, post_url))
        };
        let (stream, buffer, parser, post_url) =
            match tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await {
                Ok(result) => result?,
                Err(_) => {
                    return Err(crate::failure::timeout(
                        "MCP SSE endpoint did not announce a POST endpoint within 30s",
                    ));
                }
            };

        let post_url = post_url.ok_or_else(|| {
            crate::failure::protocol("MCP SSE stream did not announce a POST endpoint")
        })?;

        // Continue draining the SSE stream in the background.
        let reader = tokio::spawn(drain_sse_stream(stream, buffer, parser, tx));

        Ok(Self {
            client,
            post_url,
            receiver,
            reader,
            headers: header_map,
        })
    }
}

impl Drop for SseTransport {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

#[async_trait]
impl McpTransport for SseTransport {
    async fn send(&mut self, line: &str) -> Result<()> {
        let response = self
            .client
            .post(self.post_url.clone())
            .headers(self.headers.clone())
            .header("content-type", "application/json")
            .body(line.to_string())
            // A hung POST must not stall the request loop indefinitely.
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .map_err(|error| anyhow::Error::new(error.without_url()))?;
        if response.status().is_redirection() {
            return Err(crate::failure::protocol(
                "MCP SSE redirects require explicit endpoint configuration",
            ));
        }
        response
            .error_for_status()
            .map_err(|error| anyhow::Error::new(error.without_url()))?;
        Ok(())
    }

    fn is_healthy(&mut self) -> bool {
        !self.reader.is_finished() && !self.receiver.is_closed()
    }

    async fn recv(&mut self) -> Result<Option<String>> {
        let message = self.receiver.recv().await;
        if message.as_deref() == Some(crate::sse::FRAME_LIMIT_ERROR) {
            return Err(crate::failure::protocol(
                "MCP SSE frame exceeds 16 MiB limit",
            ));
        }
        Ok(message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dropping_transport_aborts_owned_stream_reader() {
        struct Guard(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Guard {
            fn drop(&mut self) {
                let _ = self.0.take().unwrap().send(());
            }
        }
        let (dropped, done) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            let _guard = Guard(Some(dropped));
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        drop(sender);
        let transport = SseTransport {
            client: reqwest::Client::new(),
            receiver,
            post_url: "http://127.0.0.1/messages".parse().unwrap(),
            reader,
            headers: reqwest::header::HeaderMap::new(),
        };
        drop(transport);
        tokio::time::timeout(std::time::Duration::from_secs(1), done)
            .await
            .unwrap()
            .unwrap();
    }

    #[cfg(unix)]
    async fn assert_descendant_cleanup_after_leader_exit(receive_eof: bool) {
        // Fallback cleanup for the independent process group; assertion failures must not leave test processes behind.
        struct GroupCleanup(libc::pid_t);
        impl Drop for GroupCleanup {
            fn drop(&mut self) {
                unsafe {
                    libc::kill(-self.0, libc::SIGKILL);
                }
            }
        }
        let args = vec![
            "-c".to_string(),
            "sleep 60 </dev/null >/dev/null 2>&1 & echo $!; exit 0".to_string(),
        ];
        let mut transport = StdioTransport::new("/bin/sh", &args, &HashMap::new())
            .await
            .unwrap();
        let _cleanup = GroupCleanup(transport.child.id().unwrap() as libc::pid_t);
        let descendant: libc::pid_t =
            tokio::time::timeout(std::time::Duration::from_secs(5), transport.recv())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .trim()
                .parse()
                .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), transport.child.wait())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unsafe { libc::kill(descendant, 0) }, 0);
        if receive_eof {
            assert!(transport.recv().await.unwrap().is_none());
        }
        drop(transport);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if unsafe { libc::kill(descendant, 0) } != 0 {
                    assert_eq!(
                        std::io::Error::last_os_error().raw_os_error(),
                        Some(libc::ESRCH)
                    );
                    break;
                }
                // Linux orphans may wait for init to reap them; zombies have exited and hold no live resources.
                #[cfg(target_os = "linux")]
                if let Ok(stat) = std::fs::read_to_string(format!("/proc/{descendant}/stat"))
                    && stat
                        .rsplit_once(") ")
                        .is_some_and(|(_, rest)| rest.starts_with("Z "))
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("leader 已退出时释放 MCP 传输仍必须终止其后代");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn drop_cleans_descendants_after_leader_exited() {
        assert_descendant_cleanup_after_leader_exit(false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn eof_does_not_disarm_descendant_cleanup_after_leader_exited() {
        assert_descendant_cleanup_after_leader_exit(true).await;
    }

    #[test]
    fn windows_stdio_environment_keeps_runtime_variables_but_not_secrets() {
        let values = HashMap::from([
            ("SystemRoot", r"C:\Windows"),
            ("PATH", r"C:\Windows\System32"),
            ("TEMP", r"C:\Temp"),
            ("OPENAI_API_KEY", "must-not-leak"),
        ]);
        let env = minimal_process_env_for("windows", |name| {
            values.get(name).map(|value| (*value).to_string())
        });
        assert_eq!(
            env.get("SystemRoot").map(String::as_str),
            Some(r"C:\Windows")
        );
        assert_eq!(env.get("TEMP").map(String::as_str), Some(r"C:\Temp"));
        assert!(!env.contains_key("OPENAI_API_KEY"));
    }

    #[test]
    fn configured_mcp_environment_can_override_the_minimal_environment() {
        let configured = HashMap::from([
            ("PATH".to_string(), "configured-path".to_string()),
            ("MCP_TOKEN".to_string(), "explicit-token".to_string()),
        ]);
        let env = stdio_child_env(&configured);
        assert_eq!(env.get("PATH").map(String::as_str), Some("configured-path"));
        assert_eq!(
            env.get("MCP_TOKEN").map(String::as_str),
            Some("explicit-token")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mcp_stderr_invalid_utf8_and_large_line_do_not_block_protocol_stdout() {
        // Model-independent process plumbing: malformed diagnostics must not stop
        // the stderr drain and deadlock a well-formed stdout protocol frame.
        let args = vec![
            "-c".into(),
            "printf '\\377\\n' >&2; head -c 262144 /dev/zero >&2 || exit 7; printf '{\"ready\":true}\\n'"
                .into(),
        ];
        let mut transport = StdioTransport::new("/bin/sh", &args, &HashMap::new())
            .await
            .unwrap();
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), transport.recv())
            .await
            .expect("stderr diagnostics must remain drained")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&frame).unwrap(),
            serde_json::json!({"ready":true})
        );
    }

    #[tokio::test]
    async fn mcp_stderr_bounded_lines_resume_after_oversized_or_invalid_diagnostics() {
        let exact = "é".repeat(MAX_MCP_STDERR_LINE_BYTES / 2);
        let mut bytes = exact.as_bytes().to_vec();
        bytes.extend(b"\r\n");
        bytes.extend(vec![b'x'; MAX_MCP_STDERR_LINE_BYTES * 8]);
        bytes.extend(b"SENTINEL_SECRET\n");
        bytes.extend([0xff, b'\n']);
        bytes.extend(b"server ready\r\n");
        let mut reader = BufReader::new(std::io::Cursor::new(bytes));
        assert_eq!(
            read_bounded_stderr_line(&mut reader)
                .await
                .unwrap()
                .unwrap(),
            exact
        );
        assert_eq!(
            read_bounded_stderr_line(&mut reader)
                .await
                .unwrap()
                .unwrap(),
            "[MCP stderr line omitted: exceeds 16 KiB]"
        );
        assert_eq!(
            read_bounded_stderr_line(&mut reader)
                .await
                .unwrap()
                .unwrap(),
            "[MCP stderr line omitted: invalid UTF-8]"
        );
        assert_eq!(
            read_bounded_stderr_line(&mut reader)
                .await
                .unwrap()
                .unwrap(),
            "server ready"
        );
        assert!(
            read_bounded_stderr_line(&mut reader)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn mcp_stderr_redacts_sensitive_lines() {
        assert_eq!(
            redact_mcp_stderr_line("OPENAI_API_KEY=sk-secret-value"),
            "[redacted sensitive MCP stderr line]"
        );
        assert_eq!(
            redact_mcp_stderr_line("Authorization: Bearer token-value"),
            "[redacted sensitive MCP stderr line]"
        );
        assert_eq!(redact_mcp_stderr_line("server ready"), "server ready");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdio_transport_uses_minimal_and_explicit_environment() {
        let mut env = HashMap::new();
        env.insert("KCODER_MCP_ALLOWED".to_string(), "yes".to_string());

        let mut transport = StdioTransport::new("/usr/bin/env", &[], &env)
            .await
            .unwrap();
        let mut lines = Vec::new();
        while let Some(line) = transport.recv().await.unwrap() {
            lines.push(line);
        }

        assert!(lines.iter().any(|line| line == "KCODER_MCP_ALLOWED=yes"));
        if let Ok(path) = std::env::var("PATH") {
            assert!(lines.iter().any(|line| line == &format!("PATH={path}")));
        }
        if let Ok(home) = std::env::var("HOME") {
            assert!(lines.iter().any(|line| line == &format!("HOME={home}")));
        }
        assert!(!lines.iter().any(|line| line.starts_with("CARGO_HOME=")));
        assert!(!lines.iter().any(|line| line.starts_with("OPENAI_API_KEY=")));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stdio_transport_uses_minimal_and_explicit_windows_environment() {
        let env = HashMap::from([("KCODER_MCP_ALLOWED".to_string(), "windows-yes".to_string())]);
        let args = vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            "Get-ChildItem Env: | ForEach-Object { '{0}={1}' -f $_.Name, $_.Value }".to_string(),
        ];

        let mut transport = StdioTransport::new("powershell.exe", &args, &env)
            .await
            .unwrap();
        let mut lines = Vec::new();
        while let Some(line) = transport.recv().await.unwrap() {
            lines.push(line);
        }
        let upper = lines
            .iter()
            .map(|line| line.to_ascii_uppercase())
            .collect::<Vec<_>>();

        assert!(
            upper
                .iter()
                .any(|line| line == "KCODER_MCP_ALLOWED=WINDOWS-YES"),
            "{lines:?}"
        );
        assert!(
            upper.iter().any(|line| line.starts_with("SYSTEMROOT=")),
            "{lines:?}"
        );
        assert!(
            upper.iter().any(|line| line.starts_with("PATH=")),
            "{lines:?}"
        );
        assert!(
            !upper.iter().any(|line| line.starts_with("CARGO_HOME=")),
            "{lines:?}"
        );
        assert!(
            !upper.iter().any(|line| line.starts_with("OPENAI_API_KEY=")),
            "{lines:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_stdio_transport_terminates_the_unix_process_group() {
        let pid_path = std::env::temp_dir().join(format!(
            "kcoder-mcp-child-{}-{}.pid",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let script = format!(
            "sleep 60 & child=$!; printf '%s' \"$child\" > '{}'; wait",
            pid_path.display()
        );
        let args = vec!["-c".to_string(), script];
        let transport = StdioTransport::new("/bin/sh", &args, &HashMap::new())
            .await
            .unwrap();

        let child_pid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(&pid_path).await
                    && let Ok(pid) = text.trim().parse::<libc::pid_t>()
                {
                    break pid;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("MCP child process did not publish its PID");

        drop(transport);
        let terminated = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if unsafe { libc::kill(child_pid, 0) } != 0 {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();
        let _ = tokio::fs::remove_file(&pid_path).await;

        if !terminated {
            unsafe {
                let _ = libc::kill(child_pid, libc::SIGKILL);
            }
        }
        assert!(
            terminated,
            "dropping MCP transport left child PID {child_pid}"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn dropping_stdio_transport_terminates_the_windows_process_tree() {
        let pid_path = std::env::temp_dir().join(format!(
            "kcoder-mcp-child-{}-{}.pid",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let escaped_pid_path = pid_path.display().to_string().replace('\'', "''");
        let script = format!(
            "$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; $child.Id | Set-Content -LiteralPath '{escaped_pid_path}'; Start-Sleep -Seconds 60"
        );
        let args = vec![
            "-NoLogo".to_string(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            script,
        ];
        let transport = StdioTransport::new("powershell.exe", &args, &HashMap::new())
            .await
            .unwrap();

        let child_pid = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Ok(text) = tokio::fs::read_to_string(&pid_path).await {
                    if let Ok(pid) = text.trim().parse::<u32>() {
                        break pid;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("MCP child process did not publish its PID");

        drop(transport);
        let terminated = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let status = std::process::Command::new("powershell.exe")
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-Command",
                        &format!("Get-Process -Id {child_pid} -ErrorAction SilentlyContinue"),
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .unwrap();
                if !status.success() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .is_ok();
        let _ = tokio::fs::remove_file(&pid_path).await;

        if !terminated {
            let _ = std::process::Command::new("taskkill.exe")
                .args(["/PID", &child_pid.to_string(), "/T", "/F"])
                .status();
        }
        assert!(
            terminated,
            "dropping MCP transport left child PID {child_pid}"
        );
    }
}
