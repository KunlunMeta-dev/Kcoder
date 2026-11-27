//! Catalog and apply do not create threads, select models or execute workflows.
use anyhow::{Context, Result, ensure};
use kcoder_app_protocol::*;
use kcoder_types::ModelConfigurationSummary;
use kcoder_types::workflow::*;
use serde_json::{Value, json};
use std::path::PathBuf;

fn preset(role: WorkflowCollaborationRole) -> WorkflowCollaborationRolePreset {
    let output_schema = if role == WorkflowCollaborationRole::Verifier {
        json!({"type":"object","properties":{"accepted":{"type":"boolean"},"checks":{"type":"array","minItems":1,"items":{"type":"object","properties":{"criterion":{"type":"string","minLength":1},"passed":{"type":"boolean"},"evidence":{"type":"string","minLength":1}},"required":["criterion","passed","evidence"]}}},"required":["accepted","checks"]})
    } else {
        json!({"type":"object","properties":{"summary":{"type":"string","minLength":1},"evidence":{"type":"array","minItems":1,"items":{"type":"string","minLength":1}}},"required":["summary","evidence"]})
    };
    let source = if role == WorkflowCollaborationRole::Verifier {
        "return result.accepted === true && Array.isArray(result.checks) && result.checks.length > 0 && result.checks.every(item => item.passed === true && typeof item.evidence === 'string' && item.evidence.length > 0);"
    } else {
        "return typeof result.summary === 'string' && result.summary.length > 0 && Array.isArray(result.evidence) && result.evidence.length > 0;"
    };
    WorkflowCollaborationRolePreset {
        role,
        agent_type: role.agent_type().into(),
        instructions: kcoder_workflow::collaboration::presets::default_instructions(role).into(),
        output_schema,
        result_check: WorkflowCodeConfig {
            source: source.into(),
            timeout_ms: 1000,
        },
    }
}
pub fn request(
    method: &str,
    params: Value,
    observed: Option<(String, ModelConfigurationSummary)>,
    settings_path: &dyn Fn() -> Option<PathBuf>,
    tool_fact: &dyn Fn(&str) -> WorkflowCollaborationToolFact,
    validate: &dyn Fn(&WorkflowDefinition) -> Result<()>,
) -> Result<Value> {
    match method {
        WORKFLOW_COLLABORATION_CATALOG => {
            let request: WorkflowCollaborationCatalogParams = serde_json::from_value(params)?;
            if let Some(id) = &request.thread_id {
                ensure!((1..=256).contains(&id.len()) && id.bytes().all(|byte|byte.is_ascii_alphanumeric()||matches!(byte,b'-'|b'_')),"workflow_collaboration: original bounded thread identity required");
            }
            // A matching string is not original-thread provenance. The caller
            // must provide facts captured from the existing resident manager.
            let snapshot = observed
                .filter(|(id, _)| request.thread_id.as_deref() == Some(id.as_str()))
                .map(|(_, model)| model);
            let origin = if request.thread_id.is_none() {
                WorkflowCollaborationModelOrigin::ExecutionParent
            } else if snapshot.is_some() {
                WorkflowCollaborationModelOrigin::ThreadSnapshot
            } else {
                WorkflowCollaborationModelOrigin::ThreadUnobserved
            };
            let roles = [
                WorkflowCollaborationRole::Researcher,
                WorkflowCollaborationRole::Planner,
                WorkflowCollaborationRole::Writer,
                WorkflowCollaborationRole::Reviewer,
                WorkflowCollaborationRole::Verifier,
            ]
            .into_iter()
            .map(preset)
            .collect();
            let tools = ["read", "write"].into_iter().map(tool_fact).collect();
            Ok(serde_json::to_value(WorkflowCollaborationCatalogResult {
                schema_version: 1,
                roles,
                tools,
                model_origin: origin,
                thread_id: request.thread_id,
                model_snapshot: snapshot,
            })?)
        }
        WORKFLOW_COLLABORATION_APPLY => {
            let request: WorkflowCollaborationApplyParams = serde_json::from_value(params)?;
            let path = settings_path()
                .context("workflow_collaboration: actual profile storage unavailable")?;
            let root = path
                .parent()
                .context("workflow_collaboration: profile identity unavailable")?
                .join("workflow-library");
            let store = kcoder_workflow::store::WorkflowStore::new(root);
            let result = store.initialize_collaboration(
                &request.id,
                request.expected_revision,
                &request.plan,
                validate,
            )?;
            Ok(serde_json::to_value(result)?)
        }
        _ => anyhow::bail!("workflow_collaboration: unsupported nonexecuting method"),
    }
}
