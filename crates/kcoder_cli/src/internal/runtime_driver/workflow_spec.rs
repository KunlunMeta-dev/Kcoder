use super::*;
use crate::business_templates::{FixedBusinessWorkflow, resolve_pinned_business_workflow};
use kcoder_workflow::store::WorkflowStore;
use serde_json::Value;

impl RuntimeWorkflowSpec {
    /// Normalize against the actual source before the original task intent is frozen.
    /// This data identity is separate from the required native source authority.
    pub fn from_native_source(
        context: &NativeIntegrationContext,
        definition_id: &str,
        version: u64,
        args: Value,
    ) -> Result<Self> {
        let library = WorkflowStore::new(context.profile_path()?.join("workflow-library"));
        let pin = resolve_pinned_business_workflow(&library, definition_id, version, &args, None)?;
        context.verify()?;
        Ok(Self {
            definition_id: definition_id.into(),
            version,
            args: pin.args().clone(),
            definition_sha256: Some(pin.definition_sha256().into()),
        })
    }

    pub fn resolve_pinned(
        &self,
        context: &NativeIntegrationContext,
    ) -> Result<FixedBusinessWorkflow> {
        let expected = self
            .definition_sha256
            .as_deref()
            .context("RUNTIME_WORKFLOW_PIN_REQUIRED")?;
        let library = WorkflowStore::new(context.profile_path()?.join("workflow-library"));
        let pin = resolve_pinned_business_workflow(
            &library,
            &self.definition_id,
            self.version,
            &self.args,
            Some(expected),
        )
        .map_err(|_| anyhow::anyhow!("RUNTIME_WORKFLOW_SOURCE_CHANGED"))?;
        ensure!(pin.args() == &self.args, "RUNTIME_WORKFLOW_INPUT_CHANGED");
        context.verify()?;
        Ok(pin)
    }
}
