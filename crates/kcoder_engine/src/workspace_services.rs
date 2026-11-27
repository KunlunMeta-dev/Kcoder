//! Workspace services within the shared engine ownership boundary.

use super::*;

pub(super) fn client_session_storage_root(
    cwd: &Path,
) -> anyhow::Result<(PathBuf, Option<Arc<kcoder_config::PrivateTempDir>>)> {
    // A broken selected profile or workspace-continuity record must not create
    // a second, temporary task namespace. Explicit ephemeral owners below remain
    // separate from resolving the durable default.
    Ok((
        Settings::project_data_dir(cwd)?.join("client-sessions"),
        None,
    ))
}

impl WorkspaceRuntimeServices {
    pub fn new(cwd: &Path, snapshot_identity: &str) -> Self {
        let cron_scheduler = Arc::new(CronScheduler::load(cwd));
        cron_scheduler.schedule_runner();
        let shell_environment_snapshot =
            ShellEnvironmentSnapshot::schedule(cwd.to_path_buf(), snapshot_identity.to_string());
        Self {
            web_search_runtime: Arc::new(kcoder_tools::web_search::WebSearchRuntime::new()),
            cron_scheduler,
            diagnostic_writer: kcoder_state::DiagnosticWriter::default(),
            shell_environment_snapshot,
            provider_prewarmed: Arc::new(AtomicBool::new(false)),
            model_health: Arc::default(),
            client_storage: None,
        }
    }

    /// Spend the one-shot startup prewarm without sending it. A one-shot run
    /// issues its first model request immediately, so a speculative HEAD gains
    /// nothing and could take the only accept slot of a single-connection
    /// endpoint (local servers, deterministic harnesses) before that request.
    /// The delay in `schedule_provider_prewarm` cannot guarantee ordering when
    /// durable startup writes take longer than the delay.
    pub fn without_startup_provider_prewarm(self) -> Self {
        self.provider_prewarmed.store(true, Ordering::SeqCst);
        self
    }

    /// Create shared services and a unique private client-session root for an app-server workspace.
    pub fn try_new_for_client(cwd: &Path, snapshot_identity: &str) -> anyhow::Result<Self> {
        let mut services = Self::new(cwd, snapshot_identity);
        services.client_storage = Some(client_session_storage_root(cwd)?);
        Ok(services)
    }

    /// Original persistent ClientWorkspaceStore writer root. Temporary/interactive storage
    /// grants no registered-workspace inventory authority and is never repaired here.
    pub fn client_workspace_registry_root(&self) -> Option<PathBuf> {
        let (root, owner) = self.client_storage.as_ref()?;
        if owner.is_some() {
            return None;
        }
        root.parent().map(Path::to_path_buf)
    }

    /// Share workspace services while owning all ephemeral session artifacts privately.
    pub fn with_private_client_storage(&self, owner: Arc<kcoder_config::PrivateTempDir>) -> Self {
        let mut services = self.clone();
        services.client_storage = Some((owner.path().to_path_buf(), Some(owner)));
        services
    }

    /// Reuse a held original persistent artifact namespace during a host-owned
    /// restore. This binds storage only; it grants no session or model authority.
    pub fn with_existing_client_storage(
        &self,
        root: &Path,
        expected_identity: &str,
    ) -> anyhow::Result<Self> {
        let directory = kcoder_config::PrivateDirectory::open_existing(root)?;
        directory.verify_trusted_config_directory()?;
        anyhow::ensure!(
            directory.directory_identity()? == expected_identity,
            "peer_original_artifact_root_changed"
        );
        let mut services = self.clone();
        services.client_storage = Some((root.to_owned(), None));
        Ok(services)
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
    /// Share this actual owner's workspace services without constructing a
    /// second scheduler, Shell snapshot, diagnostic writer or model prewarm.
    pub fn workspace_runtime_services(&self) -> WorkspaceRuntimeServices {
        WorkspaceRuntimeServices {
            web_search_runtime: self.web_search_runtime.clone(),
            diagnostic_writer: self.state.diagnostic_writer(),
            cron_scheduler: Arc::clone(&self.cron_scheduler),
            shell_environment_snapshot: self.shell_environment_snapshot.clone(),
            provider_prewarmed: Arc::new(AtomicBool::new(true)),
            model_health: self.model_health.clone(),
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
