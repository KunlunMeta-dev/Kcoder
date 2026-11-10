//! Native runtime ownership observes the original lease without extending it.
use super::*;
use crate::app_server::workspace_registry::NativeSessionLeaseWitness;
use kcoder_state::AppStateLifecycleIdentity;

pub(super) struct NativeSessionSourceOwner {
    witness: NativeSessionLeaseWitness,
    persistent_identity: kcoder_config::PortableLeaseIdentity,
    state: AppStateLifecycleIdentity,
}
impl NativeSessionSourceOwner {
    pub(super) fn capture(lease: &SessionLease, engine: &QueryEngine) -> Result<Self> {
        ensure!(
            lease.matches_target(&engine.session_lease_target()),
            "TASK_CAPABILITY_SCOPE_NATIVE_SESSION_OWNER_MISMATCH"
        );
        let witness = lease
            .native_witness()
            .context("TASK_CAPABILITY_SCOPE_OWNER_WITNESS")?;
        let path = lease.target().with_extension("lease");
        let directory = PrivateDirectory::open_existing(
            path.parent()
                .context("TASK_CAPABILITY_SCOPE_NATIVE_LEASE_PARENT_REQUIRED")?,
        )
        .context("TASK_CAPABILITY_SCOPE_OWNER_LEASE_DIRECTORY")?;
        let persistent_identity = lease.file_identity(&directory)?;
        witness.verify_target(&engine.session_lease_target())?;
        Ok(Self {
            witness,
            persistent_identity,
            state: engine.state.inspection_lifecycle_identity(),
        })
    }
    pub(super) fn verify(&self, engine: &QueryEngine) -> Result<()> {
        ensure!(
            self.state.matches(&engine.state),
            "TASK_CAPABILITY_SCOPE_NATIVE_SESSION_OWNER_CHANGED"
        );
        self.witness.verify_target(&engine.session_lease_target())
    }
    pub(super) fn persistent_epoch(
        &self,
        context: &NativeIntegrationContext,
        engine: &QueryEngine,
    ) -> Result<String> {
        context.verify()?;
        self.verify(engine)?;
        digest(&serde_json::json!([
            "native-session-source-owner",
            self.persistent_identity,
            context.scope().identity_generation
        ]))
    }
}
