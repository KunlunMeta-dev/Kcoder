//! The actual owning Engine forwards Core's persisted run to its original meter.
use super::NativeModelRequestError;
use crate::{QueryEngine, integrations::core::NativeToolExecutionWitness};
use anyhow::{Context, Result, ensure};

/// No serde or public constructor. The organization observer independently
/// reads the original private Core Accepted and exact persistent Workflow run.
pub struct NativeWorkflowRootRequest<'a> {
    engine: &'a QueryEngine,
    execution: NativeToolExecutionWitness,
    workflow_run: &'a str,
}

impl NativeWorkflowRootRequest<'_> {
    pub fn engine(&self) -> &QueryEngine {
        self.engine
    }
    pub fn execution(&self) -> &NativeToolExecutionWitness {
        &self.execution
    }
    pub fn workflow_run(&self) -> &str {
        self.workflow_run
    }
}
impl QueryEngine {
    /// Only an actual native launch callback uses this before node dispatch.
    /// A guessed run identifier grants nothing: the mandatory observer must
    /// re-read its original Core acceptance, pinned definition and State owner.
    pub fn observe_native_workflow_acceptance(&self, workflow_run: &str) -> Result<()> {
        let execution = self.native_tool_execution_witness();
        ensure!(
            execution.matches_state(&self.state)
                && execution.session_id() == self.session_id()
                && execution.attempt().is_none()
                && execution.parent().is_none(),
            "NATIVE_WORKFLOW_ROOT_OWNER_CHANGED"
        );
        ensure!(
            !workflow_run.is_empty()
                && workflow_run.len() <= 256
                && !workflow_run.chars().any(char::is_control),
            "NATIVE_WORKFLOW_ROOT_RUN_INVALID"
        );
        let binding = self
            .validated_model_request_binding()?
            .filter(|binding| binding.has_mandatory_guard())
            .context("NATIVE_WORKFLOW_ROOT_OBSERVER_REQUIRED")?;
        binding
            .observer
            .observe_workflow_accepted(&NativeWorkflowRootRequest {
                engine: self,
                execution,
                workflow_run,
            })
            .map_err(|error| {
                anyhow::anyhow!(match error {
                    NativeModelRequestError::Denied => "NATIVE_WORKFLOW_ROOT_BUDGET_DENIED",
                    NativeModelRequestError::Unavailable =>
                        "NATIVE_WORKFLOW_ROOT_BUDGET_UNAVAILABLE",
                    NativeModelRequestError::Deadline => "NATIVE_WORKFLOW_ROOT_BUDGET_DEADLINE",
                })
            })
    }
}

#[cfg(test)]
mod tests {
    use crate::test_support::engine_builder::TestEngineBuilder;
    #[tokio::test]
    async fn root_callback_without_a_mandatory_meter_does_not_admit_work() {
        let directory = tempfile::tempdir().unwrap();
        let engine = TestEngineBuilder::new(directory.path()).build_with_profile_directory();
        assert!(
            engine
                .observe_native_workflow_acceptance("workflow-unaccepted-metadata")
                .is_err()
        );
        assert!(engine.state.current_history_attempt_identity().is_none());
    }
}
