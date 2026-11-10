//! One private app-server transport and process owner per ACP session.
#[cfg(any(unix, windows))]
use crate::framing::{Frame, FrameReader};
use crate::queue::WireSender;
#[cfg(any(unix, windows))]
use crate::queue::wire_queue;
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
#[cfg(any(unix, windows))]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(any(unix, windows))]
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Launch configuration is private and deliberately has no Debug implementation.
#[derive(Clone)]
pub struct AppServerConfig {
    pub executable: PathBuf,
    pub args: Vec<OsString>,
    /// None inherits the launcher environment; Some supplies an exact private environment.
    pub environment: Option<BTreeMap<OsString, OsString>>,
}

mod owned_frames;

type Pending = Arc<Mutex<BTreeMap<u64, oneshot::Sender<Value>>>>;

/// Native-only process facts; no JSON or PID string constructs this observation.
#[derive(Clone)]
pub(crate) struct OwnedExitObservation {
    exited: Arc<AtomicBool>,
    tree: Arc<AtomicBool>,
    native_wrapper: bool,
}
impl OwnedExitObservation {
    pub(crate) fn backend_exited(&self) -> bool {
        self.exited.load(Ordering::SeqCst) && (!self.native_wrapper || self.tree_confirmed())
    }
    pub(crate) fn tree_confirmed(&self) -> bool {
        self.tree.load(Ordering::SeqCst)
    }
    #[cfg(test)]
    pub(crate) fn test_observation(exited: Arc<AtomicBool>, tree: Arc<AtomicBool>) -> Self {
        Self {
            exited,
            tree,
            native_wrapper: false,
        }
    }
}

#[derive(Clone)]
pub(crate) struct NativeUpstreamControl {
    sender: WireSender,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    closed: CancellationToken,
}
impl NativeUpstreamControl {
    pub(crate) async fn request(
        &self,
        frame: &kcoder_types::integrations::core::NativeRemoteControlFrameV1,
        cancelled: &CancellationToken,
    ) -> Result<Value> {
        use kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD;
        ensure!(
            !self.closed.is_cancelled(),
            "REMOTE_CONTROL_RECEIVER_CLOSED"
        );
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (send, receive) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            ensure!(pending.len() < 16, "REMOTE_CONTROL_PENDING_CAPACITY");
            pending.insert(id, send);
        }
        let _registration = PendingCall {
            pending: self.pending.clone(),
            id,
        };
        let wait = async {
            self.sender.send(json!({"jsonrpc":"2.0","id":id,"method":NATIVE_REMOTE_CONTROL_METHOD,"params":frame})).await?;
            let reply = receive
                .await
                .map_err(|_| anyhow::anyhow!("REMOTE_CONTROL_RECEIVER_RECEIPT_UNKNOWN"))?;
            ensure!(
                reply.get("error").is_none(),
                "REMOTE_CONTROL_RECEIVER_UNAVAILABLE"
            );
            reply
                .get("result")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("REMOTE_CONTROL_RECEIVER_REPLY_INVALID"))
        };
        tokio::select! {biased;
            _=cancelled.cancelled()=>bail!("REMOTE_CONTROL_RECEIVER_RECEIPT_UNKNOWN"),
            _=self.closed.cancelled()=>bail!("REMOTE_CONTROL_RECEIVER_RECEIPT_UNKNOWN"),
            result=tokio::time::timeout(Duration::from_secs(30),wait)=>result.map_err(|_|anyhow::anyhow!("REMOTE_CONTROL_RECEIVER_RECEIPT_UNKNOWN"))?,
        }
    }
}

pub(crate) struct Upstream {
    sender: WireSender,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    owned_pid: u32,
    native_endpoint: Option<String>,
    cleanup_confirmed: Arc<AtomicBool>,
    owned_exit: Arc<AtomicBool>,
    #[cfg(target_os = "linux")]
    owner_control: Option<Arc<kcoder_process_supervisor::linux_stdio::StdioOwnerGuard>>,
    closed: CancellationToken,
    worker: Option<JoinHandle<()>>,
    pub(crate) lifecycle: crate::diagnostics::Lifecycle,
    pub(crate) events: mpsc::Receiver<crate::queue::QueuedFrame>,
}

impl Upstream {
    #[cfg(all(test, unix))]
    pub(crate) fn spawn(config: &AppServerConfig, cwd: &Path) -> Result<Self> {
        Self::spawn_traced(config, cwd, crate::diagnostics::Lifecycle::default())
    }

    pub(crate) fn spawn_traced(
        config: &AppServerConfig,
        cwd: &Path,
        lifecycle: crate::diagnostics::Lifecycle,
    ) -> Result<Self> {
        Self::spawn_transport(config, Some(cwd), lifecycle, false)
    }

    pub(crate) fn spawn_traced_stdio_owner(
        config: &AppServerConfig,
        cwd: &Path,
        lifecycle: crate::diagnostics::Lifecycle,
    ) -> Result<Self> {
        Self::spawn_transport(config, Some(cwd), lifecycle, cfg!(target_os = "linux"))
    }

    /// Native preparation inherits this ACP process's actual kernel cwd. No
    /// session/new path is allowed to choose a different receiver namespace.
    pub(crate) fn spawn_native_original(
        config: &AppServerConfig,
        lifecycle: crate::diagnostics::Lifecycle,
    ) -> Result<Self> {
        #[cfg(all(target_os = "linux", not(test)))]
        {
            use kcoder_process_supervisor::linux_stdio::{
                INTERNAL_COMMAND_OWNER_RECEIPT_V1, OwnedCleanupReceipt,
            };
            let receipt = Arc::new(OwnedCleanupReceipt::create()?);
            let mut owned = config.clone();
            owned.args = vec![
                INTERNAL_COMMAND_OWNER_RECEIPT_V1.into(),
                std::process::id().to_string().into(),
                receipt.descriptor().to_string().into(),
                config.executable.as_os_str().to_owned(),
            ];
            owned.args.extend(config.args.iter().cloned());
            Self::spawn_transport_inner(&owned, None, lifecycle, true, Some(receipt))
        }
        #[cfg(any(not(target_os = "linux"), test))]
        Self::spawn_transport(config, None, lifecycle, false)
    }

    fn spawn_transport(
        config: &AppServerConfig,
        cwd: Option<&Path>,
        lifecycle: crate::diagnostics::Lifecycle,
        owns_stdio_wrapper: bool,
    ) -> Result<Self> {
        Self::spawn_transport_inner(config, cwd, lifecycle, owns_stdio_wrapper, None)
    }

    fn spawn_transport_inner(
        config: &AppServerConfig,
        cwd: Option<&Path>,
        lifecycle: crate::diagnostics::Lifecycle,
        owns_stdio_wrapper: bool,
        #[cfg(target_os = "linux")] native_receipt: Option<
            Arc<kcoder_process_supervisor::linux_stdio::OwnedCleanupReceipt>,
        >,
        #[cfg(not(target_os = "linux"))] _native_receipt: Option<()>,
    ) -> Result<Self> {
        ensure!(
            config.executable.is_absolute(),
            "ACP executable must be absolute"
        );
        #[cfg(not(any(unix, windows)))]
        {
            let _ = cwd;
            bail!("ACP session process ownership is not implemented on this platform yet");
        }
        #[cfg(any(unix, windows))]
        {
            let mut command = tokio::process::Command::new(&config.executable);
            if let Some(environment) = &config.environment {
                command.env_clear().envs(environment);
            }
            command
                .args(&config.args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(!owns_stdio_wrapper);
            if let Some(cwd) = cwd {
                command.current_dir(cwd);
            }
            #[cfg(target_os = "linux")]
            if let Some(receipt) = &native_receipt {
                let fd = receipt.descriptor();
                // SAFETY: only the private original receipt FD is inherited by
                // the fixed owner, whose entry clears it before target exec.
                unsafe {
                    command.pre_exec(move || {
                        if libc::fcntl(fd, libc::F_SETFD, 0) < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        Ok(())
                    });
                }
            }
            #[cfg(unix)]
            command.process_group(0);
            #[cfg(windows)]
            command
                .creation_flags(kcoder_process_supervisor::suspended_child::SUSPENDED_CHILD_FLAGS);
            #[cfg(windows)]
            let mut tree = kcoder_process_supervisor::suspended_child::SuspendedChildJob::new()?;
            let mut child = command
                .spawn()
                .map_err(|_| anyhow::anyhow!("Cannot launch the owned ACP app-server"))?;
            let owned_pid = child
                .id()
                .ok_or_else(|| anyhow::anyhow!("Owned app-server has no process ID"))?;
            #[cfg(target_os = "linux")]
            let stdio_owner = if owns_stdio_wrapper {
                match kcoder_process_supervisor::linux_stdio::StdioOwnerGuard::for_child(owned_pid)
                {
                    Ok(owner) => Some(Arc::new(owner)),
                    Err(error) => {
                        let _ = child.start_kill();
                        return Err(error);
                    }
                }
            } else {
                None
            };
            let lifecycle = lifecycle.process(owned_pid);
            lifecycle.record("process", "session_create", "spawned");
            #[cfg(unix)]
            let mut tree =
                ProcessTree(Some(child.id().ok_or_else(|| {
                    anyhow::anyhow!("Owned app-server has no process ID")
                })?));
            #[cfg(windows)]
            {
                let raw = child
                    .raw_handle()
                    .ok_or_else(|| anyhow::anyhow!("Owned process handle unavailable"))?;
                // SAFETY: child remains alive and unpolled for this borrow.
                let process = unsafe { std::os::windows::io::BorrowedHandle::borrow_raw(raw) };
                tree.assign_and_resume(process)?;
            }
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| anyhow::anyhow!("Owned stdin unavailable"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| anyhow::anyhow!("Owned stdout unavailable"))?;
            let (sender, mut outgoing) = wire_queue();
            let (event_sender, events) = wire_queue();
            let pending: Pending = Arc::default();
            let waiting = pending.clone();
            let closed = CancellationToken::new();
            let shutdown = closed.clone();
            let worker_lifecycle = lifecycle.clone();
            let cleanup_confirmed = Arc::new(AtomicBool::new(false));
            let worker_cleanup_confirmed = cleanup_confirmed.clone();
            let owned_exit = Arc::new(AtomicBool::new(false));
            let worker_exit = owned_exit.clone();
            #[cfg(target_os = "linux")]
            let owner_control = stdio_owner.clone();
            let worker = tokio::spawn(async move {
                // Both pumps are scoped to the owner, including partially written frames.
                let reading = waiting.clone();
                let reader = async move {
                    let mut frames = FrameReader::new(BufReader::new(stdout));
                    while let Some(frame) = frames.next().await? {
                        let Frame::Json(value) = frame else {
                            bail!("Invalid app-server frame")
                        };
                        ensure!(value["jsonrpc"] == "2.0", "Invalid app-server envelope");
                        if value.get("method").is_none() {
                            if let Some(id) = value["id"].as_u64()
                                && let Some(reply) = reading
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .remove(&id)
                            {
                                let _ = reply.send(value);
                            }
                        } else {
                            event_sender.send(value).await?;
                        }
                    }
                    Ok::<(), anyhow::Error>(())
                };
                let writer = async move {
                    while let Some(frame) = outgoing.recv().await {
                        stdin.write_all(&frame.bytes).await?;
                        stdin.flush().await?;
                    }
                    Ok::<(), std::io::Error>(())
                };
                tokio::select! {
                    _ = shutdown.cancelled() => worker_lifecycle.record("process_stop", "parent_task", "cleanup_started"),
                    _ = reader => worker_lifecycle.record("process_stop", "native_input_closed", "cleanup_started"),
                    _ = writer => worker_lifecycle.record("process_stop", "native_output_closed", "cleanup_started"),
                    _ = observe_exit(&mut child) => worker_lifecycle.record("process_stop", "native_exit", "cleanup_started"),
                }
                shutdown.cancel();
                waiting.lock().unwrap_or_else(|p| p.into_inner()).clear();
                // Dropping both pumps closes stdin first, allowing native owner cleanup.
                #[cfg(target_os = "linux")]
                if let Some(owner) = &stdio_owner {
                    owner.request_stop();
                }
                let exited = matches!(
                    tokio::time::timeout(Duration::from_secs(5), observe_exit(&mut child)).await,
                    Ok(Ok(()))
                );
                #[cfg(target_os = "linux")]
                if stdio_owner.is_some() && !exited {
                    // The dedicated owner keeps retrying exact-child cleanup. Killing it here
                    // could strand escaped descendants. Keep the outcome explicitly unconfirmed.
                    tree.disarm();
                    worker_lifecycle.record(
                        "process_cleanup",
                        "owner",
                        "unconfirmed_owner_still_cleaning",
                    );
                    if native_receipt.is_some() {
                        // Retain the original owner/receipt and waiter after a
                        // bounded caller reports unknown. Never orphan it or
                        // manufacture a second cleanup request/identity.
                        if observe_exit(&mut child).await.is_err() {
                            return;
                        }
                    } else {
                        return;
                    }
                }
                #[cfg(not(target_os = "linux"))]
                let _ = exited;
                // On Unix observe_exit leaves the root unreaped, reserving its PID/PGID
                // until the owned group is stopped. Never kill a recycled group after wait().
                let terminated = tree.terminate().is_ok();
                let _ = child.start_kill();
                let reaped = matches!(
                    tokio::time::timeout(Duration::from_secs(4), child.wait()).await,
                    Ok(Ok(_))
                );
                if reaped {
                    worker_exit.store(true, Ordering::SeqCst);
                }
                #[cfg(target_os = "linux")]
                if stdio_owner.is_some() && reaped {
                    let confirmed = native_receipt
                        .as_ref()
                        .is_none_or(|receipt| receipt.confirmed().unwrap_or(false));
                    worker_cleanup_confirmed.store(confirmed, Ordering::SeqCst);
                }
                #[cfg(not(target_os = "linux"))]
                let _ = &worker_cleanup_confirmed;
                worker_lifecycle.record(
                    "process_cleanup",
                    "owner",
                    if reaped {
                        "root_reaped"
                    } else {
                        "root_exit_unconfirmed"
                    },
                );
                worker_lifecycle.record(
                    "tree_cleanup",
                    "owner",
                    if terminated {
                        "termination_requested_not_confirmed"
                    } else {
                        "termination_failed"
                    },
                );
                drop(tree);
            });
            Ok(Self {
                sender,
                pending,
                next_id: Arc::new(AtomicU64::new(1)),
                owned_pid,
                native_endpoint: None,
                cleanup_confirmed,
                owned_exit,
                #[cfg(target_os = "linux")]
                owner_control,
                closed,
                worker: Some(worker),
                lifecycle,
                events,
            })
        }
    }

    /// Move the bounded event receiver into a separately driven protocol adapter.
    pub(crate) fn take_events(&mut self) -> mpsc::Receiver<crate::queue::QueuedFrame> {
        std::mem::replace(&mut self.events, mpsc::channel(1).1)
    }

    pub(crate) fn shutdown_signal(&self) -> CancellationToken {
        self.closed.clone()
    }

    pub(crate) fn native_endpoint(&self) -> Option<&str> {
        self.native_endpoint.as_deref()
    }

    pub(crate) fn owned_pid(&self) -> u32 {
        self.owned_pid
    }

    pub(crate) async fn notify_owned_cancel(&self, session: &Value) -> Result<()> {
        self.sender
            .send(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}}))
            .await
    }

    pub(crate) async fn reply_result(&self, id: Value, result: Value) -> Result<()> {
        self.sender
            .send(json!({"jsonrpc":"2.0","id":id,"result":result}))
            .await
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.closed.is_cancelled()
    }

    pub(crate) fn begin_shutdown(&self) {
        self.closed.cancel();
        #[cfg(target_os = "linux")]
        if let Some(owner) = &self.owner_control {
            owner.request_stop();
        }
    }

    pub(crate) fn cleanup_confirmed(&self) -> bool {
        self.cleanup_confirmed.load(Ordering::SeqCst)
    }
    pub(crate) fn exit_observation(&self) -> OwnedExitObservation {
        OwnedExitObservation {
            exited: self.owned_exit.clone(),
            tree: self.cleanup_confirmed.clone(),
            native_wrapper: cfg!(all(target_os = "linux", not(test))),
        }
    }

    /// Cancellation cannot depend on the event consumer or a slow ACP writer.
    pub(crate) fn supervise_cancellation(
        &self,
        thread: &str,
        turn: &str,
        cancelled: CancellationToken,
        handoff: Option<crate::native_binding::NativeCloseHandoff>,
    ) -> CancellationGuard {
        let sender = self.sender.clone();
        let closed = self.closed.clone();
        let pending = self.pending.clone();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let params = json!({"threadId":thread,"turnId":turn});
        let lifecycle = self.lifecycle.native(thread, Some(turn));
        let worker = tokio::spawn(async move {
            cancelled.cancelled().await;
            let started = tokio::time::Instant::now();
            let request =
                json!({"jsonrpc":"2.0","id":id,"method":"turn/interrupt","params":params});
            // This receipt is diagnostic only; it never proves task termination.
            let (reply, receive) = oneshot::channel();
            pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(id, reply);
            let _registration = PendingCall { pending, id };
            let receipt = tokio::time::timeout(Duration::from_secs(2), async {
                sender.send(request).await?;
                Ok::<_, anyhow::Error>(receive.await?)
            })
            .await;
            let outcome = match receipt {
                Ok(Ok(value)) if value["result"]["interrupted"] == true => "accepted",
                Ok(Ok(value)) if value["result"]["interrupted"] == false => "not_running",
                Ok(Ok(_)) => "rejected",
                _ => "unknown",
            };
            lifecycle.record("cancel", "native_interrupt_receipt", outcome);
            tokio::time::sleep_until(started + Duration::from_secs(5)).await;
            if handoff.as_ref().is_some_and(|owner| owner.is_held()) {
                // Cleanup has transferred to the one matched original close.
                // No execution deadline or generic cancellation grace is renewed.
                lifecycle.record("cancel", "original_close", "retained_cleanup");
            } else {
                lifecycle.record("cancel", "runtime_deadline", "session_shutdown_requested");
                closed.cancel();
            }
        });
        CancellationGuard(worker)
    }

    pub(crate) async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_with_timeout(method, params, Duration::from_secs(30))
            .await
    }

    pub(crate) async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        ensure!(
            !self.is_closed(),
            "Owned app-server is closed; execution receipts may be unknown"
        );
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, sender);
        let _registration = PendingCall {
            pending: self.pending.clone(),
            id,
        };
        let wait = async {
            self.sender
                .send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
                .await?;
            let reply = receiver.await.map_err(|_| {
                anyhow::anyhow!("Owned app-server closed before its receipt; do not blindly replay")
            })?;
            if reply.get("error").is_some() {
                if let Ok(details) = serde_json::from_value::<kcoder_types::ProviderFailureDetails>(
                    reply["error"]["data"]["provider_failure"].clone(),
                ) {
                    // This is the closed native failure taxonomy, never the peer's raw message/body.
                    bail!(
                        "Owned peer rejected {method} (provider category {:?})",
                        details.category
                    );
                }
                if reply["error"]["code"].as_i64()
                    == Some(kcoder_app_protocol::PROVIDER_AUTHENTICATION_REQUIRED)
                {
                    return Err(crate::failures::missing_credentials());
                }
                if reply["error"]["code"].as_i64()
                    == Some(kcoder_app_protocol::THREAD_MCP_SETUP_FAILED)
                    && let Some(message) = reply["error"]["message"]
                        .as_str()
                        .filter(|message| message.len() <= 1024)
                {
                    bail!("{message}");
                }
                if method == kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD
                    && let Some(message) = reply["error"]["message"].as_str()
                {
                    let code = crate::native_receiver_bind_diagnostic(&anyhow::anyhow!(
                        message.to_owned()
                    ));
                    if code == message {
                        bail!("{code}");
                    }
                }
                if let Some(message) = reply["error"]["message"].as_str().filter(|message| {
                    [
                        "REMOTE_OFFICE_PROFILE_REQUIRED",
                        "REMOTE_OFFICE_OWN_MODEL_REQUIRED",
                        "REMOTE_OFFICE_NATIVE_STARTUP_UNAVAILABLE",
                        "REMOTE_OFFICE_NATIVE_INSTALLATION_REQUIRED",
                        "REMOTE_OFFICE_PARENT_REQUIRED",
                        "REMOTE_OFFICE_PARENT_HANDLE_REQUIRED",
                        "REMOTE_OFFICE_PARENT_NATIVE_INSTALLATION_MISMATCH",
                        "REMOTE_OFFICE_PARENT_EXITED",
                        "REMOTE_OFFICE_PARENT_CHANGED",
                        "REMOTE_OFFICE_PARENT_PRINCIPAL_REQUIRED",
                        "REMOTE_OFFICE_PARENT_PRINCIPAL_CHANGED",
                        "REMOTE_OFFICE_COMPONENT_ROOT_CHANGED",
                        "REMOTE_OFFICE_RECEIVER_POLICY_CHANGED",
                        "REMOTE_RECEIVER_PROFILE_RESTRICTIONS_REQUIRED",
                        "REMOTE_OFFICE_FORMAT_INTERSECTION_REQUIRED",
                        "REMOTE_OFFICE_NORMAL_PERMISSIONS_REQUIRED",
                        "REMOTE_ORIGINAL_PROMPT_DISPATCH_REQUIRED",
                        "REMOTE_ORIGINAL_SESSION_DISPATCH_REQUIRED",
                        "REMOTE_RECEIVER_PRIVATE_BINDING_UNAVAILABLE",
                        "REMOTE_RECEIVER_EXECUTION_UNAVAILABLE",
                    ]
                    .contains(message)
                }) {
                    // An owned ACP adapter may itself own a Native app-server.
                    // Keep the closed code intact across both private hops.
                    bail!("{message}");
                }
                // Native errors may contain project data or launch credentials.
                bail!(
                    "Owned app-server rejected {method} (code {}); inspect native diagnostics",
                    reply["error"]["code"]
                );
            }
            reply
                .get("result")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Native result is missing"))
        };
        tokio::select! {
            biased;
            result = tokio::time::timeout(timeout, wait) => result.map_err(|_| {
                self.lifecycle.record("native_request", "runtime_deadline", "receipt_unknown");
                anyhow::anyhow!("Native request timed out; receipt is unknown; do not blindly replay")
            })?,
            _ = self.closed.cancelled() => bail!("Owned app-server closed before its receipt; do not blindly replay"),
        }
    }

    pub(crate) async fn reject_request(&self, frame: &Value) -> Result<()> {
        self.sender.send(json!({"jsonrpc":"2.0", "id":frame["id"],
            "error":{"code":-32601,"message":"This ACP development adapter does not support this client interaction yet"}})).await
    }

    pub(crate) fn native_bridge_parts(
        &mut self,
    ) -> (
        mpsc::Receiver<crate::queue::QueuedFrame>,
        WireSender,
        CancellationToken,
    ) {
        (self.take_events(), self.sender.clone(), self.closed.clone())
    }

    pub(crate) fn native_control_link(&self) -> NativeUpstreamControl {
        NativeUpstreamControl {
            sender: self.sender.clone(),
            pending: self.pending.clone(),
            next_id: self.next_id.clone(),
            closed: self.closed.clone(),
        }
    }

    pub(crate) async fn reply_approval(
        &self,
        id: Value,
        response: kcoder_app_protocol::ApprovalResponse,
    ) -> Result<()> {
        self.sender
            .send(json!({"jsonrpc":"2.0","id":id,"result":response}))
            .await
    }

    pub(crate) async fn shutdown(&mut self) {
        self.closed.cancel();
        if let Some(worker) = self.worker.take()
            && worker.await.is_err()
        {
            self.lifecycle
                .record("process_cleanup", "owner_task_failure", "unconfirmed");
        }
    }
}

pub(crate) struct CancellationGuard(JoinHandle<()>);
impl Drop for CancellationGuard {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Drop for Upstream {
    fn drop(&mut self) {
        self.begin_shutdown();
    }
}

struct PendingCall {
    pending: Pending,
    id: u64,
}
impl Drop for PendingCall {
    fn drop(&mut self) {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.id);
    }
}

#[cfg(unix)]
struct ProcessTree(Option<u32>);
#[cfg(unix)]
impl ProcessTree {
    #[cfg(target_os = "linux")]
    fn disarm(&mut self) {
        self.0.take();
    }
    fn terminate(&mut self) -> Result<()> {
        // Only this freshly created process group is owned by this session.
        if let Some(pid) = self.0.take() {
            unsafe {
                libc::killpg(pid as i32, libc::SIGKILL);
            }
        }
        Ok(())
    }
}

#[cfg(unix)]
async fn observe_exit(child: &mut tokio::process::Child) -> Result<()> {
    let pid = child
        .id()
        .ok_or_else(|| anyhow::anyhow!("Owned child was already reaped"))?;
    loop {
        let exited = {
            // Keep macOS siginfo_t's non-Send pointers out of the async suspension.
            // SAFETY: waitid writes siginfo_t; WNOWAIT reserves the owned root identity.
            let mut information = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut information,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == -1 {
                return Err(std::io::Error::last_os_error().into());
            }
            unsafe { information.si_pid() == pid as i32 }
        };
        if exited {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(windows)]
async fn observe_exit(child: &mut tokio::process::Child) -> Result<()> {
    child.wait().await?;
    Ok(())
}
#[cfg(unix)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn owned_native_startup_diagnostic_preserves_only_closed_codes_across_hops() {
        for (message, exposed) in [
            ("REMOTE_ORIGINAL_PROMPT_DISPATCH_REQUIRED", true),
            ("REMOTE_OFFICE_PROFILE_REQUIRED", true),
            ("REMOTE_OFFICE_PROFILE_REQUIRED private-launch-data", false),
            ("REMOTE_CALLER_PROVIDED_SECRET", false),
        ] {
            let config = AppServerConfig {
                executable: "/usr/bin/python3".into(),
                args: vec![
                    "-c".into(),
                    "import json,sys\nr=json.loads(sys.stdin.readline())\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32602,'message':sys.argv[1]}}),flush=True)\nsys.stdin.read()".into(),
                    message.into(),
                ],
                environment: Some(BTreeMap::new()),
            };
            let mut upstream = Upstream::spawn(&config, Path::new("/tmp")).unwrap();
            let error = upstream.call("thread/start", json!({})).await.unwrap_err();
            if exposed {
                assert_eq!(error.to_string(), message);
            } else {
                assert!(!error.to_string().contains(message));
            }
            upstream.shutdown().await;
        }
    }

    #[tokio::test]
    async fn private_native_binding_preserves_only_exact_closed_stage_codes() {
        for (message, exposed) in [
            ("REMOTE_RECEIVER_BIND_SCOPE", true),
            ("REMOTE_RECEIVER_BIND_SCOPE private-launch-data", false),
            ("REMOTE_CALLER_PROVIDED_SECRET", false),
        ] {
            let config = AppServerConfig {
                executable: "/usr/bin/python3".into(),
                args: vec!["-c".into(), "import json,sys\nr=json.loads(sys.stdin.readline())\nprint(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32086,'message':sys.argv[1]}}),flush=True)\nsys.stdin.read()".into(), message.into()],
                environment: Some(BTreeMap::new()),
            };
            let mut upstream = Upstream::spawn(&config, Path::new("/tmp")).unwrap();
            let error = upstream
                .call(
                    kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD,
                    json!({}),
                )
                .await
                .unwrap_err();
            if exposed {
                assert_eq!(error.to_string(), message);
            } else {
                assert!(!error.to_string().contains(message));
            }
            upstream.shutdown().await;
        }
    }

    #[tokio::test]
    async fn exit_observation_reserves_the_root_until_owned_group_cleanup() {
        fn require_send<T: Send>(future: T) -> T {
            future
        }
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id().unwrap();
        let mut tree = ProcessTree(Some(pid));
        for _ in 0..2 {
            tokio::time::timeout(
                Duration::from_secs(2),
                require_send(observe_exit(&mut child)),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(child.id(), Some(pid), "observation must not reap the root");
        }
        tree.terminate().unwrap();
        assert!(
            tree.0.is_none(),
            "termination must disarm later Drop cleanup"
        );
        assert!(child.wait().await.unwrap().success());
    }

    #[tokio::test]
    async fn shutdown_closes_owned_stdin_before_waiting_for_a_graceful_exit() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("owned-eof");
        let config = AppServerConfig {
            executable: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "printf ready > \"$1\"; while IFS= read -r line; do :; done; printf eof > \"$1\""
                    .into(),
                "acp-eof-probe".into(),
                marker.as_os_str().to_owned(),
            ],
            environment: Some(BTreeMap::new()),
        };
        let mut upstream = Upstream::spawn(&config, directory.path()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while tokio::fs::read(&marker).await.ok().as_deref() != Some(b"ready") {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), upstream.shutdown())
            .await
            .unwrap();
        assert_eq!(tokio::fs::read(marker).await.unwrap(), b"eof");
    }
}
