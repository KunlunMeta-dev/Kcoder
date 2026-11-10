//! Native data pinning for the existing workflow runtime, not another executor or library.
use super::resolve_business_workflow;
use anyhow::{Result, ensure};
use kcoder_types::workflow::{WorkflowDefinition, WorkflowStatus};
use kcoder_workflow::{
    graph,
    store::{WorkflowStore, definition_fingerprint},
};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Data identity only. Native policy, model budget and execution consent remain host-owned.
#[derive(Clone)]
pub struct FixedBusinessWorkflow {
    definition: WorkflowDefinition,
    definition_sha256: String,
    _schema_sha256: Option<String>,
    args: Value,
    inputs_sha256: String,
}
impl std::fmt::Debug for FixedBusinessWorkflow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FixedBusinessWorkflow")
            .field("id", &self.definition.id)
            .field("version", &self.definition.saved_version)
            .field("definition_sha256", &self.definition_sha256)
            .finish_non_exhaustive()
    }
}
impl FixedBusinessWorkflow {
    pub fn definition(&self) -> &WorkflowDefinition {
        &self.definition
    }
    pub fn definition_sha256(&self) -> &str {
        &self.definition_sha256
    }
    #[cfg(test)]
    pub fn input_schema_sha256(&self) -> Option<&str> {
        self._schema_sha256.as_deref()
    }
    pub fn args(&self) -> &Value {
        &self.args
    }
    pub fn inputs_sha256(&self) -> &str {
        &self.inputs_sha256
    }
    /// Re-resolve the real source at launch; never relabel a new body as the previous version.
    #[cfg(test)]
    pub fn verify_source(&self, store: &WorkflowStore) -> Result<()> {
        let current = resolve_pinned_business_workflow(
            store,
            &self.definition.id,
            self.definition.saved_version.unwrap_or(0),
            &self.args,
            Some(&self.definition_sha256),
        )?;
        ensure!(
            current.inputs_sha256 == self.inputs_sha256
                && current._schema_sha256 == self._schema_sha256,
            "AUTOMATION_WORKFLOW_FIXED_INPUT_CHANGED"
        );
        Ok(())
    }
    /// The existing native launcher/tool must consume this exact graph rather than look it up again by ID.
    #[cfg(test)]
    pub fn verify_definition(&self, candidate: &WorkflowDefinition) -> Result<()> {
        ensure!(
            candidate.id == self.definition.id
                && candidate.saved_version == self.definition.saved_version
                && definition_fingerprint(candidate)? == self.definition_sha256,
            "AUTOMATION_WORKFLOW_DEFINITION_CHANGED"
        );
        Ok(())
    }
}

/// Resolve shipped fixed versions or real saved user versions, applying their actual input schema.
pub fn resolve_pinned_business_workflow(
    store: &WorkflowStore,
    id: &str,
    version: u64,
    args: &Value,
    expected_definition_sha256: Option<&str>,
) -> Result<FixedBusinessWorkflow> {
    resolve(store, id, version, args, expected_definition_sha256).map_err(|error| {
        match error.to_string().as_str() {
            "AUTOMATION_WORKFLOW_DEFINITION_CHANGED" => {
                anyhow::anyhow!("AUTOMATION_WORKFLOW_DEFINITION_CHANGED")
            }
            "AUTOMATION_WORKFLOW_INPUT_INVALID" => {
                anyhow::anyhow!("AUTOMATION_WORKFLOW_INPUT_INVALID")
            }
            _ => anyhow::anyhow!("AUTOMATION_WORKFLOW_PIN_UNAVAILABLE"),
        }
    })
}
fn resolve(
    store: &WorkflowStore,
    id: &str,
    version: u64,
    args: &Value,
    expected: Option<&str>,
) -> Result<FixedBusinessWorkflow> {
    ensure!(version > 0, "AUTOMATION_WORKFLOW_PIN_UNAVAILABLE");
    if let Some(expected) = expected {
        ensure!(
            expected.len() == 64
                && expected
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "AUTOMATION_WORKFLOW_DEFINITION_CHANGED"
        );
    }
    let definition = resolve_business_workflow(store, id, version)?;
    ensure!(
        definition.id == id
            && definition.status == WorkflowStatus::Saved
            && definition.saved_version == Some(version),
        "AUTOMATION_WORKFLOW_DEFINITION_CHANGED"
    );
    graph::validate(&definition, true)?;
    let definition_sha256 = definition_fingerprint(&definition)?;
    ensure!(
        expected.is_none_or(|value| value == definition_sha256),
        "AUTOMATION_WORKFLOW_DEFINITION_CHANGED"
    );
    if id.starts_with("builtin-office-") {
        ensure!(
            definition.input_schema.is_some(),
            "AUTOMATION_WORKFLOW_INPUT_INVALID"
        );
    }
    let prepared = graph::prepare_arguments(&definition, args)
        .map_err(|_| anyhow::anyhow!("AUTOMATION_WORKFLOW_INPUT_INVALID"))?;
    ensure!(
        serde_json::to_vec(&prepared)?.len() <= 128 * 1024,
        "AUTOMATION_WORKFLOW_INPUT_INVALID"
    );
    let _schema_sha256 = definition
        .input_schema
        .as_ref()
        .map(|schema| {
            serde_json::to_vec(schema).map(|bytes| format!("{:x}", Sha256::digest(bytes)))
        })
        .transpose()?;
    let inputs_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&prepared)?));
    Ok(FixedBusinessWorkflow {
        definition,
        definition_sha256,
        _schema_sha256,
        args: prepared,
        inputs_sha256,
    })
}

#[cfg(test)]
#[path = "fixed_workflow/tests.rs"]
mod tests;
