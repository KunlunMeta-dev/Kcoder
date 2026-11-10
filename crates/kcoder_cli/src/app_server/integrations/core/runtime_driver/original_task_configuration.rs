//! Retain the actual task configuration before applying one external input's policy.
use super::*;
use crate::app_server::{SessionLease, thread_runtime::ThreadManager};
use kcoder_engine::QueryEngine;

/// A held Engine configuration over the same State, not another execution owner.
/// It carries no UI/SDK input permit and cannot be supplied through JSON.
pub(crate) struct NativeOriginalTaskConfiguration {
    native: NativeIntegrationContext,
    engine: QueryEngine,
}
impl NativeOriginalTaskConfiguration {
    pub(crate) fn restored(
        native: &NativeIntegrationContext,
        engine: &QueryEngine,
        history: &kcoder_state::PreparedCompletedAttemptHistory,
    ) -> Result<Arc<Self>> {
        history.verify_restored(&engine.state)?;
        Self::capture(native, engine)
    }

    /// Only the real Core manager supplies its resident State and held lease.
    pub(crate) fn resident(
        native: &NativeIntegrationContext,
        manager: &ThreadManager,
        thread: &str,
    ) -> Result<Arc<Self>> {
        ensure!(!manager.is_turn_running(thread), "ORIGINAL_TASK_INPUT_BUSY");
        let engine = manager
            .engine(thread)
            .context("ORIGINAL_TASK_OWNER_REQUIRED")?;
        let lease = manager
            .lease(thread)
            .context("ORIGINAL_TASK_LEASE_REQUIRED")?;
        ensure!(
            lease.matches_target(&engine.session_lease_target()),
            "ORIGINAL_TASK_LEASE_CHANGED"
        );
        ensure!(
            engine.state.try_task_activity_counts() == Some((0, 0)),
            "ORIGINAL_TASK_INPUT_BUSY"
        );
        Self::capture(native, &engine)
    }

    fn capture(native: &NativeIntegrationContext, engine: &QueryEngine) -> Result<Arc<Self>> {
        Self::verify_task_scope(native, engine)?;
        // Preserve every existing task guard, tool registry, pinned expert,
        // model policy and permission configuration by retaining the value.
        Ok(Arc::new(Self {
            native: native.recapture_for_owned_service()?,
            engine: engine.clone(),
        }))
    }

    fn verify_task_scope(native: &NativeIntegrationContext, engine: &QueryEngine) -> Result<()> {
        native.verify()?;
        let settings = engine
            .settings_persistence_path()
            .context("ORIGINAL_TASK_PROFILE_REQUIRED")?;
        let profile = kcoder_config::PrivateDirectory::open_existing(
            settings
                .parent()
                .context("ORIGINAL_TASK_PROFILE_REQUIRED")?,
        )?;
        let workspace = kcoder_config::PrivateDirectory::open_existing(&engine.state.cwd())?;
        ensure!(
            profile.directory_identity()? == native.profile()?.directory_identity()?
                && workspace.directory_identity()? == native.workspace_directory_identity()?,
            "ORIGINAL_TASK_SCOPE_CHANGED"
        );
        ensure!(
            engine.state.session_mode() == kcoder_state::SessionMode::Default
                && engine.state.channel_task_source().is_none()
                && !engine.native_input_requires_source_admission(),
            "ORIGINAL_TASK_CONFIGURATION_UNAVAILABLE"
        );
        Ok(())
    }

    /// Retaining a session's lifetime does not prepare an input or take a new
    /// execution configuration. The original resident may have a turn running.
    pub(crate) fn verify_lifetime_owner(
        native: &NativeIntegrationContext,
        resident: &QueryEngine,
        lease: &SessionLease,
        original: Option<&Self>,
    ) -> Result<()> {
        if let Some(original) = original {
            return original.verify_resident(native, resident, lease);
        }
        ensure!(
            lease.matches_target(&resident.session_lease_target()),
            "ORIGINAL_TASK_LEASE_CHANGED"
        );
        Self::verify_task_scope(native, resident)
    }

    pub(crate) fn for_resident(
        &self,
        native: &NativeIntegrationContext,
        resident: &QueryEngine,
        lease: &SessionLease,
    ) -> Result<QueryEngine> {
        self.verify_resident(native, resident, lease)?;
        Ok(self.engine.clone())
    }

    fn verify_resident(
        &self,
        native: &NativeIntegrationContext,
        resident: &QueryEngine,
        lease: &SessionLease,
    ) -> Result<()> {
        native.verify()?;
        self.native.verify()?;
        ensure!(
            IntegrationOwner::from(native.scope()) == IntegrationOwner::from(self.native.scope())
                && native.scope().identity_generation == self.native.scope().identity_generation,
            "ORIGINAL_TASK_SCOPE_CHANGED"
        );
        ensure!(
            self.engine.state.shares_state_with(&resident.state)
                && self.engine.session_id() == resident.session_id()
                && self.engine.state.cwd() == resident.state.cwd()
                && lease.matches_target(&resident.session_lease_target())
                && lease.matches_target(&self.engine.session_lease_target()),
            "ORIGINAL_TASK_OWNER_CHANGED"
        );
        Ok(())
    }
}
