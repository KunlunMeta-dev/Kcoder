//! Owned outbound ACP v1 transport. Native host policy and durable operation receipts remain mandatory.
//!
//! This module never auto-approves external permissions, installs a runner, or interprets
//! an external stop reason as an authoritative KCoder business/task terminal state.

use crate::diagnostics::Lifecycle;
use crate::framing::MAX_FRAME_BYTES;
use crate::queue::QueuedFrame;
use crate::upstream::{AppServerConfig, Upstream};
use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, PromptRequest,
    PromptResponse, RequestPermissionOutcome, RequestPermissionResponse, SessionNotification,
};
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

mod native_binding;
mod native_material;
mod native_transport;
pub use native_transport::{NativeFrameFuture, OwnedNativeFrameTransport};

/// Pinned ACP wire content for native adapters; this is not a KCoder authorization DTO.
pub use agent_client_protocol::schema::v1::ContentBlock as OutboundContentBlock;
/// Pinned ACP text content constructor for a native frozen prompt.
pub use agent_client_protocol::schema::v1::TextContent as OutboundTextContent;

/// Effects must be recorded against the original native operation before dispatch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutboundEffect {
    /// A fixed, installed runner is about to be launched.
    Spawn,
    /// The fixed process is about to receive its protocol initialization.
    Initialize,
    /// A new external ACP session is about to be created.
    Session,
    /// The frozen prompt is about to be delivered once.
    Prompt,
}

/// Only an already captured Native endpoint owner may supply a handler.
/// Returning a JSON value cannot install this handler or confer budget authority.
pub type OwnedNativeControlFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<Value>>> + Send + 'a>>;

/// Required native-only authority/journal. Implementations must validate the actual owner,
/// fixed operation/intent, current narrow policy and target fence. JSON is not authority.
pub trait OutboundHost: Send + Sync {
    fn before_owned_native_material(&self, _request: &Value) -> Result<()> {
        bail!("Owned Native material transfer is unavailable")
    }
    fn unknown_owned_native_material(&self) -> Result<()> {
        bail!("Owned Native material transfer is unavailable")
    }
    fn check_owned_native_observation(&self) -> Result<()> {
        bail!("Owned Native observation is unavailable")
    }
    fn verify_owned_native_read(&self, _request: &Value) -> Result<()> {
        bail!("Owned Native observation is unavailable")
    }
    /// Retained authority may close only its fixed original Native owner.
    /// This is an effect and never uses read-only observation admission.
    fn check_owned_native_close(&self) -> Result<()> {
        bail!("Owned Native close is unavailable")
    }
    fn before_owned_native_close(&self, _intent: &Value) -> Result<()> {
        bail!("Owned Native close is unavailable")
    }
    fn record_owned_native_close(&self, _receipt: &Value) -> Result<()> {
        bail!("Owned Native close is unavailable")
    }
    fn unknown_owned_native_close(&self) -> Result<()> {
        bail!("Owned Native close is unavailable")
    }
    fn before_owned_native_bind(&self, _intent: &Value) -> Result<()> {
        bail!("Owned Native binding is unavailable")
    }
    fn record_owned_native_bind(&self, _receipt: &Value) -> Result<()> {
        bail!("Owned Native binding is unavailable")
    }
    fn unknown_owned_native_bind(&self) -> Result<()> {
        bail!("Owned Native binding is unavailable")
    }
    /// Only a concrete retained Native owner may settle an already dispatched
    /// original model call after execution admission ends. Default denies it.
    fn handle_owned_native_settlement<'a>(
        &'a self,
        _frame: &'a Value,
    ) -> OwnedNativeControlFuture<'a> {
        Box::pin(async { bail!("Owned Native accounting settlement is unavailable") })
    }
    /// Validate the actual installed command/config pin and original native launch grant.
    /// Shape validation or a JSON marker is insufficient.
    fn verify_runner(&self, runner: &InstalledOutboundRunner) -> Result<()>;
    /// Default deny: only the original Native owner may admit an authenticated
    /// frame lane. An ACP peer declaration or JSON marker never opts in.
    fn verify_owned_frame_transport(
        &self,
        _transport: &dyn OwnedNativeFrameTransport,
    ) -> Result<()> {
        bail!("Owned Native ACP frame transport is unavailable")
    }
    /// Recheck current identity, configuration, deadline and operation ownership.
    fn check_current(&self) -> Result<()>;
    /// The original native run's hard deadline; RPC observation timeouts cannot extend it.
    fn deadline(&self) -> tokio::time::Instant;
    /// Persist a unique original-operation dispatch fact before an effect. Repeats must reject.
    fn before_effect(&self, effect: OutboundEffect, intent: &Value) -> Result<()>;
    /// Persist a known protocol receipt, without promoting it to business completion.
    fn record_receipt(&self, effect: OutboundEffect, receipt: &Value) -> Result<()>;
    /// Preserve an unknown outcome after dispatch; no automatic respawn/replay is permitted.
    fn record_unknown(&self, effect: OutboundEffect) -> Result<()>;
    /// Retained ownership may cancel only this original actual session after
    /// ordinary execution authority expires. Default denies this extra path.
    fn begin_owned_cancel(&self, _session: &Value) -> Result<()> {
        bail!("Original owned cancellation is unavailable")
    }
    fn finish_owned_cancel(&self, _native_terminal_observed: bool) -> Result<()> {
        Ok(())
    }
    /// Actual Native task observation only. Protocol text/markers are insufficient.
    fn owned_cancel_complete(&self) -> Result<bool> {
        Ok(false)
    }
    /// Default deny for every ordinary/generic ACP peer. A concrete Native
    /// transport implementation must check its held endpoint/account/image,
    /// original Source Accepted/operation/slot and current policy before decode
    /// or mutation. It must retain original receipts if this future is dropped.
    fn handle_owned_native_control<'a>(
        &'a self,
        _frame: &'a Value,
    ) -> OwnedNativeControlFuture<'a> {
        Box::pin(async { Ok(None) })
    }
}

/// Exact native launch facts. This private host structure has no serde or Debug surface.
/// Constructing it validates shape only; `OutboundHost` still supplies authority before spawn.
pub struct InstalledOutboundRunner {
    executable: PathBuf,
    arguments: Vec<OsString>,
    environment: BTreeMap<OsString, OsString>,
    workspace: PathBuf,
    owner_executable: PathBuf,
    expected_name: String,
    expected_version: String,
    #[cfg(target_os = "linux")]
    executable_anchor: Option<Arc<std::fs::File>>,
}
impl InstalledOutboundRunner {
    /// Accept only native-installed absolute paths, a private exact environment and exact
    /// implementation identity. The native host must hold/revalidate its executable/config pin.
    pub fn from_native_installation(
        executable: PathBuf,
        arguments: Vec<OsString>,
        environment: BTreeMap<OsString, OsString>,
        workspace: PathBuf,
        owner_executable: PathBuf,
        expected_name: String,
        expected_version: String,
    ) -> Result<Self> {
        ensure!(
            executable.is_absolute() && workspace.is_absolute() && owner_executable.is_absolute(),
            "Outbound ACP installation is unavailable"
        );
        ensure!(
            arguments.len() <= 64 && environment.len() <= 64,
            "Outbound ACP launch limits exceeded"
        );
        ensure!(
            !expected_name.is_empty()
                && expected_name.len() <= 128
                && !expected_version.is_empty()
                && expected_version.len() <= 128,
            "Outbound ACP identity is unavailable"
        );
        Ok(Self {
            executable,
            arguments,
            environment,
            workspace,
            owner_executable,
            expected_name,
            expected_version,
            #[cfg(target_os = "linux")]
            executable_anchor: None,
        })
    }
    /// Native host supplies the already verified executing image. The actual
    /// FD, held through child creation, prevents an installed-path replacement
    /// between verification and exec from selecting a different binary.
    #[cfg(target_os = "linux")]
    pub fn with_native_executable_anchor(mut self, file: std::fs::File) -> Result<Self> {
        ensure!(
            self.owner_executable == self.executable && file.metadata()?.is_file(),
            "Outbound ACP native executable anchor is unavailable"
        );
        self.executable_anchor = Some(Arc::new(file));
        Ok(self)
    }
    #[cfg(target_os = "linux")]
    pub fn executable_anchor(&self) -> Option<&std::fs::File> {
        self.executable_anchor.as_deref()
    }
    /// Native host executable path; never project it into model/public diagnostics.
    pub fn executable(&self) -> &std::path::Path {
        &self.executable
    }
    /// Exact native arguments, not public tool arguments.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
    /// Private exact environment; never include it in an operation report.
    pub fn environment(&self) -> &BTreeMap<OsString, OsString> {
        &self.environment
    }
    /// Actual native working directory for this fixed runner.
    pub fn workspace(&self) -> &std::path::Path {
        &self.workspace
    }
    /// Native installed owner executable; the host must verify its actual helper pin too.
    pub fn owner_executable(&self) -> &std::path::Path {
        &self.owner_executable
    }
    /// Expected ACP implementation identity from the native installed pin.
    pub fn implementation(&self) -> (&str, &str) {
        (&self.expected_name, &self.expected_version)
    }
    fn launch(&self) -> Result<AppServerConfig> {
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let anchored = self.executable_anchor.as_ref().map(|file| {
                PathBuf::from(format!(
                    "/proc/{}/fd/{}",
                    std::process::id(),
                    file.as_raw_fd()
                ))
            });
            let executable = anchored.as_ref().unwrap_or(&self.executable);
            let mut args = vec![
                OsString::from(kcoder_process_supervisor::linux_stdio::INTERNAL_STDIO_OWNER_V1),
                OsString::from(std::process::id().to_string()),
                executable.as_os_str().to_owned(),
            ];
            args.extend(self.arguments.iter().cloned());
            Ok(AppServerConfig {
                executable: anchored.unwrap_or_else(|| self.owner_executable.clone()),
                args,
                environment: Some(self.environment.clone()),
            })
        }
        #[cfg(windows)]
        {
            Ok(AppServerConfig {
                executable: self.executable.clone(),
                args: self.arguments.clone(),
                environment: Some(self.environment.clone()),
            })
        }
        #[cfg(not(any(target_os = "linux", windows)))]
        bail!("Owned outbound ACP process support is unavailable on this platform");
    }
}

/// Protocol facts observed from the exact owned process, not business readiness.
#[derive(Clone, Debug)]
pub struct OutboundHandshake {
    /// ACP implementation identity as observed and compared with the installed pin.
    pub response: InitializeResponse,
}
/// Received protocol output; the native host still validates required artifacts/results.
#[derive(Clone, Debug)]
pub struct OutboundPromptReceipt {
    /// The exact session response identity.
    pub session: NewSessionResponse,
    /// The external stop reason is a protocol observation only.
    pub response: PromptResponse,
    /// Bounded updates from this exact external session.
    pub updates: Vec<SessionNotification>,
}

struct DispatchGuard {
    host: Arc<dyn OutboundHost>,
    effect: OutboundEffect,
    close: CancellationToken,
    finished: bool,
}
impl Drop for DispatchGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.close.cancel();
            let _ = self.host.record_unknown(self.effect);
        }
    }
}

/// Actual owner cleanup observation, independently from protocol/business completion.
///
/// A caller cannot promote an actual unconfirmed observation:
/// ```compile_fail
/// fn promote(receipt: &mut kcoder_acp::outbound::OutboundCleanup) {
///     receipt.confirmed = true;
/// }
/// ```
#[derive(Clone)]
pub struct OutboundCleanup {
    /// True only when the dedicated Linux owner exited after owned-tree cleanup.
    /// Unsupported/native-unverified cleanup remains false instead of claiming success.
    confirmed: bool,
    owned_pid: u32,
    owned_endpoint_instance: Option<String>,
    host: Weak<dyn OutboundHost>,
}
impl OutboundCleanup {
    /// Immutable actual owner observation. Callers cannot promote an
    /// unconfirmed cleanup receipt to a confirmed one.
    pub fn confirmed(&self) -> bool {
        self.confirmed
    }
    pub fn owned_pid(&self) -> u32 {
        self.owned_pid
    }
    /// Native endpoint lifetime metadata. It grants no authority and is absent
    /// for the existing local process-backed transport.
    pub fn owned_endpoint_instance(&self) -> Option<&str> {
        self.owned_endpoint_instance.as_deref()
    }
    /// Opaque actual connection ownership, never a PID/JSON equality grant.
    pub fn belongs_to<T: OutboundHost + 'static>(&self, host: &Arc<T>) -> bool {
        let expected: Arc<dyn OutboundHost> = host.clone();
        self.host.ptr_eq(&Arc::downgrade(&expected))
    }
}

/// One owned runner with no implicit reconnect, session recreation or prompt replay.
pub struct OutboundAcp {
    peer: Upstream,
    events: mpsc::Receiver<QueuedFrame>,
    expected_name: String,
    expected_version: String,
    poisoned: bool,
    initialized: bool,
    workspace: PathBuf,
    host: Arc<dyn OutboundHost>,
}
#[derive(Clone, Copy)]
enum CallAuthority {
    Execution,
    Observation,
    OwnerClose,
}
impl OutboundAcp {
    /// Recheck and durably record before launching the exact native-installed runner.
    /// Metadata reads must never invoke this constructor.
    pub fn spawn(config: &InstalledOutboundRunner, host: Arc<dyn OutboundHost>) -> Result<Self> {
        host.check_current()?;
        host.verify_runner(config)?;
        let launch = config.launch()?;
        host.before_effect(
            OutboundEffect::Spawn,
            &json!({"expectedName":config.expected_name,"expectedVersion":config.expected_version}),
        )?;
        let mut peer = match Upstream::spawn_traced_stdio_owner(
            &launch,
            &config.workspace,
            Lifecycle::default(),
        ) {
            Ok(peer) => peer,
            Err(_) => {
                host.record_unknown(OutboundEffect::Spawn)?;
                bail!("Outbound ACP launch outcome is unavailable");
            }
        };
        host.record_receipt(OutboundEffect::Spawn, &json!({"ownedPid":peer.owned_pid()}))?;
        let events = peer.take_events();
        Ok(Self {
            peer,
            events,
            expected_name: config.expected_name.clone(),
            expected_version: config.expected_version.clone(),
            poisoned: false,
            initialized: false,
            workspace: config.workspace.clone(),
            host,
        })
    }
    fn may_retain_original_close(&self) -> bool {
        self.peer.native_endpoint().is_some() && self.host.check_owned_native_close().is_ok()
    }
    async fn call(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&Value>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(Value, Vec<SessionNotification>)> {
        let result = self
            .call_inner(
                method,
                params,
                session,
                cancel,
                timeout,
                CallAuthority::Execution,
            )
            .await;
        if result.is_err() {
            self.poisoned = true;
            if !self.may_retain_original_close() {
                self.peer.begin_shutdown();
            }
        }
        result
    }
    async fn observe_call(
        &mut self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<(Value, Vec<SessionNotification>)> {
        let result = self
            .call_inner(
                method,
                params,
                None,
                cancel,
                timeout,
                CallAuthority::Observation,
            )
            .await;
        if result.is_err() {
            self.poisoned = true;
            if !self.may_retain_original_close() {
                self.peer.begin_shutdown();
            }
        }
        result
    }
    async fn call_inner(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&Value>,
        cancel: &CancellationToken,
        timeout: Duration,
        authority: CallAuthority,
    ) -> Result<(Value, Vec<SessionNotification>)> {
        ensure!(
            !self.poisoned || matches!(authority, CallAuthority::OwnerClose),
            "Outbound ACP outcome is unknown; do not replay"
        );
        let host = self.host.clone();
        let check_current = || match authority {
            CallAuthority::Execution => host.check_current(),
            CallAuthority::Observation => host.check_owned_native_observation(),
            CallAuthority::OwnerClose => host.check_owned_native_close(),
        };
        check_current()?;
        let mut request = Box::pin(self.peer.call_with_timeout(method, params, timeout));
        let deadline = if !matches!(authority, CallAuthority::Execution) {
            tokio::time::Instant::now() + timeout
        } else {
            std::cmp::min(tokio::time::Instant::now() + timeout, host.deadline())
        };
        let mut heartbeat = tokio::time::interval(Duration::from_millis(250));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut updates = Vec::new();
        let mut total_bytes = 0usize;
        loop {
            tokio::select! {
                biased;
                _ = tokio::time::sleep_until(deadline) => {
                    drop(request);
                    self.cancel_original_prompt(method, session).await;
                    bail!("Outbound ACP native deadline expired; outcome may be unknown");
                },
                _ = heartbeat.tick() => if let Err(error) = check_current() {
                    drop(request);
                    self.cancel_original_prompt(method, session).await;
                    return Err(error);
                },
                _ = cancel.cancelled() => {
                    // Dropping the owned send future first prevents a blocked or
                    // unpolled prompt from being submitted after cancellation.
                    drop(request);
                    self.cancel_original_prompt(method, session).await;
                    bail!("Outbound ACP cancelled; dispatched outcome may be unknown");
                }
                event = self.events.recv(), if !self.events.is_closed() || !self.events.is_empty() => {
                    let event = event.ok_or_else(|| anyhow::anyhow!("Outbound ACP stream ended; do not replay"))?;
                    total_bytes = total_bytes.saturating_add(event.bytes.len());
                    ensure!(total_bytes <= 2 * MAX_FRAME_BYTES && updates.len() < 4096, "Outbound ACP update limit exceeded");
                    let frame: Value = serde_json::from_slice(&event.bytes).map_err(|_| anyhow::anyhow!("Invalid outbound ACP frame"))?;
                    let admission = check_current();
                    if (admission.is_err() || !matches!(authority, CallAuthority::Execution))
                        && self.settle_original_native_accounting(&frame).await { continue; }
                    if let Err(error) = admission {
                        drop(request);
                        if frame.get("id").is_some() && frame["method"] == kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD {
                            let _ = tokio::time::timeout(Duration::from_secs(1), self.peer.reject_request(&frame)).await;
                        }
                        self.cancel_original_prompt(method, session).await;
                        return Err(error);
                    }
                    if frame.get("id").is_some() {
                        if frame["method"] == "session/request_permission" {
                            let denied = serde_json::to_value(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled))?;
                            tokio::select! {
                                _ = cancel.cancelled() => bail!("Outbound ACP cancelled"),
                                _ = tokio::time::sleep_until(deadline) => bail!("Outbound ACP native deadline expired"),
                                result = self.peer.reply_result(frame["id"].clone(), denied) => result?,
                            }
                        } else if frame["method"] == kcoder_types::integrations::core::NATIVE_REMOTE_CONTROL_METHOD {
                            let response = tokio::select! {
                                _ = cancel.cancelled() => Err(anyhow::anyhow!("Owned Native control cancelled; reconcile the original request")),
                                _ = tokio::time::sleep_until(deadline) => Err(anyhow::anyhow!("Owned Native control deadline expired; reconcile the original request")),
                                result = host.handle_owned_native_control(&frame) => result,
                            };
                            let response = match response {
                                Ok(response) => response,
                                Err(error) => {
                                    drop(request);
                                    self.cancel_original_prompt(method, session).await;
                                    return Err(error);
                                }
                            };
                            if let Err(error) = check_current() {
                                drop(request);
                                self.cancel_original_prompt(method, session).await;
                                return Err(error);
                            }
                            let delivery = async {
                                match response {
                                    Some(response) => self.peer.reply_result(frame["id"].clone(), response).await,
                                    None => self.peer.reject_request(&frame).await,
                                }
                            };
                            let delivered = tokio::select! {
                                _ = cancel.cancelled() => Err(anyhow::anyhow!("Owned Native control receipt cancelled; reconcile the original request")),
                                _ = tokio::time::sleep_until(deadline) => Err(anyhow::anyhow!("Owned Native control receipt deadline expired; reconcile the original request")),
                                result = delivery => result,
                            };
                            if let Err(error) = delivered {
                                drop(request);
                                self.cancel_original_prompt(method, session).await;
                                return Err(error);
                            }
                        } else {
                            tokio::select! {
                                _ = cancel.cancelled() => bail!("Outbound ACP cancelled"),
                                _ = tokio::time::sleep_until(deadline) => bail!("Outbound ACP native deadline expired"),
                                result = self.peer.reject_request(&frame) => result?,
                            }
                        }
                    } else if frame["method"] == "session/update" {
                        ensure!(session.is_some_and(|expected| frame["params"]["sessionId"] == *expected) || (method == "session/new" && session.is_none()), "Outbound ACP session update identity mismatch");
                        updates.push(serde_json::from_value(frame["params"].clone()).map_err(|_| anyhow::anyhow!("Invalid outbound ACP update"))?);
                    } else { bail!("Unsupported outbound ACP notification"); }
                }
                result = &mut request => {
                    let result = match result {
                        Ok(result) => result,
                        Err(error) => {
                            drop(request);
                            self.cancel_original_prompt(method, session).await;
                            return Err(error);
                        }
                    };
                    if let Err(error) = check_current() {
                        drop(request);
                        self.cancel_original_prompt(method, session).await;
                        return Err(error);
                    }
                    return Ok((result, updates));
                },
            }
        }
    }
    async fn cancel_original_prompt(&mut self, method: &str, session: Option<&Value>) {
        let Some(session) = session.filter(|_| method == "session/prompt") else {
            return;
        };
        if self.host.owned_cancel_complete().unwrap_or(false) {
            return;
        }
        if self.host.begin_owned_cancel(session).is_err() {
            return;
        }
        let queued = matches!(
            tokio::time::timeout(
                Duration::from_secs(1),
                self.peer.notify_owned_cancel(session)
            )
            .await,
            Ok(Ok(()))
        );
        if !queued {
            let _ = self.host.finish_owned_cancel(false);
            return;
        }
        if self.may_retain_original_close() {
            // The actual original Native owner can now transfer directly to its
            // journaled close. Task status remains unknown until native readback.
            let _ = self.host.finish_owned_cancel(false);
            return;
        }
        // Only deny client requests and observe the original Native terminal.
        // This grace never admits another prompt/model or renews its deadline.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut heartbeat = tokio::time::interval(Duration::from_millis(100));
        let mut bytes = 0usize;
        let mut count = 0usize;
        let complete = loop {
            if self.host.owned_cancel_complete().unwrap_or(false) {
                break true;
            }
            tokio::select! {
                _ = tokio::time::sleep_until(deadline) => break false,
                _ = heartbeat.tick() => {},
                event = self.events.recv(), if !self.events.is_closed() || !self.events.is_empty() => {
                    let Some(event) = event else { break false; };
                    bytes = bytes.saturating_add(event.bytes.len());count += 1;
                    if bytes > 2 * MAX_FRAME_BYTES || count > 4096 { break false; }
                    let Ok(frame) = serde_json::from_slice::<Value>(&event.bytes) else { break false; };
                    if self.settle_original_native_accounting(&frame).await { continue; }
                    if frame.get("id").is_some() {
                        let result = if frame["method"] == "session/request_permission" {
                            match serde_json::to_value(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)) {
                                Ok(denied) => tokio::time::timeout(Duration::from_millis(100), self.peer.reply_result(frame["id"].clone(), denied)).await,
                                Err(_) => break false,
                            }
                        } else {
                            tokio::time::timeout(Duration::from_millis(100), self.peer.reject_request(&frame)).await
                        };
                        if !matches!(result, Ok(Ok(()))) { break false; }
                    } else if frame["method"] != "session/update" || frame["params"]["sessionId"] != *session {
                        break false;
                    }
                }
            }
        };
        let _ = self.host.finish_owned_cancel(complete);
    }
    /// Observe protocol v1 and exact installed implementation identity, without creating a session.
    pub async fn initialize(&mut self, cancel: &CancellationToken) -> Result<OutboundHandshake> {
        let result = self.initialize_inner(cancel).await;
        if result.is_err() {
            self.poisoned = true;
            self.peer.begin_shutdown();
        }
        result
    }
    async fn initialize_inner(&mut self, cancel: &CancellationToken) -> Result<OutboundHandshake> {
        let host = self.host.clone();
        ensure!(!self.initialized, "Outbound ACP was already initialized");
        let request = serde_json::to_value(InitializeRequest::new(ProtocolVersion::V1))?;
        host.before_effect(OutboundEffect::Initialize, &request)?;
        let mut dispatch = DispatchGuard {
            host: host.clone(),
            effect: OutboundEffect::Initialize,
            close: self.peer.shutdown_signal(),
            finished: false,
        };
        let (value, _) = self
            .call("initialize", request, None, cancel, Duration::from_secs(10))
            .await?;
        let auth_methods = match value.get("authMethods") {
            None => Vec::new(),
            Some(value) => serde_json::from_value::<
                Vec<agent_client_protocol::schema::v1::AuthMethod>,
            >(value.clone())
            .map_err(|_| anyhow::anyhow!("Outbound ACP authentication declaration is invalid"))?,
        };
        let response: InitializeResponse = serde_json::from_value(value)
            .map_err(|_| anyhow::anyhow!("Invalid outbound ACP initialize result"))?;
        ensure!(
            response.protocol_version == ProtocolVersion::V1,
            "Outbound ACP protocol version mismatch"
        );
        let info = response
            .agent_info
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Outbound ACP implementation identity missing"))?;
        ensure!(
            info.name == self.expected_name && info.version == self.expected_version,
            "Outbound ACP installed version mismatch"
        );
        host.record_receipt(OutboundEffect::Initialize, &json!({"protocolVersion":response.protocol_version,
            "agentName":info.name,"agentVersion":info.version,"authenticationRequired":!auth_methods.is_empty()}))?;
        dispatch.finished = true;
        ensure!(
            auth_methods.is_empty(),
            "Outbound ACP authentication is required; configure the runner independently"
        );
        self.initialized = true;
        Ok(OutboundHandshake { response })
    }
    /// Deliver one frozen prompt after mandatory native dispatch journaling.
    pub async fn prompt_once(
        &mut self,
        input: Vec<agent_client_protocol::schema::v1::ContentBlock>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<OutboundPromptReceipt> {
        let result = self.prompt_inner(input, cancel, timeout).await;
        if result.is_err() {
            self.poisoned = true;
            if !self.may_retain_original_close() {
                self.peer.begin_shutdown();
            }
        }
        result
    }
    async fn prompt_inner(
        &mut self,
        input: Vec<agent_client_protocol::schema::v1::ContentBlock>,
        cancel: &CancellationToken,
        timeout: Duration,
    ) -> Result<OutboundPromptReceipt> {
        let host = self.host.clone();
        ensure!(
            !input.is_empty() && serde_json::to_vec(&input)?.len() <= 1024 * 1024,
            "Outbound ACP prompt limits exceeded"
        );
        ensure!(
            !timeout.is_zero() && timeout <= Duration::from_secs(1800),
            "Outbound ACP deadline is invalid"
        );
        ensure!(
            self.initialized,
            "Outbound ACP must be initialized before creating a session"
        );
        let new_session = serde_json::to_value(NewSessionRequest::new(self.workspace.clone()))?;
        host.check_current()?;
        host.before_effect(OutboundEffect::Session, &new_session)?;
        let mut session_dispatch = DispatchGuard {
            host: host.clone(),
            effect: OutboundEffect::Session,
            close: self.peer.shutdown_signal(),
            finished: false,
        };
        let created = self
            .call(
                "session/new",
                new_session,
                None,
                cancel,
                Duration::from_secs(10),
            )
            .await;
        let (session, mut initial_updates) = match created {
            Ok((value, updates)) => {
                let session = serde_json::from_value::<NewSessionResponse>(value)
                    .map_err(|_| anyhow::anyhow!("Invalid outbound ACP session receipt"))?;
                ensure!(
                    updates
                        .iter()
                        .all(|update| update.session_id == session.session_id),
                    "Outbound ACP initial session update identity mismatch"
                );
                host.record_receipt(
                    OutboundEffect::Session,
                    &json!({"sessionId":session.session_id}),
                )?;
                (session, updates)
            }
            Err(error) => {
                self.poisoned = true;
                return Err(error);
            }
        };
        ensure!(
            !session.session_id.to_string().is_empty()
                && session.session_id.to_string().len() <= 1024,
            "Outbound ACP session identity is invalid"
        );
        session_dispatch.finished = true;
        let session_id = serde_json::to_value(&session.session_id)?;
        let prompt = serde_json::to_value(PromptRequest::new(session.session_id.clone(), input))?;
        host.check_current()?;
        host.before_effect(OutboundEffect::Prompt, &prompt)?;
        let mut prompt_dispatch = DispatchGuard {
            host: host.clone(),
            effect: OutboundEffect::Prompt,
            close: self.peer.shutdown_signal(),
            finished: false,
        };
        let delivered = self
            .call("session/prompt", prompt, Some(&session_id), cancel, timeout)
            .await;
        match delivered {
            Ok((value, updates)) => {
                initial_updates.extend(updates);
                let response: PromptResponse = serde_json::from_value(value)
                    .map_err(|_| anyhow::anyhow!("Invalid outbound ACP prompt receipt"))?;
                host.record_receipt(
                    OutboundEffect::Prompt,
                    &json!({"stopReason":response.stop_reason,"updateCount":initial_updates.len()}),
                )?;
                prompt_dispatch.finished = true;
                Ok(OutboundPromptReceipt {
                    session,
                    response,
                    updates: initial_updates,
                })
            }
            Err(error) => {
                self.poisoned = true;
                if self.may_retain_original_close() {
                    // The dispatch remains unknown. Transfer only retained close
                    // to the caller; dropping a pending future still closes it.
                    host.record_unknown(OutboundEffect::Prompt)?;
                    prompt_dispatch.finished = true;
                }
                Err(error)
            }
        }
    }
    /// Stop only this runner's owned process tree and wait for its transport cleanup.
    pub async fn shutdown(&mut self) -> OutboundCleanup {
        self.peer.begin_shutdown();
        self.peer.shutdown().await;
        self.cleanup_observation()
    }
    /// Read the actual original owner's current cleanup observation without
    /// closing it. A live owner's false snapshot never becomes mutable credit.
    pub fn cleanup_observation(&self) -> OutboundCleanup {
        OutboundCleanup {
            confirmed: self.peer.cleanup_confirmed(),
            owned_pid: self.peer.owned_pid(),
            owned_endpoint_instance: self.peer.native_endpoint().map(str::to_owned),
            host: Arc::downgrade(&self.host),
        }
    }
}

#[cfg(all(test, target_os = "linux", feature = "outbound-owned-tests"))]
mod owned_tests;
