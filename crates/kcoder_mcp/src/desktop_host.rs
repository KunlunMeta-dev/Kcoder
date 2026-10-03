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
        let input_observer = worker.input_observer();
        let recovery_peer = worker.recovery_peer();
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
            endpoint.serve_once(Arc::new(Mutex::new(grants)), broker),
        ));
        // Same-process loopback uses the exact same authenticated endpoint as a
        // future separate Studio host; the grant is never persisted to disk.
        let pipe = connect_registered(&name, std::process::id(), &id, &secret).await?;
        let session = DesktopSession::acquire(DesktopClient::from_authenticated(pipe), owner)
            .await
            .map_err(|error| anyhow::anyhow!("desktop lease acquisition failed: {error:?}"))?;
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
                _ = kcoder_computer_use::desktop::wait_until_unavailable(desktop.session_id) => "desktop_unavailable",
                reason = async {
                    loop {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        if !input_observer.healthy() { break "input_observer_unavailable"; }
                        if !recovery_peer.is_alive().unwrap_or(false) { break "recovery_process_exited"; }
                    }
                } => reason,
            };
            tracing::warn!(reason, "desktop monitor requested control cleanup");
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
            server,
        })
    }
    pub async fn stop(&self) -> Result<()> {
        self.session
            .stop()
            .await
            .map_err(|error| anyhow::anyhow!("desktop shutdown failed: {error:?}"))
            .context("local desktop host cleanup")
    }
    pub fn connection_finished(&self) -> bool {
        self.server.0.is_finished()
    }
}
