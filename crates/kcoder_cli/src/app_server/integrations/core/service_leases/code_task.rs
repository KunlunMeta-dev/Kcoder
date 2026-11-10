//! The first native service template executes one approved saved pure-code workflow.
use super::*;
use anyhow::{Context, ensure};
use kcoder_types::workflow::WorkflowNodeKind;
use sha2::{Digest, Sha256};

pub(crate) type NativeServiceCodeSelection =
    kcoder_app_protocol::integrations::code_services::NativeCodeWorkflowSelection;

pub(super) fn prepare(
    native: &NativeIntegrationContext,
    selection: &NativeServiceCodeSelection,
    lease_id: &str,
) -> Result<NativeCodeServiceTask> {
    native.verify()?;
    let store =
        kcoder_workflow::store::WorkflowStore::new(native.profile_path()?.join("workflow-library"));
    let definition = store.read_saved(&selection.definition_id, Some(selection.version))?;
    ensure!(
        !definition.nodes.is_empty()
            && definition.nodes.len() <= 64
            && definition
                .nodes
                .iter()
                .all(|node| matches!(node.kind, WorkflowNodeKind::Code | WorkflowNodeKind::Wait)),
        "SERVICE_CODE_ONLY_SAVED_WORKFLOW_REQUIRED"
    );
    let spec = super::super::runtime_driver::RuntimeWorkflowSpec::from_native_source(
        native,
        &selection.definition_id,
        selection.version,
        selection.args.clone(),
    )?;
    let task = NativeCodeServiceTask {
        definition_id: spec.definition_id,
        version: spec.version,
        definition_sha256: spec
            .definition_sha256
            .context("SERVICE_FIXED_CODE_DEFINITION_REQUIRED")?,
        args: spec.args,
        runtime_operation_id: format!("service-task-{:x}", Sha256::digest(lease_id.as_bytes())),
    };
    task.validate()?;
    Ok(task)
}
pub(super) fn verify(
    native: &NativeIntegrationContext,
    task: &NativeCodeServiceTask,
) -> Result<()> {
    task.validate()?;
    let selection = NativeServiceCodeSelection {
        definition_id: task.definition_id.clone(),
        version: task.version,
        args: task.args.clone(),
    };
    let store =
        kcoder_workflow::store::WorkflowStore::new(native.profile_path()?.join("workflow-library"));
    let definition = store.read_saved(&selection.definition_id, Some(selection.version))?;
    ensure!(
        !definition.nodes.is_empty()
            && definition
                .nodes
                .iter()
                .all(|node| matches!(node.kind, WorkflowNodeKind::Code | WorkflowNodeKind::Wait)),
        "SERVICE_CODE_ONLY_SAVED_WORKFLOW_REQUIRED"
    );
    let spec = super::super::runtime_driver::RuntimeWorkflowSpec::from_native_source(
        native,
        &task.definition_id,
        task.version,
        task.args.clone(),
    )?;
    ensure!(
        spec.definition_sha256.as_deref() == Some(task.definition_sha256.as_str())
            && spec.args == task.args,
        "SERVICE_ORIGINAL_CODE_DEFINITION_CHANGED"
    );
    Ok(())
}
pub(super) fn sha256(task: &NativeCodeServiceTask) -> Result<String> {
    task.validate()?;
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(task)?)))
}
