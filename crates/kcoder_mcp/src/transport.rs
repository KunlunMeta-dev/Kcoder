use crate::sse::{
    SSE_MESSAGE_QUEUE_CAPACITY, SseEvent, SseParser, drain_sse_stream, enqueue_sse_message,
    pop_line,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStderr, ChildStdout};
use tracing::debug;

/// Transport abstraction for MCP communication.
#[async_trait]
pub trait McpTransport: Send + Sync {
    /// Send a single JSON-RPC line.
    async fn send(&mut self, line: &str) -> Result<()>;

    /// Receive the next JSON-RPC line, if any.
    async fn recv(&mut self) -> Result<Option<String>>;

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
    stdout_lines: Lines<BufReader<ChildStdout>>,
}

impl StdioTransport {
    pub async fn new(
        command: &str,
        args: &[String],
        env: &HashMap<String, String>,
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
            drain_stderr(stderr, command.to_string());
        }
        let stdout_lines = BufReader::new(stdout).lines();

        Ok(Self {
            process_tree: StdioProcessTreeTerminator::new(child_pid),
            child,
            stdin,
            stdout_lines,
        })
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

fn drain_stderr(stderr: ChildStderr, command: String) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = redact_mcp_stderr_line(&line);
            debug!(%command, "MCP server stderr: {line}");
        }
    });
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
        self.stdin
            .write_all(line.as_bytes())
            .await
            .context("failed to write to MCP server stdin")?;
        self.stdin
            .write_all(b"\n")
            .await
            .context("failed to write newline to MCP server stdin")?;
        self.stdin
            .flush()
            .await
            .context("failed to flush MCP server stdin")?;
        Ok(())
    }

    async fn recv(&mut self) -> Result<Option<String>> {
        let line = self
            .stdout_lines
            .next_line()
            .await
            .context("failed to read from MCP server stdout")?;
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
}

impl SseTransport {
    pub async fn new(sse_url: &str) -> Result<Self> {
        // Bound only the TCP/TLS connect: the response body is an infinite
        // event stream and must not carry a total request timeout.
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .context("failed to build MCP SSE HTTP client")?;
        let sse_url: reqwest::Url = sse_url
            .parse()
            .with_context(|| format!("invalid MCP SSE URL: {}", sse_url))?;

        let (tx, receiver) = tokio::sync::mpsc::channel::<String>(SSE_MESSAGE_QUEUE_CAPACITY);

        let response = client
            .get(sse_url.clone())
            .send()
            .await
            .with_context(|| format!("failed to connect to MCP SSE endpoint {}", sse_url))?;

        if !response.status().is_success() {
            anyhow::bail!(
                "MCP SSE endpoint returned {}: {}",
                response.status(),
                response.text().await.unwrap_or_default()
            );
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
                let chunk = chunk.context("failed to read MCP SSE stream")?;
                buffer.extend_from_slice(&chunk);

                while let Some(line) = pop_line(&mut buffer) {
                    if let Some(event) = parser.push_line(&line) {
                        match event {
                            SseEvent::Endpoint(endpoint) => {
                                post_url = Some(sse_url.join(&endpoint).with_context(|| {
                                    format!("invalid MCP POST endpoint: {}", endpoint)
                                })?);
                            }
                            SseEvent::Message(data) => {
                                enqueue_sse_message(&tx, data);
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
                Err(_) => anyhow::bail!(
                    "MCP SSE endpoint did not announce a POST endpoint within {}s",
                    HANDSHAKE_TIMEOUT.as_secs()
                ),
            };

        let post_url = post_url.context("MCP SSE stream did not announce a POST endpoint")?;

        // Continue draining the SSE stream in the background.
        tokio::spawn(drain_sse_stream(stream, buffer, parser, tx));

        Ok(Self {
            client,
            post_url,
            receiver,
        })
    }
}

#[async_trait]
impl McpTransport for SseTransport {
    async fn send(&mut self, line: &str) -> Result<()> {
        self.client
            .post(self.post_url.clone())
            .header("content-type", "application/json")
            .body(line.to_string())
            // A hung POST must not stall the request loop indefinitely.
            .timeout(std::time::Duration::from_secs(60))
            .send()
            .await
            .with_context(|| format!("failed to POST to MCP endpoint {}", self.post_url))?
            .error_for_status()
            .with_context(|| format!("MCP endpoint returned error for {}", self.post_url))?;
        Ok(())
    }

    async fn recv(&mut self) -> Result<Option<String>> {
        Ok(self.receiver.recv().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
