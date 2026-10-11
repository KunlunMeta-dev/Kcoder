//! Local Windows composition. Caller must obtain user permission before start;
//! no bootstrap secret is placed in arguments, environment or model context.
use crate::{desktop_worker::WindowsDesktopWorker, model::McpToolDefinition};
use anyhow::{Context, Result};
use kcoder_computer_use::{
    admission::Admissions,
    broker::DesktopBroker,
    client::DesktopClient,
    desktop::inspect_interactive_desktop,
    runtime::VerifiedRuntime,
    session::DesktopSession,
    windows_pipe::{PipeEndpoint, connect_registered},
    worker::WorkerHandle,
};
use kcoder_types::computer_use::DesktopOwner;
use std::{path::Path, sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::JoinHandle};

struct ServerTask(JoinHandle<Result<()>>);
impl Drop for ServerTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub struct LocalDesktopHost {
    pub session: Arc<DesktopSession>,
    pub tools: Vec<McpToolDefinition>,
    broker: Arc<DesktopBroker>,
    owner: DesktopOwner,
    server: ServerTask,
    _desktop_watch: ServerTask,
    _emergency_stop: kcoder_computer_use::windows_hotkey::EmergencyStopHotkey,
}
impl LocalDesktopHost {
    pub async fn start_authorized(
        runtime: &VerifiedRuntime,
        temp: &Path,
        owner: DesktopOwner,
    ) -> Result<Self> {
        let desktop = inspect_interactive_desktop()
            .map_err(|error| anyhow::anyhow!("desktop unavailable: {error:?}"))?;
        let endpoint = PipeEndpoint::create()?;
        let name = endpoint.name().to_owned();
        let worker = WindowsDesktopWorker::start(runtime, temp).await?;
        let tools = worker.tools.clone();
        let worker_pid = worker
            .process_id()
            .context("Desktop worker identity is unavailable")?;
        let input_observer = worker.input_observer();
        let recovery_peer = worker.recovery_peer();
        let worker_liveness = worker.process_liveness();
        let broker = DesktopBroker::new(
            WorkerHandle::spawn(worker, Duration::from_secs(60)),
            desktop.session_id,
        )
        .map_err(|error| anyhow::anyhow!("desktop broker failed: {error:?}"))?;
        let mut grants = Admissions::default();
        let (id, secret) = grants
            .issue(std::process::id(), desktop.session_id, owner.clone())
            .map_err(|_| anyhow::anyhow!("desktop grant registration failed"))?;
        let server = ServerTask(tokio::spawn(
            endpoint.serve_once(Arc::new(Mutex::new(grants)), broker.clone()),
        ));
        // Same-process loopback uses the exact same authenticated endpoint as a
        // future separate Studio host; the grant is never persisted to disk.
        let pipe = connect_registered(&name, std::process::id(), &id, &secret).await?;
        let session =
            DesktopSession::acquire(DesktopClient::from_authenticated(pipe), owner.clone())
                .await
                .map_err(|error| anyhow::anyhow!("desktop lease acquisition failed: {error:?}"))?;
        session.set_worker_identity(std::process::id(), worker_pid);
        let session = Arc::new(session);
        let emergency_session = session.clone();
        let runtime = tokio::runtime::Handle::current();
        let emergency_stop =
            match kcoder_computer_use::windows_hotkey::EmergencyStopHotkey::register(move || {
                runtime.spawn(async move {
                    if let Err(error) = emergency_session.stop().await {
                        tracing::warn!(?error, "emergency desktop stop failed");
                    }
                });
            }) {
                Ok(hotkey) => hotkey,
                Err(error) => {
                    session.stop().await.map_err(|failure| {
                        anyhow::anyhow!("hotkey unavailable and cleanup failed: {failure:?}")
                    })?;
                    return Err(error);
                }
            };
        let watched_session = session.clone();
        let desktop_watch = ServerTask(tokio::spawn(async move {
            let reason = tokio::select! {
                reason = kcoder_computer_use::desktop::wait_until_unavailable_reason(desktop.session_id) =>
                    if matches!(reason, kcoder_computer_use::desktop::DesktopPreflightError::DesktopLocked) { "desktop_locked" } else { "desktop_unavailable" },
                reason = async {
                    loop {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        if worker_liveness.try_lock().is_ok_and(|child| child.is_running().is_ok_and(|running| !running)) { break "worker_exited"; }
                        if !input_observer.healthy() { break "input_observer_unavailable"; }
                        if !recovery_peer.is_alive().unwrap_or(false) { break "recovery_process_exited"; }
                    }
                } => reason,
            };
            tracing::warn!(
                reason,
                host_pid = std::process::id(),
                worker_pid,
                "desktop monitor requested control cleanup"
            );
            watched_session.note_host_failure(reason);
            watched_session.stop().await.map_err(|error| {
                tracing::warn!(?error, "desktop became unavailable; cleanup failed");
                anyhow::anyhow!("desktop loss cleanup failed: {error:?}")
            })
        }));
        Ok(Self {
            _desktop_watch: desktop_watch,
            _emergency_stop: emergency_stop,
            session,
            tools,
            broker,
            owner,
            server,
        })
    }
    pub async fn stop(&self) -> Result<()> {
        // The same owned broker can provide the actual supervisor receipt even
        // after a failed client transport. Never infer cleanup from disconnection.
        self.session.begin_host_cleanup();
        if let Err(error) = self.broker.disconnect_owner(&self.owner).await {
            self.session.note_host_failure("cleanup_failed");
            return Err(anyhow::anyhow!("desktop host cleanup failed: {error:?}"))
                .context("local desktop host cleanup");
        }
        self.session.confirm_host_cleanup().await;
        Ok(())
    }
    pub fn connection_finished(&self) -> bool {
        self.server.0.is_finished()
    }
}
