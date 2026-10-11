//! Windows-MCP adapter sharing the normal MCP protocol client. Desktop ownership
//! and permission must be established by the host before this adapter is called.
use crate::desktop_stdio_codec::bounded_line;
use crate::{McpClient, model::McpToolDefinition, transport::McpTransport};
use anyhow::{Result, ensure};
use async_trait::async_trait;
use kcoder_computer_use::{
    desktop::inspect_interactive_desktop,
    launch::worker_command,
    runtime::VerifiedRuntime,
    windows_process::JobChild,
    windows_recovery_client::RecoveryControl,
    worker::{DesktopWorker, WorkerError},
};
use serde_json::Value;
use std::{
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, sync::mpsc};

pub struct WindowsDesktopWorker {
    client: McpClient,
    child: Arc<Mutex<JobChild>>,
    pub tools: Vec<McpToolDefinition>,
    input: Arc<kcoder_computer_use::windows_input_observer::InputObserver>,
    recovery: RecoveryControl<tokio::net::windows::named_pipe::NamedPipeServer>,
    session_id: u32,
    cleaned: bool,
    _reservation: kcoder_computer_use::windows_exclusive::DesktopReservation,
}
impl WindowsDesktopWorker {
    /// Running this creates a desktop-capable process. Call only after user
    /// permission, lease acquisition and trusted runtime verification.
    pub async fn start(runtime: &VerifiedRuntime, temp: &Path) -> Result<Self> {
        let desktop = inspect_interactive_desktop()
            .map_err(|error| anyhow::anyhow!("desktop preflight: {error:?}"))?;
        let reservation = kcoder_computer_use::windows_exclusive::DesktopReservation::acquire()?;
        let input = kcoder_computer_use::windows_input_observer::InputObserver::start()?;
        let recovery_started = std::time::Instant::now();
        let prepared = crate::desktop_recovery_launch::prepare(input.tag() as u32).await?;
        tracing::info!(
            elapsed_ms = recovery_started.elapsed().as_millis() as u64,
            "desktop recovery startup completed"
        );
        let mut command = worker_command(runtime, temp)?;
        command.env("KCODER_DESKTOP_INPUT_TAG", input.tag().to_string());
        command.env(
            "KCODER_DESKTOP_RECOVERY_PID",
            prepared.process_id().to_string(),
        );
        let mut child = JobChild::spawn_for_desktop(&command, &reservation)?;
        let mut recovery = match prepared.attach(&child).await {
            Ok(recovery) => recovery,
            Err(error) => {
                child.terminate_and_wait(Duration::from_secs(5))?;
                input.shutdown();
                return Err(error);
            }
        };
        let stdin = tokio::fs::File::from_std(child.stdin.take().unwrap());
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let (sender, receiver) = mpsc::channel(2);
        std::thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            loop {
                let next = bounded_line(&mut reader);
                let stop = !matches!(next, Ok(Some(_)));
                if sender.blocking_send(next).is_err() || stop {
                    break;
                }
            }
        });
        // Do not log upstream stderr verbatim: UI text/clipboard can be present.
        std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut bytes = [0; 8192];
            while matches!(stderr.read(&mut bytes),Ok(n) if n>0) {}
        });
        let transport = DesktopStdio {
            stdin,
            receiver,
            _child: child.clone(),
        };
        let mut client = McpClient::with_transport(Box::new(transport));
        let initialization_started = std::time::Instant::now();
        let initialized = async {
            client.initialize().await?;
            let tools = client.list_tools().await?;
            ensure!(
                tools
                    .iter()
                    .all(|tool| kcoder_computer_use::policy::TOOLS.contains(&tool.name.as_str())),
                "desktop worker exposed unexpected tools"
            );
            ensure!(
                tools.iter().any(|tool| tool.name == "Screenshot"),
                "desktop worker has no Screenshot tool"
            );
            Ok::<_, anyhow::Error>(tools)
        }
        .await;
        tracing::info!(
            elapsed_ms = initialization_started.elapsed().as_millis() as u64,
            success = initialized.is_ok(),
            "desktop MCP initialization completed"
        );
        match initialized {
            Ok(tools) => Ok(Self {
                client,
                child,
                tools,
                input,
                recovery,
                session_id: desktop.session_id,
                cleaned: false,
                _reservation: reservation,
            }),
            Err(error) => {
                // Finish process cleanup even when initialize/list_tools fails.
                let owned = child.clone();
                let observer = input.clone();
                let cleanup = tokio::task::spawn_blocking(move || {
                    cleanup_input(&owned, &observer, desktop.session_id)
                })
                .await;
                let recovery_cleanup = recovery.stop().await;
                cleanup??;
                recovery_cleanup?;
                Err(error)
            }
        }
    }
    pub(crate) fn process_liveness(&self) -> Arc<Mutex<JobChild>> {
        self.child.clone()
    }
    pub(crate) fn process_id(&self) -> Option<u32> {
        self.child.lock().ok().map(|child| child.pid)
    }
    pub(crate) fn input_observer(
        &self,
    ) -> Arc<kcoder_computer_use::windows_input_observer::InputObserver> {
        self.input.clone()
    }
    pub(crate) fn recovery_peer(&self) -> Arc<kcoder_computer_use::windows_peer::VerifiedPeer> {
        self.recovery.peer()
    }
}
fn cleanup_input(
    child: &Mutex<JobChild>,
    input: &kcoder_computer_use::windows_input_observer::InputObserver,
    session_id: u32,
) -> Result<()> {
    let mut child = child
        .lock()
        .map_err(|_| anyhow::anyhow!("worker process lock poisoned"))?;
    kcoder_computer_use::windows_input_release::terminate_and_release(
        &mut child,
        input.ownership(),
        session_id,
        input.tag(),
        Duration::from_secs(5),
    )?;
    input.shutdown();
    Ok(())
}
impl Drop for WindowsDesktopWorker {
    fn drop(&mut self) {
        if !self.cleaned {
            if let Err(error) = cleanup_input(&self.child, &self.input, self.session_id) {
                tracing::warn!(%error, "desktop fallback cleanup was not confirmed");
            }
        }
    }
}
#[async_trait]
impl DesktopWorker for WindowsDesktopWorker {
    fn can_continue_after_tool_error(&self) -> bool {
        inspect_interactive_desktop().is_ok()
            && self.input.healthy()
            && self.recovery.healthy()
            && self
                .input
                .ownership()
                .lock()
                .is_ok_and(|ledger| ledger.is_quiescent())
    }
    async fn call(&mut self, tool: &str, arguments: Value) -> Result<Value, WorkerError> {
        inspect_interactive_desktop().map_err(|error| {
            WorkerError::Unavailable(
                if matches!(
                    error,
                    kcoder_computer_use::desktop::DesktopPreflightError::DesktopLocked
                ) {
                    "desktop_locked"
                } else {
                    "desktop_unavailable"
                },
            )
        })?;
        if !self.input.healthy() {
            return Err(WorkerError::Unavailable("input_observer_unavailable"));
        }
        if !self.recovery.healthy() {
            return Err(WorkerError::Unavailable("recovery_process_exited"));
        }
        if !kcoder_computer_use::policy::TOOLS.contains(&tool) || !arguments.is_object() {
            return Err(WorkerError::Failed("desktop tool not allowed".into()));
        }
        // Mirrors the pinned service's plain-long-text paste branch. Other
        // inputs continue through its escaped keyboard path.
        let paste = tool == "Type"
            && arguments
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| {
                    text.chars().count() >= 20 && !text.contains(['\n', '\t', '{', '}'])
                });
        if paste {
            let text = arguments["text"].as_str().unwrap().to_owned();
            self.recovery
                .prepare_paste(text)
                .await
                .map_err(|error| WorkerError::Failed(error.to_string()))?;
        }
        let call_started = std::time::Instant::now();
        let result = self.client.call_tool(tool, arguments).await;
        tracing::info!(
            tool,
            elapsed_ms = call_started.elapsed().as_millis() as u64,
            transport_ok = result.is_ok(),
            "desktop tool response received"
        );
        if paste {
            self.recovery
                .finish_paste()
                .await
                .map_err(|error| WorkerError::Failed(error.to_string()))?;
        }
        let result = result.map_err(|error| {
            if self
                .child
                .try_lock()
                .is_ok_and(|child| child.is_running().is_ok_and(|running| !running))
            {
                WorkerError::Unavailable("worker_exited")
            } else {
                WorkerError::Failed(error.to_string())
            }
        })?;
        serde_json::to_value(result).map_err(|error| WorkerError::Failed(error.to_string()))
    }
    async fn shutdown(&mut self) -> Result<(), WorkerError> {
        let child = self.child.clone();
        let input = self.input.clone();
        let session_id = self.session_id;
        let result = tokio::task::spawn_blocking(move || cleanup_input(&child, &input, session_id))
            .await
            .map_err(|error| WorkerError::CleanupFailed(error.to_string()))
            .and_then(|value| value.map_err(|error| WorkerError::CleanupFailed(error.to_string())));
        let recovery = self
            .recovery
            .stop()
            .await
            .map_err(|error| WorkerError::CleanupFailed(error.to_string()));
        if let Err(error) = &result {
            tracing::warn!(?error, "desktop worker/input cleanup failed");
        }
        if let Err(error) = &recovery {
            tracing::warn!(?error, "desktop recovery/clipboard cleanup failed");
        }
        let result = result.and(recovery);
        self.cleaned = result.is_ok();
        result
    }
}
struct DesktopStdio {
    stdin: tokio::fs::File,
    receiver: mpsc::Receiver<Result<Option<String>>>,
    _child: Arc<Mutex<JobChild>>,
}
#[async_trait]
impl McpTransport for DesktopStdio {
    async fn send(&mut self, line: &str) -> Result<()> {
        ensure!(
            line.len() <= crate::sse::MAX_MCP_FRAME_BYTES && !line.contains('\n'),
            "invalid desktop MCP request frame"
        );
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.write_all(b"\n").await?;
        self.stdin.flush().await?;
        Ok(())
    }
    async fn recv(&mut self) -> Result<Option<String>> {
        self.receiver.recv().await.unwrap_or(Ok(None))
    }
}
