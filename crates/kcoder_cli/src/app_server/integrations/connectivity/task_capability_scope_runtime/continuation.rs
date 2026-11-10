//! Continuation reads the original live per-turn source owner; no JSON reset or grant.
use super::*;
use kcoder_engine::integrations::core::NativeToolBoundaryWitness;
impl NativeTaskCapabilityScopeRuntime {
    pub(crate) fn verify_empty_channel_continuation(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
        completed: &TurnAttemptIdentity,
        resident: &QueryEngine,
        boundary: &NativeToolBoundaryWitness,
    ) -> Result<()> {
        context.verify()?;
        ensure!(
            boundary.matches_state(&resident.state) && completed.thread_id == resident.session_id(),
            "TASK_CAPABILITY_SCOPE_CONTINUATION_OWNER_UNAVAILABLE"
        );
        let reference = IntegrationTaskCapabilityScopeControlTarget {
            initial_attempt: completed.clone(),
            runtime_operation_id: Some(operation.into()),
        };
        reference.validate()?;
        let original = self
            .live
            .lock()
            .map_err(|_| anyhow::anyhow!("TASK_CAPABILITY_SCOPE_RUNTIME_UNAVAILABLE"))?
            .get(&key(&reference)?)
            .cloned()
            .context("TASK_CAPABILITY_SCOPE_CONTINUATION_OWNER_UNAVAILABLE")?;
        context.validate_scope(original.context.scope())?;
        // The held actual SessionLease/State epoch is mandatory even on the same OS account.
        original.facts.verify_resident_owner(context, resident)?;
        let accepted = original
            .facts
            .capture_control_accepted(context, &reference)?;
        original
            .binding
            .accepted()
            .validate_control_target(&reference)?;
        ensure!(
            accepted.task_key()? == original.binding.accepted().task_key()?,
            "TASK_CAPABILITY_SCOPE_ORIGINAL_ACCEPTED_CHANGED"
        );
        original
            .binding
            .verify_empty_continuation_snapshot(context, &accepted)?;
        original.facts.verify_resident_owner(context, resident)?;
        ensure!(
            boundary.matches_state(&resident.state),
            "TASK_CAPABILITY_SCOPE_CONTINUATION_OWNER_UNAVAILABLE"
        );
        context.verify()
    }
}
