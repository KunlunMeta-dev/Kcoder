//! Metadata projections from one original persisted binding, never execution authority.
use super::output_observation::binding_output_is_unconfirmed;
use super::*;

pub struct OriginalRuntimeTaskEvidence {
    pub original: IntegrationRequest,
    pub acceptance: IntegrationRuntimeAcceptance,
    pub task: IntegrationRuntimeTask,
    pub revision: u64,
    pub output_unconfirmed: bool,
}

impl OriginalRuntimeTaskEvidence {
    pub fn has_settled_result(&self) -> bool {
        !self.output_unconfirmed
            && match self.task.state {
                IntegrationTaskState::Completed => {
                    self.task.output.is_some() || !self.task.artifact_refs.is_empty()
                }
                IntegrationTaskState::Failed | IntegrationTaskState::Cancelled => true,
                _ => false,
            }
    }
}

impl NativeRuntimeDriver {
    /// Read the source and task projection from the same original binding
    /// after checking its independently persisted acceptance.
    pub fn read_original_task_evidence(
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<Option<OriginalRuntimeTaskEvidence>> {
        let Some((binding, acceptance)) = Self::read_accepted_operation(context, operation)? else {
            return Ok(None);
        };
        Ok(Some(OriginalRuntimeTaskEvidence {
            original: binding.original_request.clone(),
            acceptance,
            revision: binding.revision,
            output_unconfirmed: binding_output_is_unconfirmed(&binding),
            task: task(binding)?,
        }))
    }

    pub fn read_task_with_revision(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<(IntegrationRuntimeTask, u64)> {
        let binding = self.observed_binding(context, operation)?;
        let revision = binding.revision;
        Ok((task(binding)?, revision))
    }

    /// A result and its confirmation state must refer to the same original revision.
    pub fn read_confirmed_task_reference(
        &self,
        context: &NativeIntegrationContext,
        reference: &IntegrationRuntimeReadTaskParams,
    ) -> Result<Option<(IntegrationRuntimeTask, u64)>> {
        self.project_reference(context, reference, |binding| {
            if binding_output_is_unconfirmed(binding) {
                return Ok(None);
            }
            Ok(Some((task(binding.clone())?, binding.revision)))
        })
    }

    pub fn task_state_observation(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
        snapshot: bool,
    ) -> Result<(IntegrationRuntimeTask, IntegrationTaskStateObservation)> {
        let binding = self.observed_binding(context, operation)?;
        let accepted = binding
            .acceptance
            .as_ref()
            .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
        let observation = IntegrationTaskStateObservation {
            scope: context.scope().clone(),
            operation_id: binding.operation_id.clone(),
            entity_id: binding.operation_id.clone(),
            sequence: binding.revision,
            revision: binding.revision,
            observed_at_ms: now()?,
            snapshot,
            reference: IntegrationRuntimeReadTaskParams {
                thread_id: Some(accepted.thread_id.clone()),
                turn_id: accepted.turn_id.clone(),
                task_id: accepted.task_id.clone(),
            },
            state: binding.task_state,
        };
        observation.validate()?;
        context.verify()?;
        Ok((task(binding)?, observation))
    }

    /// Reads never initialize, recover, queue work, or select a latest task.
    pub fn read_task_state(
        &self,
        context: &NativeIntegrationContext,
        reference: &IntegrationRuntimeReadTaskParams,
    ) -> Result<IntegrationTaskStateObservation> {
        let operation = self.operation_for_reference(context, reference)?;
        self.task_state_observation(context, &operation, true)
            .map(|(_, observation)| observation)
    }

    fn observed_binding(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<RuntimeBinding> {
        let binding = self.checked_binding(context, operation)?;
        ensure!(
            binding.acceptance.is_some(),
            "RUNTIME_ACCEPTANCE_UNCONFIRMED"
        );
        Ok(binding)
    }
}

fn task(binding: RuntimeBinding) -> Result<IntegrationRuntimeTask> {
    let accepted = binding
        .acceptance
        .context("RUNTIME_ACCEPTANCE_UNCONFIRMED")?;
    Ok(IntegrationRuntimeTask {
        thread_id: accepted.thread_id,
        turn_id: accepted.turn_id,
        task_id: accepted.task_id,
        state: binding.task_state,
        output: binding.output,
        artifact_refs: binding.artifact_refs,
        pending_interactions: binding.pending_interactions,
    })
}
