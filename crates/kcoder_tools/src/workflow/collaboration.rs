//! Narrow adapters to the original workflow store and actual Agent runner.
mod model_observer;
mod native_artifacts;
use super::*;
use kcoder_types::workflow::{WorkflowArtifactRequirement, WorkflowCollaborationPlan};
pub(in crate::workflow) use native_artifacts::NativeArtifacts;

pub(super) use model_observer::{RoleModelObserver, runtime as model_runtime};
pub(super) fn artifact_requirements(
    values: &[WorkflowArtifactRequirement],
) -> Result<Vec<kcoder_state::ArtifactRequirement>, String> {
    let result: Vec<_> = values
        .iter()
        .map(|value| kcoder_state::ArtifactRequirement {
            path: value.path.clone(),
            min_bytes: value.min_bytes,
            required: value.required,
            unique_content: value.unique_content,
            require_changed: value.require_changed,
            forbidden_literals: value.forbidden_literals.clone(),
        })
        .collect();
    kcoder_state::validate_artifact_requirements(&result)?;
    Ok(result)
}
pub(crate) fn apply_draft(
    context: &ToolContext,
    id: &str,
    revision: u64,
    plan: &WorkflowCollaborationPlan,
) -> Result<kcoder_types::workflow::WorkflowDefinition, ToolError> {
    let library =
        kcoder_workflow::store::WorkflowStore::new(crate::workflow_draft::library_root(context)?);
    library
        .initialize_collaboration(id, revision, plan, |definition| {
            crate::workflow_draft::validate_workflow_agent_types(definition)?;
            let _ = crate::workflow_draft::validate_workflow_tool_contracts(definition, |name| {
                context
                    .agent_runner
                    .as_ref()
                    .and_then(|runner| runner.workflow_tool_contract(name))
            })?;
            Ok(())
        })
        .map_err(|error| ToolError::Execution(format!("{error:#}")))
}

pub(super) fn require_artifact_report(
    state: &kcoder_state::AppState,
    agent_id: &str,
    expected: &[kcoder_state::ArtifactRequirement],
) -> Result<(), String> {
    use kcoder_state::ArtifactValidationStatus;
    if expected.is_empty() {
        return Ok(());
    }
    let task = state
        .task(agent_id)
        .ok_or("workflow_artifact: original native artifact task is unavailable")?;
    let run = task
        .artifact_validation_run
        .as_ref()
        .ok_or("workflow_artifact: actual artifact validation did not run")?;
    let report = task
        .artifact_validation_report
        .as_ref()
        .ok_or("workflow_artifact: actual artifact observation is unavailable")?;
    if task.artifact_requirements != expected
        || run.declarations_sha256 != kcoder_state::artifact_declarations_sha256(expected)
        || report.run != *run
        || report.entries.len() != expected.len()
    {
        return Err("workflow_artifact: original declaration/run/report identity mismatch".into());
    }
    for (index, requirement) in expected.iter().enumerate() {
        let entry = report
            .entries
            .iter()
            .find(|entry| entry.index == index)
            .ok_or("workflow_artifact: missing actual file observation")?;
        if entry.path != requirement.path
            || !(entry.status == ArtifactValidationStatus::Passed
                || (!requirement.required
                    && entry.status == ArtifactValidationStatus::SkippedMissing))
        {
            return Err(
                "workflow_artifact: actual artifact checks failed or remain unavailable".into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
