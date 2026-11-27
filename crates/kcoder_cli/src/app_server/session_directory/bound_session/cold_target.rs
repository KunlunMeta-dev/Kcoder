//! Original cold-target restore material. No directory fact grants execution.
//!
//! The actual connection owner supplies a fresh route/source fence, reserves
//! resident capacity and uses the existing Native factory. This module neither
//! installs a runtime nor starts Hooks, a User input, a Goal or a Provider turn.
use super::*;
use crate::app_server::session_messages::service::PeerMessageService;
use kcoder_cli_storage::session_lease::SessionLease;
use kcoder_state::PreparedSessionResume;
use kcoder_types::{
    session_address::SessionAddressV1, settings_templates::SettingsTemplateBinding,
};
use std::{fs::File, sync::Arc};

/// Implemented only by the actual host's current source/route owner. A saved
/// attestation, historical row or configured boolean is not an implementation.
pub(crate) trait ColdPeerTargetFence: Send + Sync {
    fn check_current(&self, target: &SessionAddressV1) -> Result<()>;
}

/// Bounded read for enqueue admission. It acquires no writer lease and does
/// not prepare full history, create artifacts, restore an Engine or wake it.
pub(crate) fn observe_cold_target(
    service: &PeerMessageService,
    view: &DirectorySourceView<'_>,
    address: &SessionAddressV1,
    fence: &dyn ColdPeerTargetFence,
) -> Result<BoundPeerSession> {
    verify_scope(service, view, address, fence, false)?;
    let bound = SessionDirectory::default()
        .lookup_bound_view(view, &address.thread_id, &HashSet::new())?
        .context("peer_cold_target_history_unavailable")?;
    verify_target(&bound, view)?;
    verify_scope(service, view, address, fence, false)?;
    Ok(bound)
}

fn verify_scope(
    service: &PeerMessageService,
    view: &DirectorySourceView<'_>,
    address: &SessionAddressV1,
    fence: &dyn ColdPeerTargetFence,
    wake: bool,
) -> Result<()> {
    address.validate().map_err(anyhow::Error::msg)?;
    fence.check_current(address)?;
    service.require_enabled(wake)?;
    ensure!(
        service.identity()?.contains(address) && service.workspace_matches(&view.workspace),
        "peer_cold_target_scope_changed"
    );
    view.verify()
}

fn verify_target(bound: &BoundPeerSession, view: &DirectorySourceView<'_>) -> Result<()> {
    bound.verify(view)?;
    let current = observation::observe(&bound.scope, &bound.candidate)?
        .context("peer_cold_target_history_unavailable")?;
    ensure!(current.archived_at.is_none(), "peer_cold_target_archived");
    let metadata = bound.metadata(view)?;
    ensure!(
        metadata.session_mode() == kcoder_state::SessionMode::Default
            && !metadata.has_native_subagent_outbox()
            && metadata.channel_task_source().is_none()
            && metadata.agent_definition().is_none(),
        "peer_cold_target_independent_session_required"
    );
    bound.verify(view)
}

pub(crate) struct ColdPeerTargetArtifacts {
    root: Arc<Root>,
    scope: Arc<DirectoryScope>,
    child_identity: String,
    child: Arc<PrivateDirectory>,
    attempts: Option<kcoder_state::turn_attempt_store::TurnAttemptStore>,
}
impl ColdPeerTargetArtifacts {
    fn require_terminal_turn(&self, thread: &str) -> Result<()> {
        self.verify(thread)?;
        let store = self
            .attempts
            .as_ref()
            .context("peer_cold_target_terminal_unobserved")?;
        // This complete inspection is confined to the original lease's cold
        // activation boundary. Ordinary discovery retains its small budget.
        let records = store.list_with_budget(10_000, 64 * 1024 * 1024)?;
        ensure!(!records.is_empty(), "peer_cold_target_terminal_unobserved");
        use kcoder_types::TurnAttemptStatus;
        ensure!(
            records.iter().all(|record| matches!(
                record.status,
                TurnAttemptStatus::Completed
                    | TurnAttemptStatus::Failed
                    | TurnAttemptStatus::Interrupted
            ) && record
                .completion
                .as_ref()
                .is_some_and(|completion| completion.status == record.status)),
            "peer_cold_target_original_turn_unsettled"
        );
        self.verify(thread)
    }
    fn capture(bound: &BoundPeerSession) -> Result<Self> {
        let mut found = None;
        for root in &bound.scope.artifacts {
            root.verify()?;
            let child = match root
                .directory
                .open_child(OsStr::new(&bound.candidate.id), false)
            {
                Ok(child) => child,
                Err(error) if missing(&error) => continue,
                Err(error) => return Err(error),
            };
            child.verify_trusted_config_directory()?;
            ensure!(found.is_none(), "peer_cold_target_artifacts_ambiguous");
            let child = Arc::new(child);
            let attempts = kcoder_state::turn_attempt_store::TurnAttemptStore::open_existing_in(
                child.clone(),
                &bound.candidate.id,
            )?;
            found = Some(Self {
                root: root.clone(),
                scope: bound.scope.clone(),
                child_identity: child.directory_identity()?,
                child,
                attempts,
            });
        }
        found.context("peer_cold_target_artifacts_unobserved")
    }
    pub(crate) fn verify(&self, thread: &str) -> Result<()> {
        self.root.verify()?;
        let child = self.root.directory.open_child(OsStr::new(thread), false)?;
        child.verify_trusted_config_directory()?;
        ensure!(
            child.directory_identity()? == self.child_identity
                && self.child.directory_identity()? == self.child_identity,
            "peer_cold_target_artifacts_changed"
        );
        ensure!(
            observation::client_metadata_in(&self.child, thread, &self.scope.workspace)?
                .as_ref()
                .and_then(|metadata| metadata.fields.get("archivedAt"))
                .and_then(Option::as_ref)
                .is_none(),
            "peer_cold_target_archived"
        );
        if let Some(store) = &self.attempts {
            store.verify_binding()?;
        }
        Ok(())
    }
}

/// A passive owner of the exact original history and artifact namespaces.
/// The caller must retain this guard across factory refresh and runtime
/// installation. It supplies no peer wake admission or provider budget permit.
pub(crate) struct PreparedColdPeerTarget {
    address: SessionAddressV1,
    bound: BoundPeerSession,
    artifacts: ColdPeerTargetArtifacts,
    lease: SessionLease,
    prepared: Option<PreparedSessionResume>,
    client_turn_count: usize,
    settings_template: Option<SettingsTemplateBinding>,
    permission_mode_at_creation: Option<kcoder_config::PermissionMode>,
    restored: bool,
    _metadata_locks: Vec<File>,
}
impl PreparedColdPeerTarget {
    pub(crate) fn prepare_wake(
        service: &PeerMessageService,
        view: &DirectorySourceView<'_>,
        address: &SessionAddressV1,
        fence: &dyn ColdPeerTargetFence,
    ) -> Result<Self> {
        verify_scope(service, view, address, fence, true)?;
        let bound = observe_cold_target(service, view, address, fence)?;
        let artifacts = ColdPeerTargetArtifacts::capture(&bound)?;
        let metadata_locks = kcoder_thread_metadata::try_acquire_thread_lifecycle_locks_at_root(
            &artifacts.root.path,
            &[&address.thread_id],
        )?;
        verify_target(&bound, view)?;
        let path = bound.history_path();
        let parent = bound.candidate.parent()?;
        let original_lease = parent
            .open_single_link_regular_file(OsStr::new(&format!("{}.lease", address.thread_id)))?;
        let original_identity = parent.portable_regular_handle_identity(&original_lease)?;
        let lease = SessionLease::acquire_observed_history(&path, &original_identity)?;
        lease.native_witness()?.verify_target(&path)?;
        let (prepared, client_turn_count) =
            kcoder_state::prepare_session_resume_real_user_counting(&path)?;
        let base = prepared
            .persisted_base_cwd()
            .context("peer_cold_target_workspace_unobserved")?;
        ensure!(
            dunce::canonicalize(base)? == bound.scope.workspace
                && !prepared.has_legacy_channel_source(),
            "peer_cold_target_restore_scope_changed"
        );
        let client = bound.client_metadata(view)?;
        let field = |name: &str| {
            client
                .as_ref()
                .and_then(|metadata| metadata.fields.get(name))
        };
        let permission_mode_at_creation = field("permissionModeAtCreation")
            .map(|value| {
                let value = value
                    .as_ref()
                    .context("peer_cold_target_permission_baseline_unavailable")?;
                serde_json::from_value::<kcoder_config::PermissionMode>(serde_json::Value::String(
                    value.clone(),
                ))
                .map_err(anyhow::Error::from)
            })
            .transpose()?;
        let settings_template = field("settingsTemplate")
            .and_then(Option::as_ref)
            .map(|value| serde_json::from_str::<SettingsTemplateBinding>(value))
            .transpose()?;
        let prepared = Self {
            address: address.clone(),
            bound,
            artifacts,
            lease,
            prepared: Some(prepared),
            client_turn_count,
            settings_template,
            permission_mode_at_creation,
            restored: false,
            _metadata_locks: metadata_locks,
        };
        prepared.verify(service, view, fence)?;
        Ok(prepared)
    }

    pub(crate) fn verify(
        &self,
        service: &PeerMessageService,
        view: &DirectorySourceView<'_>,
        fence: &dyn ColdPeerTargetFence,
    ) -> Result<()> {
        verify_scope(service, view, &self.address, fence, true)?;
        verify_target(&self.bound, view)?;
        self.artifacts.verify(&self.address.thread_id)?;
        self.lease
            .native_witness()?
            .verify_target(&self.bound.history_path())?;
        // A released process lease is not proof that its last side effect
        // settled. Only the original bounded native attempt ledger can do so.
        self.artifacts
            .require_terminal_turn(&self.address.thread_id)?;
        verify_scope(service, view, &self.address, fence, true)
    }
    pub(crate) fn artifact_root(&self) -> &Path {
        &self.artifacts.root.path
    }
    pub(crate) fn artifact_identity(&self) -> &str {
        &self.artifacts.root.identity
    }
    pub(crate) fn native_lease(
        &self,
    ) -> Result<kcoder_cli_storage::session_lease::NativeSessionLeaseWitness> {
        self.lease.native_witness()
    }
    pub(crate) fn history_path(&self) -> PathBuf {
        self.bound.history_path()
    }
    pub(crate) fn settings_template(&self) -> Option<&SettingsTemplateBinding> {
        self.settings_template.as_ref()
    }
    pub(crate) fn permission_mode_at_creation(&self) -> Option<kcoder_config::PermissionMode> {
        self.permission_mode_at_creation
    }
    pub(crate) fn client_turn_count(&self) -> usize {
        self.client_turn_count
    }
    pub(crate) fn take_prepared(
        &mut self,
        service: &PeerMessageService,
        view: &DirectorySourceView<'_>,
        fence: &dyn ColdPeerTargetFence,
    ) -> Result<PreparedSessionResume> {
        self.verify(service, view, fence)?;
        self.prepared
            .take()
            .context("peer_cold_target_restore_already_taken")
    }
    pub(crate) fn finish_restore(
        &mut self,
        engine: &QueryEngine,
        service: &PeerMessageService,
        view: &DirectorySourceView<'_>,
        fence: &dyn ColdPeerTargetFence,
    ) -> Result<()> {
        ensure!(
            self.prepared.is_none(),
            "peer_cold_target_restore_not_taken"
        );
        self.verify(service, view, fence)?;
        ensure!(
            engine.session_id() == self.address.thread_id
                && engine.state.history_path().as_deref()
                    == Some(self.bound.history_path().as_path())
                && engine.client_storage_root() == self.artifacts.root.path
                && service.workspace_matches(&engine.state.cwd())
                && engine.is_independent_discovery_session(),
            "peer_cold_target_factory_scope_changed"
        );
        self.lease
            .bind_scheduler_lifecycle(engine.state.inspection_lifecycle_identity());
        self.restored = true;
        Ok(())
    }
    pub(crate) fn into_restored(self) -> Result<(SessionLease, Arc<ColdPeerTargetArtifacts>)> {
        ensure!(self.restored, "peer_cold_target_restore_not_verified");
        Ok((self.lease, Arc::new(self.artifacts)))
    }
}

#[cfg(test)]
#[path = "cold_target/tests.rs"]
mod tests;
