//! Workspace services within the shared engine ownership boundary.

use super::*;

pub(super) fn client_session_storage_root(
    cwd: &Path,
) -> anyhow::Result<(PathBuf, Option<Arc<kcoder_config::PrivateTempDir>>)> {
    client_session_storage_root_with(Settings::project_data_dir(cwd), || {
        kcoder_config::create_private_temp_dir("kcoder-client")
    })
}

pub(super) fn client_session_storage_root_with(
    project_data_dir: anyhow::Result<PathBuf>,
    create_fallback: impl FnOnce() -> anyhow::Result<kcoder_config::PrivateTempDir>,
) -> anyhow::Result<(PathBuf, Option<Arc<kcoder_config::PrivateTempDir>>)> {
    let root = match project_data_dir {
        Ok(project_data_dir) => return Ok((project_data_dir.join("client-sessions"), None)),
        Err(error) => {
            warn!(
                "failed to resolve project data directory for client session: {}; using a private temporary directory",
                error
            );
            Arc::new(create_fallback()?)
        }
    };
    Ok((root.path().join("client-sessions"), Some(root)))
}

impl WorkspaceRuntimeServices {
    pub fn new(cwd: &Path, snapshot_identity: &str) -> Self {
        let cron_scheduler = Arc::new(CronScheduler::load(cwd));
        cron_scheduler.schedule_runner();
        let shell_environment_snapshot =
            ShellEnvironmentSnapshot::schedule(cwd.to_path_buf(), snapshot_identity.to_string());
        Self {
            cron_scheduler,
            diagnostic_writer: kcoder_state::DiagnosticWriter::default(),
            shell_environment_snapshot,
            provider_prewarmed: Arc::new(AtomicBool::new(false)),
            client_storage: None,
        }
    }

    /// Create shared services and a unique private client-session root for an app-server workspace.
    pub fn try_new_for_client(cwd: &Path, snapshot_identity: &str) -> anyhow::Result<Self> {
        let mut services = Self::new(cwd, snapshot_identity);
        services.client_storage = Some(client_session_storage_root(cwd)?);
        Ok(services)
    }

    /// Share workspace services while owning all ephemeral session artifacts privately.
    pub fn with_private_client_storage(&self, owner: Arc<kcoder_config::PrivateTempDir>) -> Self {
        let mut services = self.clone();
        services.client_storage = Some((owner.path().to_path_buf(), Some(owner)));
        services
    }

    pub(super) fn prewarm_provider_once(&self, provider: Arc<dyn Provider>) {
        if self
            .provider_prewarmed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            schedule_provider_prewarm(provider);
        }
    }
}

impl WorkspacePersistenceMode {
    pub(super) fn allows_implicit_project_writes(self) -> bool {
        matches!(self, Self::Interactive)
    }
}

impl QueryEngine {
    pub(super) fn workspace_runtime_services(&self) -> WorkspaceRuntimeServices {
        WorkspaceRuntimeServices {
            diagnostic_writer: self.state.diagnostic_writer(),
            cron_scheduler: Arc::clone(&self.cron_scheduler),
            shell_environment_snapshot: self.shell_environment_snapshot.clone(),
            provider_prewarmed: Arc::new(AtomicBool::new(true)),
            client_storage: matches!(
                self.workspace_persistence_mode,
                WorkspacePersistenceMode::Client
            )
            .then(|| {
                (
                    self.session_storage_root.clone(),
                    self.client_storage_owner.clone(),
                )
            }),
        }
    }
}
