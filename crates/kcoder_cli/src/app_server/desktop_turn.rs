//! Turn-scoped composition of desktop tools. Called after the host has obtained
//! a DesktopSession; never installs tools globally or into subagent registries.
use anyhow::{Context, Result};
use kcoder_computer_use::session::DesktopSession;
use kcoder_engine::{DesktopTurnGuard, QueryEngine};
use kcoder_mcp::{desktop_tool::DesktopTool, model::McpToolDefinition};
use std::sync::Arc;

/// Keep alive for the foreground turn; finish must be awaited before reporting
/// the turn terminal. Drop is an abort fallback and does not prove cleanup.
pub(super) struct DesktopTurn {
    engine: QueryEngine,
    binding: Option<DesktopTurnGuard>,
    session: Arc<DesktopSession>,
    finished: bool,
    policy_watch: Option<tokio::task::JoinHandle<()>>,
    temporary: Option<kcoder_config::PrivateTempDir>,
    host: Option<Arc<kcoder_mcp::desktop_host::LocalDesktopHost>>,
    grant: Option<Arc<std::sync::Mutex<super::desktop_recovery::DesktopGrantState>>>,
}
impl DesktopTurn {
    pub(super) async fn prepare(
        engine: &QueryEngine,
        owner: kcoder_types::computer_use::DesktopOwner,
        configuration: &super::AppServerEngineFactory,
        grant: Arc<std::sync::Mutex<super::desktop_recovery::DesktopGrantState>>,
        recovery: Option<&super::desktop_recovery::RecoveryTicket>,
        session_continuation: bool,
        conversation_authorization: bool,
    ) -> Result<Self> {
        let configuration = configuration.clone();
        let settings =
            tokio::task::spawn_blocking(move || configuration.current_settings()).await??;
        let plugins = settings.plugins;
        if !kcoder_plugins::computer_use_is_enabled(&plugins)? {
            grant
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .revoke();
            anyhow::bail!("Computer Use plugin is disabled or not installed");
        }
        anyhow::ensure!(
            !kcoder_plugins::computer_use_requires_explicit_enable(&plugins, &settings.mcp_servers),
            "Windows-MCP is already configured; explicitly choose the built-in plugin before starting desktop control"
        );
        let cwd = engine.state.cwd().to_path_buf();
        let manager = Arc::new(
            kcoder_plugins::PluginManager::open_default_for_cwd_with_effective_settings(
                &cwd, plugins,
            )?,
        );
        let policy_generation = manager.store().generation()?;
        {
            let mut authorization = grant.lock().unwrap_or_else(|error| error.into_inner());
            if recovery.is_some() || session_continuation {
                authorization.check_policy_generation(policy_generation)?;
            } else {
                authorization.capture_policy_generation(policy_generation);
            }
        }
        // Verify package and temporary-directory readiness before recording a
        // control receipt. These checks cannot start a desktop-capable process.
        let runtime = Self::verify_packaged_runtime().await?;
        let temporary = kcoder_config::create_private_temp_dir("kcoder-desktop-worker")?;
        let generation = grant
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .begin_turn_with_session(
                &owner,
                recovery,
                session_continuation,
                conversation_authorization,
            )?;
        let mut turn =
            Self::start_local_authorized(engine, &runtime, temporary.path(), owner.clone()).await?;
        let host = turn
            .host
            .as_ref()
            .context("Desktop host was not retained")?
            .clone();
        let attached = grant
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .attach_host(&owner, generation, host.clone());
        if let Err(error) = attached {
            host.stop().await?;
            return Err(error);
        }
        if recovery.is_some() || session_continuation {
            turn.session.require_current_observation();
        }
        if recovery.is_some() {
            // Recovery restores observation only. Failed input is never exposed
            // to the model as an executable action in this control turn.
            let definitions = host
                .tools
                .iter()
                .filter(|definition| {
                    matches!(
                        definition.name.as_str(),
                        "Snapshot" | "Screenshot" | "DisplayInventory"
                    )
                })
                .cloned()
                .collect();
            turn.binding.take();
            let mut observed = Self::attach(engine, turn.session.clone(), definitions)?;
            observed.host = turn.host.take();
            turn.finished = true;
            turn = observed;
        }
        turn.grant = Some(grant.clone());
        turn.temporary = Some(temporary);
        let session = turn.session.clone();
        let revoker = turn.binding.as_ref().unwrap().revoker();
        turn.policy_watch = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let manager = manager.clone();
                let cwd = cwd.clone();
                let enabled = tokio::task::spawn_blocking(move || {
                    Ok::<_, anyhow::Error>((
                        manager.computer_use_enabled(&cwd)?,
                        manager.store().generation()?,
                    ))
                })
                .await;
                let valid = {
                    let mut authorization = grant.lock().unwrap_or_else(|error| error.into_inner());
                    let policy_valid = match &enabled {
                        Ok(Ok((true, observed_generation))) => authorization
                            .check_policy_generation(*observed_generation)
                            .is_ok(),
                        _ => false,
                    };
                    policy_valid && authorization.valid_for(&owner, generation)
                };
                if !valid {
                    grant
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .revoke();
                    revoker.revoke();
                    if let Err(error) = session.stop().await {
                        tracing::warn!(?error, "desktop plugin revocation cleanup failed");
                    }
                    break;
                }
            }
        }));
        Ok(turn)
    }

    async fn verify_packaged_runtime() -> Result<kcoder_computer_use::runtime::VerifiedRuntime> {
        let executable = std::env::current_exe()?;
        let started = std::time::Instant::now();
        let runtime = tokio::task::spawn_blocking(move || {
            kcoder_computer_use::packaged::installed_runtime(&executable)
        })
        .await??;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            "desktop runtime verification completed"
        );
        Ok(runtime)
    }

    pub(super) async fn start_local_authorized(
        engine: &QueryEngine,
        runtime: &kcoder_computer_use::runtime::VerifiedRuntime,
        temporary_directory: &std::path::Path,
        owner: kcoder_types::computer_use::DesktopOwner,
    ) -> Result<Self> {
        anyhow::ensure!(
            owner.thread_id == engine.session_id(),
            "desktop request belongs to a different thread"
        );
        let host = kcoder_mcp::desktop_host::LocalDesktopHost::start_authorized(
            runtime,
            temporary_directory,
            owner,
        )
        .await?;
        match Self::attach(engine, host.session.clone(), host.tools.clone()) {
            Ok(mut turn) => {
                turn.host = Some(Arc::new(host));
                Ok(turn)
            }
            Err(error) => {
                host.stop().await?;
                Err(error)
            }
        }
    }

    pub(super) fn attach(
        engine: &QueryEngine,
        session: Arc<DesktopSession>,
        definitions: Vec<McpToolDefinition>,
    ) -> Result<Self> {
        let mut scoped = engine.clone();
        // ToolRegistry is copy-on-write. Never mutate the original resident
        // registry or the shared subagent base registry.
        let mut tools = scoped.tools.clone();
        for definition in definitions {
            let tool = DesktopTool::new(definition, session.clone()).map_err(anyhow::Error::msg)?;
            tools
                .try_register(Arc::new(tool))
                .context("desktop tool registration conflict")?;
        }
        let binding = scoped
            .bind_desktop_turn(session.owner().clone())
            .map_err(anyhow::Error::msg)?;
        scoped = scoped.with_turn_tools(tools);
        Ok(Self {
            engine: scoped,
            binding: Some(binding),
            session,
            finished: false,
            policy_watch: None,
            temporary: None,
            host: None,
            grant: None,
        })
    }
    pub(super) fn engine(&self) -> &QueryEngine {
        &self.engine
    }
    pub(super) fn subscribe_state(
        &self,
    ) -> tokio::sync::watch::Receiver<kcoder_types::computer_use::DesktopSessionState> {
        self.session.subscribe_state()
    }
    pub(super) fn grant(
        &self,
    ) -> Option<Arc<std::sync::Mutex<super::desktop_recovery::DesktopGrantState>>> {
        self.grant.clone()
    }
    pub(super) fn subscribe_diagnostics(
        &self,
    ) -> tokio::sync::watch::Receiver<Option<kcoder_computer_use::session::OperationDiagnostic>>
    {
        self.session.subscribe_diagnostics()
    }
    pub(super) async fn finish(mut self) -> Result<()> {
        // Revoke already-issued contexts before waiting for OS cleanup.
        if let Some(watch) = self.policy_watch.take() {
            watch.abort();
        }
        self.binding.take();
        if let Some(grant) = self.grant.as_ref() {
            grant
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .expire_per_turn_grant(&self.session.owner().turn_id);
        }
        let result = if let Some(host) = self.host.as_ref() {
            host.stop().await
        } else {
            self.session
                .stop()
                .await
                .map_err(|error| anyhow::anyhow!("desktop cleanup failed: {error:?}"))
        };
        if let Some(grant) = self.grant.as_ref() {
            grant
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .confirm_cleanup_for_session(
                    &self.session,
                    if result.is_ok() {
                        kcoder_app_protocol::ComputerUseCleanupState::Confirmed
                    } else {
                        kcoder_app_protocol::ComputerUseCleanupState::Failed
                    },
                    true,
                );
        }
        self.finished = true;
        result
    }
}
impl Drop for DesktopTurn {
    fn drop(&mut self) {
        if let Some(watch) = self.policy_watch.take() {
            watch.abort();
        }
        self.binding.take();
        if !self.finished {
            let session = self.session.clone();
            let temporary = self.temporary.take();
            let host = self.host.take();
            let grant = self.grant.take();
            if let Some(grant) = grant.as_ref() {
                grant
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .expire_per_turn_grant(&session.owner().turn_id);
            }

            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let result = if let Some(host) = host {
                        host.stop().await
                    } else {
                        session
                            .stop()
                            .await
                            .map_err(|error| anyhow::anyhow!("desktop cleanup failed: {error:?}"))
                    };
                    if let Some(grant) = grant {
                        grant
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .confirm_cleanup_for_session(
                                &session,
                                if result.is_ok() {
                                    kcoder_app_protocol::ComputerUseCleanupState::Confirmed
                                } else {
                                    kcoder_app_protocol::ComputerUseCleanupState::Failed
                                },
                                true,
                            );
                    }
                    drop(temporary);
                });
            }
        }
    }
}
