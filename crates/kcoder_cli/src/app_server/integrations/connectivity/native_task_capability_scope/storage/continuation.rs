//! Read-only original source ceiling while the real resident tool boundary is held.
use super::*;
impl NativeTaskCapabilityScopeBinding {
    pub(crate) fn verify_empty_continuation_snapshot(
        &self,
        context: &NativeIntegrationContext,
        accepted: &NativeAcceptedTaskIdentity,
    ) -> Result<()> {
        let directory = self.store.directory(context)?;
        let _lease = binding_lease(
            &directory,
            &self.store.lock_identity,
            PrivateLeaseMode::Shared,
        )?;
        let record = read_record(&directory, &self.task_key()?)?
            .context("TASK_CAPABILITY_SCOPE_BINDING_REQUIRED")?;
        ensure!(
            record.accepted == self.accepted.data && record.accepted == accepted.data,
            "TASK_CAPABILITY_SCOPE_ORIGINAL_ACCEPTED_CHANGED"
        );
        ensure!(
            record.pending.is_none()
                && record.children.is_empty()
                && record.controls.values().all(|receipt| matches!(
                    receipt.phase,
                    NativeTaskCapabilityScopeControlPhase::Applied
                        | NativeTaskCapabilityScopeControlPhase::Rejected
                        | NativeTaskCapabilityScopeControlPhase::Superseded
                )),
            "TASK_CAPABILITY_SCOPE_CONTINUATION_PENDING_CHANGE"
        );
        ensure!(
            record.snapshot.effective_from
                == IntegrationTaskCapabilityScopeBoundary::CurrentSnapshot
                && record.snapshot.thread_id == accepted.thread_id()
                && record.snapshot.effective_sources.is_empty()
                && record
                    .snapshot
                    .effective_resource_bindings
                    .as_ref()
                    .is_none_or(Vec::is_empty),
            "TASK_CAPABILITY_SCOPE_CHANNEL_INHERITANCE_UNSUPPORTED"
        );
        Ok(())
    }
}
