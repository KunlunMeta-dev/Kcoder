//! Original producer's bounded local-result observation; never a replay checkpoint.
use super::*;
impl NativeRuntimeDriver {
    pub fn begin_output_observation(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<RuntimeOutputObservation> {
        self.check(context)?;
        let mut binding = self
            .storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding.task_state == IntegrationTaskState::Completed
                && binding
                    .acceptance
                    .as_ref()
                    .is_some_and(|a| a.task_id.is_none())
                && binding
                    .original_request
                    .payload
                    .get("source")
                    .and_then(|s| s.get("kind"))
                    .and_then(serde_json::Value::as_str)
                    == Some("channel"),
            "RUNTIME_OUTPUT_ORIGINAL_COMPLETED_REQUIRED"
        );
        if let Some(observation) = &binding.output_observation {
            return Ok(observation.clone());
        }
        let budget_ms = binding.original_request.timeout_ms;
        ensure!(
            (1..=INTEGRATION_MAX_WAIT_MS).contains(&budget_ms),
            "RUNTIME_OUTPUT_OBSERVATION_BUDGET_INVALID"
        );
        let observation = RuntimeOutputObservation {
            state: RuntimeOutputObservationState::Pending,
            started_at_ms: now()?,
            budget_ms,
            reason_code: None,
        };
        binding.output_observation = Some(observation.clone());
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        Ok(observation)
    }
    pub fn mark_output_unconfirmed(
        &mut self,
        context: &NativeIntegrationContext,
        operation: &str,
        reason: &'static str,
    ) -> Result<()> {
        self.check(context)?;
        ensure!(
            matches!(
                reason,
                "RUNTIME_OUTPUT_OBSERVATION_BUDGET_EXHAUSTED"
                    | "RUNTIME_OUTPUT_SOURCE_UNCONFIRMED"
                    | "RUNTIME_OUTPUT_VISIBLE_TEXT_UNAVAILABLE"
            ),
            "RUNTIME_OUTPUT_OBSERVATION_REASON_INVALID"
        );
        let mut binding = self
            .storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        ensure!(
            binding.task_state == IntegrationTaskState::Completed && binding.acceptance.is_some(),
            "RUNTIME_OUTPUT_ORIGINAL_COMPLETED_REQUIRED"
        );
        if binding.output.is_some() {
            return Ok(());
        }
        let observation = binding
            .output_observation
            .as_mut()
            .context("RUNTIME_OUTPUT_OBSERVATION_REQUIRED")?;
        observation.state = RuntimeOutputObservationState::Unconfirmed;
        observation.reason_code = Some(reason.into());
        let revision = binding.revision;
        self.storage.bindings.save(binding, Some(revision))?;
        Ok(())
    }
    /// Pure observation: no queue, store creation, projection write or new budget.
    pub fn output_is_unconfirmed(
        &self,
        context: &NativeIntegrationContext,
        operation: &str,
    ) -> Result<bool> {
        self.check(context)?;
        let binding = self
            .storage
            .bindings
            .get(operation)?
            .context("RUNTIME_BINDING_MISSING")?;
        Ok(binding_output_is_unconfirmed(&binding))
    }
}

pub(super) fn binding_output_is_unconfirmed(binding: &RuntimeBinding) -> bool {
    binding.output.is_none()
        && binding
            .output_observation
            .as_ref()
            .is_some_and(|o| o.unconfirmed_at(now().unwrap_or(u64::MAX)))
}

impl RuntimeOutputObservation {
    /// A read never revives a producer budget after disconnect or clock rollback.
    fn unconfirmed_at(&self, now_ms: u64) -> bool {
        self.state == RuntimeOutputObservationState::Unconfirmed
            || now_ms < self.started_at_ms
            || now_ms >= self.started_at_ms.saturating_add(self.budget_ms)
    }
}
#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn expired_pending_result_is_unconfirmed_without_restarting_or_writing_its_budget() {
        let pending = RuntimeOutputObservation {
            state: RuntimeOutputObservationState::Pending,
            started_at_ms: 100,
            budget_ms: 30,
            reason_code: None,
        };
        let before = serde_json::to_vec(&pending).unwrap();
        assert!(!pending.unconfirmed_at(129));
        assert!(pending.unconfirmed_at(130));
        assert!(pending.unconfirmed_at(999));
        assert_eq!(
            serde_json::to_vec(&pending).unwrap(),
            before,
            "Read must not renew or mutate observation metadata"
        );
    }
    #[test]
    fn wall_clock_rollback_and_explicit_unconfirmed_never_recreate_read_authority() {
        let mut observation = RuntimeOutputObservation {
            state: RuntimeOutputObservationState::Pending,
            started_at_ms: 100,
            budget_ms: 30,
            reason_code: None,
        };
        assert!(observation.unconfirmed_at(99));
        observation.state = RuntimeOutputObservationState::Unconfirmed;
        observation.reason_code = Some("RUNTIME_OUTPUT_SOURCE_UNCONFIRMED".into());
        assert!(observation.unconfirmed_at(101));
        assert!(observation.unconfirmed_at(130));
    }
}
