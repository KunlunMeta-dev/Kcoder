//! Selected-target owned Node host. No un-supervised or Gateway-local fallback exists.
use super::super::core::NativeIntegrationContext;
use super::{
    NativeConnectivityFactPipe, NativeConnectivityLeaseFacade, NativeConnectivityParent,
    NativeConnectivityPrivateContribution,
    facts::NativeFactReadLease,
    host_rpc::{HostRpc, ReverseRequest},
};
use anyhow::{Context, Result, ensure};
use async_trait::async_trait;
use kcoder_app_protocol::integrations::connectivity::ConnectivityPortCall;
use kcoder_app_rpc_codec as rpc_codec;
pub use kcoder_host_transport::process::NativeConnectivityHostPaths;
pub use kcoder_host_transport::process::{OwnedTree, verify_program_path};
use kcoder_types::integrations::core::IntegrationReply;
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, BufReader},
    sync::Notify,
};
use tokio_util::sync::CancellationToken;

#[async_trait]
pub trait NativeConnectivityReverseHandler: Send + Sync {
    async fn handle(
        &self,
        context: &NativeIntegrationContext,
        parent: &NativeConnectivityParent,
        pipe: &dyn NativeConnectivityFactPipe,
        method: &str,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value>;
}

pub use kcoder_native_service_runtime::connectivity::main_exit::{
    ExitState, NativeConnectivityMainExitReceipt,
};
#[cfg(windows)]
#[derive(Debug)]
struct OriginalHostStartupFailure {
    code: &'static str,
    reason_sha256: Vec<String>,
}
#[cfg(windows)]
impl std::fmt::Display for OriginalHostStartupFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code)
    }
}
#[cfg(windows)]
impl std::error::Error for OriginalHostStartupFailure {}
#[cfg(windows)]
pub fn original_startup_failure_digests(error: &anyhow::Error) -> Option<Vec<String>> {
    error
        .downcast_ref::<OriginalHostStartupFailure>()
        .map(|value| value.reason_sha256.clone())
}
#[cfg(windows)]
fn startup_digest(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
struct OwnedFactPipe {
    context: Arc<NativeIntegrationContext>,
    parent: Arc<NativeConnectivityParent>,
    facade: Arc<NativeConnectivityLeaseFacade>,
    rpc: Arc<HostRpc>,
}
impl OwnedFactPipe {
    async fn read_checked(
        &self,
        parent: &NativeConnectivityParent,
        expected_lease: Option<&str>,
        method: &'static str,
        payload: Value,
    ) -> Result<(Value, String)> {
        ensure!(
            parent.id == self.parent.id,
            "CONNECTIVITY_FACT_PIPE_OWNER_MISMATCH"
        );
        ensure!(
            [
                "connectivity.installationFacts",
                "connectivity.resolveApplicationResources",
                "connectivity.resolveApplicationConfiguration"
            ]
            .contains(&method),
            "CONNECTIVITY_FACT_METHOD_DENIED"
        );
        if method != "connectivity.installationFacts" {
            let requested: kcoder_types::integrations::core::IntegrationScope = rpc_codec::decode(
                payload
                    .get("scope")
                    .cloned()
                    .context("CONNECTIVITY_FACT_SCOPE_REQUIRED")?,
            )?;
            // Scope labels select the pipe; current identity is checked below.
            self.context.check_captured_scope(&requested)?;
        }
        let gateway_lease =
            self.facade
                .held_gateway_transport_lease(&self.context, parent, expected_lease)?;
        let selected;
        let lease_id = if let Some(lease) = &gateway_lease {
            self.context.verify()?;
            lease.lease_id.as_str()
        } else if let Some(id) = expected_lease {
            self.facade.require_ready(&self.context, Some(parent), id)?;
            id
        } else {
            selected = self.facade.ready_lease_id(&self.context, parent)?;
            &selected
        };
        let result = self
            .rpc
            .call(method, payload, Duration::from_secs(30), None)
            .await?;
        let namespace = if let Some(lease) = &gateway_lease {
            ensure!(
                self.facade
                    .held_gateway_transport_lease(&self.context, parent, Some(&lease.lease_id))?
                    .is_some(),
                "CONNECTIVITY_FACT_PIPE_OWNER_MISMATCH"
            );
            self.context.verify()?;
            lease.namespace_id.clone()
        } else {
            self.facade
                .ready_namespace(&self.context, Some(parent), lease_id)?
                .into()
        };
        Ok((result, namespace))
    }
}

#[async_trait]
impl NativeConnectivityFactPipe for OwnedFactPipe {
    async fn read_owned(
        &self,
        parent: &NativeConnectivityParent,
        method: &'static str,
        payload: Value,
    ) -> Result<Value> {
        self.read_checked(parent, None, method, payload)
            .await
            .map(|(value, _)| value)
    }

    async fn read_on_lease(
        &self,
        lease: &NativeFactReadLease<'_>,
        method: &'static str,
        payload: Value,
    ) -> Result<(Value, String)> {
        if !std::ptr::eq(lease.facade, self.facade.as_ref()) {
            return lease.read_via(self, method, payload).await;
        }
        // The original pipe checks live identity on each side of IPC. Matching
        // captured scopes do not require another read of that same identity.
        lease.context.check_captured_scope(self.context.scope())?;
        let (value, namespace) = self
            .read_checked(lease.parent, Some(lease.id), method, payload)
            .await?;
        lease.context.check_captured_scope(self.context.scope())?;
        Ok((value, namespace))
    }
}

struct Dispatcher {
    pipe: Arc<OwnedFactPipe>,
    handler: Arc<dyn NativeConnectivityReverseHandler>,
}
#[async_trait]
impl ReverseRequest for Dispatcher {
    async fn handle(&self, method: &str, params: Value) -> Result<Value> {
        let context = &self.pipe.context;
        let parent = &self.pipe.parent;
        parent.verify(context)?;
        let contribution = NativeConnectivityPrivateContribution {
            context,
            facade: &self.pipe.facade,
            parent: Some(parent.clone()),
        };
        if let Some(value) = contribution.handle(method, params.clone())? {
            return Ok(value);
        }
        if method == "private.host.ready" {
            ensure!(
                params["contractVersion"] == "parallel-v1",
                "CONNECTIVITY_HOST_CONTRACT_MISMATCH"
            );
            let lease = self.pipe.facade.lease_for_parent(context, parent)?;
            self.pipe
                .facade
                .require_ready(context, Some(parent), &lease.lease_id)?;
            self.pipe.rpc.operational.store(true, Ordering::Release);
            self.pipe.rpc.ready.notify_waiters();
            return Ok(json!({"ready":true}));
        }
        ensure!(
            allowed_reverse(method),
            "CONNECTIVITY_REVERSE_METHOD_DENIED"
        );
        if method != "private.host.configuration" {
            let lease = self.pipe.facade.lease_for_parent(context, parent)?;
            self.pipe
                .facade
                .require_ready(context, Some(parent), &lease.lease_id)?;
        }
        let result = self
            .handler
            .handle(
                context,
                parent,
                self.pipe.as_ref(),
                method,
                params,
                self.pipe.rpc.cancel.clone(),
            )
            .await?;
        parent.verify(context)?;
        Ok(result)
    }
}
fn allowed_reverse(method: &str) -> bool {
    [
        "private.host.configuration",
        "private.integration.call",
        "private.connectivity.inventory",
        "private.applications.call",
    ]
    .contains(&method)
}

pub struct NativeConnectivityHost {
    pipe: Arc<OwnedFactPipe>,
    owner: Arc<OwnedTree>,
    exit: Arc<ExitState>,
}
impl Drop for NativeConnectivityHost {
    fn drop(&mut self) {
        self.pipe.rpc.cancel.cancel();
        let _ = self.owner.stop();
    }
}
impl NativeConnectivityHost {
    pub fn spawn(
        context: Arc<NativeIntegrationContext>,
        facade: Arc<NativeConnectivityLeaseFacade>,
        paths: NativeConnectivityHostPaths,
        handler: Arc<dyn NativeConnectivityReverseHandler>,
    ) -> futures::future::BoxFuture<'static, Result<Arc<Self>>> {
        Box::pin(Self::spawn_default_inner(context, facade, paths, handler))
    }
    async fn spawn_default_inner(
        context: Arc<NativeIntegrationContext>,
        facade: Arc<NativeConnectivityLeaseFacade>,
        paths: NativeConnectivityHostPaths,
        handler: Arc<dyn NativeConnectivityReverseHandler>,
    ) -> Result<Arc<Self>> {
        Self::spawn_inner_in_scope(context, facade, paths, handler, None).await
    }
    pub fn spawn_in_scope(
        context: Arc<NativeIntegrationContext>,
        facade: Arc<NativeConnectivityLeaseFacade>,
        paths: NativeConnectivityHostPaths,
        handler: Arc<dyn NativeConnectivityReverseHandler>,
        scope_host: Option<Arc<crate::app_server::NativeScopeHostBootstrap>>,
    ) -> futures::future::BoxFuture<'static, Result<Arc<Self>>> {
        Box::pin(Self::spawn_in_scope_inner(
            context, facade, paths, handler, scope_host,
        ))
    }
    async fn spawn_in_scope_inner(
        context: Arc<NativeIntegrationContext>,
        facade: Arc<NativeConnectivityLeaseFacade>,
        paths: NativeConnectivityHostPaths,
        handler: Arc<dyn NativeConnectivityReverseHandler>,
        scope_host: Option<Arc<crate::app_server::NativeScopeHostBootstrap>>,
    ) -> Result<Arc<Self>> {
        Self::spawn_inner_in_scope(context, facade, paths, handler, scope_host).await
    }
    async fn spawn_inner_in_scope(
        context: Arc<NativeIntegrationContext>,
        facade: Arc<NativeConnectivityLeaseFacade>,
        paths: NativeConnectivityHostPaths,
        handler: Arc<dyn NativeConnectivityReverseHandler>,
        scope_host: Option<Arc<crate::app_server::NativeScopeHostBootstrap>>,
    ) -> Result<Arc<Self>> {
        context.verify()?;
        let scope = context.scope().clone();
        let data = facade.private_data_path(&context)?;
        for path in [&paths.node, &paths.entry, &paths.supervisor] {
            verify_program_path(path)?;
        }
        if let Some(scope_host) = &scope_host {
            scope_host.begin_original_main_spawn()?;
        }
        let (mut child, owner, proof) = spawn_owned(&paths, &data, scope_host.as_ref()).await?;
        let parent = match NativeConnectivityParent::capture(&context, &mut child, proof) {
            Ok(parent) => Arc::new(parent),
            Err(error) => {
                let _ = owner.stop();
                let _ = tokio::time::timeout(Duration::from_secs(8), child.wait()).await;
                return Err(error);
            }
        };
        if let Some(scope_host) = scope_host {
            parent.bind_scope_host(&context, scope_host.clone())?;
            scope_host.register_original_main(&parent)?;
        }
        if let Err(error) = context.validate_scope(&scope) {
            let _ = owner.stop();
            let _ = tokio::time::timeout(Duration::from_secs(8), child.wait()).await;
            return Err(error);
        }
        let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = owner.stop();
            let _ = tokio::time::timeout(Duration::from_secs(8), child.wait()).await;
            anyhow::bail!("CONNECTIVITY_HOST_PIPE_UNAVAILABLE");
        };
        #[cfg(windows)]
        let startup_stderr = Arc::new(std::sync::Mutex::new(None::<Vec<String>>));
        if let Some(mut stderr) = child.stderr.take() {
            #[cfg(test)]
            let original_pid = parent.pid;
            #[cfg(windows)]
            let observed = startup_stderr.clone();
            crate::app_server::task_spawn::spawn(async move {
                let mut bytes = [0u8; 4096];
                #[cfg(test)]
                let mut original_stderr = Vec::new();
                #[cfg(windows)]
                let mut captured = Vec::new();
                #[cfg(windows)]
                let mut truncated = false;
                #[cfg(windows)]
                let mut read_failed = false;
                loop {
                    match stderr.read(&mut bytes).await {
                        Ok(0) => break,
                        Err(_) => {
                            #[cfg(windows)]
                            {
                                read_failed = true;
                            }
                            break;
                        }
                        Ok(count) => {
                            #[cfg(test)]
                            if original_stderr.len() + count <= 256 * 1024 {
                                original_stderr.extend_from_slice(&bytes[..count]);
                                owned_evidence::stderr(original_pid, &original_stderr);
                            }
                            #[cfg(windows)]
                            {
                                let available = 65536usize.saturating_sub(captured.len());
                                let kept = available.min(count);
                                captured.extend_from_slice(&bytes[..kept]);
                                truncated |= kept != count;
                            }
                        }
                    }
                }
                #[cfg(windows)]
                {
                    // No stderr text leaves this owned reader. Whole fixed-code
                    // lines and a bounded stream are represented only by SHA.
                    let mut digests = Vec::new();
                    for line in captured.split(|byte| *byte == b'\n') {
                        let line = line.strip_suffix(b"\r").unwrap_or(line);
                        if (2..=100).contains(&line.len())
                            && line[0].is_ascii_uppercase()
                            && line.iter().all(|byte| {
                                byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_'
                            })
                            && digests.len() < 2
                        {
                            digests.push(startup_digest(line));
                        }
                    }
                    if read_failed {
                        digests.push(startup_digest(b"CONNECTIVITY_HOST_STDERR_READ_UNCONFIRMED"));
                    }
                    if captured.is_empty() && !read_failed {
                        digests.push(startup_digest(b"CONNECTIVITY_HOST_STDERR_EMPTY"));
                    }
                    if truncated {
                        digests.push(startup_digest(b"CONNECTIVITY_HOST_STDERR_BOUNDED"));
                    }
                    digests.push(startup_digest(&captured));
                    if let Ok(mut target) = observed.lock() {
                        *target = Some(digests);
                    }
                }
            });
        }
        let (rpc, output) = HostRpc::new();
        let pipe = Arc::new(OwnedFactPipe {
            context: context.clone(),
            parent: parent.clone(),
            facade: facade.clone(),
            rpc: rpc.clone(),
        });
        let exit = Arc::new(ExitState {
            exited: AtomicBool::new(false),
            notify: Notify::new(),
            #[cfg(windows)]
            code: std::sync::atomic::AtomicI32::new(i32::MIN),
        });
        let owner = Arc::new(owner);
        let host = Arc::new(Self {
            pipe: pipe.clone(),
            owner: owner.clone(),
            exit: exit.clone(),
        });
        let dispatcher = Arc::new(Dispatcher { pipe, handler });
        crate::app_server::task_spawn::spawn({
            let rpc = rpc.clone();
            async move {
                #[cfg(test)]
                let original_pid = dispatcher.pipe.parent.pid;
                let observed = rpc.run_reader(BufReader::new(stdout), dispatcher).await;
                #[cfg(test)]
                owned_evidence::pipe(original_pid, "reader", &observed);
                #[cfg(not(test))]
                let _ = observed;
            }
        });
        crate::app_server::task_spawn::spawn({
            let rpc = rpc.clone();
            #[cfg(test)]
            let original_main_pid = parent.pid;
            async move {
                let observed = rpc.run_writer(stdin, output).await;
                #[cfg(test)]
                owned_evidence::pipe(original_main_pid, "writer", &observed);
                #[cfg(not(test))]
                let _ = observed;
            }
        });
        crate::app_server::task_spawn::spawn({
            let rpc = rpc.clone();
            let context = context.clone();
            #[cfg(windows)]
            let exit = exit.clone();
            async move {
                let (trigger, waited) = tokio::select! {
                    _=rpc.cancel.cancelled()=>{let _=owner.stop();("rpc_cancel",child.wait().await)},
                    result=child.wait()=>("child_exit",result),
                };
                #[cfg(windows)]
                exit.code.store(
                    waited
                        .as_ref()
                        .ok()
                        .and_then(|value| value.code())
                        .unwrap_or(i32::MIN + 1),
                    Ordering::Release,
                );
                #[cfg(test)]
                owned_evidence::exit(parent.pid, trigger, &waited, rpc.cancel.is_cancelled());
                #[cfg(not(test))]
                let _ = (trigger, waited);
                let _ = owner.stop();
                while !parent.alive().is_ok_and(|alive| !alive) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                rpc.cancel.cancel();
                let _ = facade.release_exited_parent(&parent);
                let _ = context.verify();
                exit.exited.store(true, Ordering::Release);
                exit.notify.notify_waiters();
            }
        });
        let startup = async {
            loop {
                if rpc.operational.load(Ordering::Acquire) {
                    return Ok::<(), anyhow::Error>(());
                }
                tokio::select! {_ = rpc.ready.notified()=>{},_ = rpc.cancel.cancelled()=>anyhow::bail!("CONNECTIVITY_HOST_STARTUP_UNCONFIRMED"),_ = tokio::time::sleep(Duration::from_millis(10))=>{}}
            }
        };
        if !matches!(
            tokio::time::timeout(Duration::from_secs(30), startup).await,
            Ok(Ok(()))
        ) {
            let cleanup = host.close().await;
            #[cfg(windows)]
            {
                let code = if cleanup.is_ok() {
                    "CONNECTIVITY_HOST_STARTUP_UNCONFIRMED"
                } else {
                    "CONNECTIVITY_HOST_CLEANUP_UNCONFIRMED"
                };
                let mut reason_sha256 = vec![startup_digest(code.as_bytes())];
                let observed = startup_stderr.lock().ok().and_then(|value| value.clone());
                reason_sha256.extend(observed.unwrap_or_else(|| {
                    vec![startup_digest(b"CONNECTIVITY_HOST_STDERR_UNCONFIRMED")]
                }));
                reason_sha256.truncate(5);
                reason_sha256.push(startup_digest(
                    format!(
                        "CONNECTIVITY_HOST_EXIT_CODE_{}",
                        exit.code.load(Ordering::Acquire)
                    )
                    .as_bytes(),
                ));
                return Err(OriginalHostStartupFailure {
                    code,
                    reason_sha256,
                }
                .into());
            }
            #[cfg(not(windows))]
            return Err(anyhow::anyhow!(if cleanup.is_ok() {
                "CONNECTIVITY_HOST_STARTUP_UNCONFIRMED"
            } else {
                "CONNECTIVITY_HOST_CLEANUP_UNCONFIRMED"
            }));
        }
        if let Err(error) = context.validate_scope(&scope) {
            let _ = host.close().await;
            return Err(error);
        }
        Ok(host)
    }
    pub fn call<'a>(
        &'a self,
        call: &'a ConnectivityPortCall,
        cancel: Option<&'a CancellationToken>,
    ) -> futures::future::BoxFuture<'a, Result<IntegrationReply>> {
        Box::pin(self.call_inner(call, cancel))
    }
    async fn call_inner(
        &self,
        call: &ConnectivityPortCall,
        cancel: Option<&CancellationToken>,
    ) -> Result<IntegrationReply> {
        call.validate().map_err(anyhow::Error::msg)?;
        self.pipe.context.validate_scope(&call.request.scope)?;
        ensure!(
            self.pipe.rpc.operational.load(Ordering::Acquire),
            "CONNECTIVITY_HOST_UNAVAILABLE"
        );
        let result = self
            .pipe
            .rpc
            .call(
                "connectivity.call",
                json!({"port":call.port,"method":call.method,"request":call.request}),
                Duration::from_millis(call.request.timeout_ms),
                cancel,
            )
            .await?;
        self.pipe.context.validate_scope(&call.request.scope)?;
        let reply: IntegrationReply = rpc_codec::decode(result)?;
        ensure!(
            reply.request_id == call.request.request_id
                && reply.operation_id.as_ref() == call.request.operation_id.as_ref(),
            "CONNECTIVITY_RESPONSE_IDENTITY_MISMATCH"
        );
        Ok(reply)
    }
    pub fn parent(&self) -> &NativeConnectivityParent {
        &self.pipe.parent
    }
    pub fn parent_arc(&self) -> Arc<NativeConnectivityParent> {
        self.pipe.parent.clone()
    }
    pub fn close(&self) -> futures::future::BoxFuture<'_, Result<()>> {
        Box::pin(self.close_inner())
    }
    async fn close_inner(&self) -> Result<()> {
        // Only this actual owned Main receives the existing fixed shutdown.
        // Let application resource cleanup settle before the supervisor stops
        // the owned tree and the original RPC reader drains.
        let _ = tokio::time::timeout(
            Duration::from_secs(3),
            self.pipe.rpc.call(
                "connectivity.close",
                serde_json::json!({}),
                Duration::from_secs(3),
                None,
            ),
        )
        .await;

        self.pipe.rpc.cancel.cancel();
        self.owner.stop()?;
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                if self.exit.exited.load(Ordering::Acquire) {
                    break;
                }
                tokio::select!{_ = self.exit.notify.notified()=>{},_ = tokio::time::sleep(Duration::from_millis(10))=>{}}
            }
        })
        .await
        .context("CONNECTIVITY_HOST_CLEANUP_UNCONFIRMED")?;
        self.pipe.rpc.wait_reader_drained().await?;
        if let Some(scope) = self.pipe.parent.scope_host() {
            scope.retire_original_main(
                &self.pipe.parent,
                NativeConnectivityMainExitReceipt::from_owned_cleanup(
                    Arc::downgrade(&self.pipe.parent),
                    self.exit.clone(),
                ),
            )?;
        }
        Ok(())
    }
}
#[async_trait]
impl NativeConnectivityFactPipe for NativeConnectivityHost {
    async fn read_owned(
        &self,
        parent: &NativeConnectivityParent,
        method: &'static str,
        payload: Value,
    ) -> Result<Value> {
        self.pipe.read_owned(parent, method, payload).await
    }

    async fn read_on_lease(
        &self,
        lease: &NativeFactReadLease<'_>,
        method: &'static str,
        payload: Value,
    ) -> Result<(Value, String)> {
        self.pipe.read_on_lease(lease, method, payload).await
    }
}

pub use kcoder_native_service_runtime::connectivity::process_spawn::spawn_owned;

#[cfg(test)]
#[path = "host_process/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "host_process/owned_evidence.rs"]
mod owned_evidence;

#[cfg(test)]
use {super::NativeConnectivityExitProof, std::path::Path, tokio::process::Child};
