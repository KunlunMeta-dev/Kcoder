//! Immutable host-injected graph data for the existing Workflow tool.
use super::WorkflowInput;
use crate::ToolError;
use kcoder_types::workflow::{WorkflowDefinition, WorkflowStatus};
use kcoder_workflow::{graph, store::definition_fingerprint};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Static data identity, not execution consent or permission. Only the native
/// host can install it in ToolContext after checking its current source/policy.
#[derive(Clone)]
pub struct WorkflowNativeDefinition {
    definition: WorkflowDefinition,
    definition_sha256: String,
    args: Value,
    inputs_sha256: String,
}
impl std::fmt::Debug for WorkflowNativeDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkflowNativeDefinition")
            .field("id", &self.definition.id)
            .field("version", &self.definition.saved_version)
            .field("definition_sha256", &self.definition_sha256)
            .finish_non_exhaustive()
    }
}
impl WorkflowNativeDefinition {
    /// Inputs must already be normalized before the original immutable intent
    /// is committed. This constructor cannot silently change that intent.
    pub fn from_pinned_definition(
        definition: WorkflowDefinition,
        expected_definition_sha256: &str,
        args: Value,
        expected_inputs_sha256: &str,
    ) -> Result<Self, ToolError> {
        if definition.status != WorkflowStatus::Saved
            || definition.saved_version.is_none_or(|version| version == 0)
        {
            return Err(ToolError::InvalidInput(
                "WORKFLOW_NATIVE_DEFINITION_INVALID".into(),
            ));
        }
        graph::validate(&definition, true)
            .map_err(|_| ToolError::InvalidInput("WORKFLOW_NATIVE_DEFINITION_INVALID".into()))?;
        let definition_sha256 = definition_fingerprint(&definition)
            .map_err(|_| ToolError::InvalidInput("WORKFLOW_NATIVE_DEFINITION_INVALID".into()))?;
        if definition_sha256 != expected_definition_sha256 {
            return Err(ToolError::InvalidInput(
                "WORKFLOW_NATIVE_DEFINITION_CHANGED".into(),
            ));
        }
        let normalized = graph::prepare_arguments(&definition, &args)
            .map_err(|_| ToolError::InvalidInput("WORKFLOW_NATIVE_INPUT_INVALID".into()))?;
        let bytes = serde_json::to_vec(&normalized)
            .map_err(|_| ToolError::InvalidInput("WORKFLOW_NATIVE_INPUT_INVALID".into()))?;
        if normalized != args || bytes.len() > 128 * 1024 {
            return Err(ToolError::InvalidInput(
                "WORKFLOW_NATIVE_INPUT_NOT_NORMALIZED".into(),
            ));
        }
        let inputs_sha256 = format!("{:x}", Sha256::digest(bytes));
        if inputs_sha256 != expected_inputs_sha256 {
            return Err(ToolError::InvalidInput(
                "WORKFLOW_NATIVE_FIXED_INPUT_MISMATCH".into(),
            ));
        }
        Ok(Self {
            definition,
            definition_sha256,
            args: normalized,
            inputs_sha256,
        })
    }
    pub fn definition(&self) -> &WorkflowDefinition {
        &self.definition
    }
    pub fn definition_sha256(&self) -> &str {
        &self.definition_sha256
    }
    pub fn inputs_sha256(&self) -> &str {
        &self.inputs_sha256
    }
    pub(super) fn arguments(&self) -> &Value {
        &self.args
    }
    pub(super) fn verify_call(&self, input: &WorkflowInput) -> Result<(), ToolError> {
        if input.definition_id.as_deref() != Some(self.definition.id.as_str())
            || input.version != self.definition.saved_version
            || input.args != self.args
            || input.script.is_some()
            || input.name.is_some()
            || input.script_path.is_some()
            || input.resume.is_some()
            || input.reuse_from_run.is_some()
        {
            return Err(ToolError::InvalidInput(
                "WORKFLOW_NATIVE_FIXED_INPUT_MISMATCH".into(),
            ));
        }
        Ok(())
    }
}
