//! Non-executing collaboration authoring over the original workflow library.
use kcoder_types::{
    ModelConfigurationSummary,
    workflow::{WorkflowCodeConfig, WorkflowCollaborationPlan, WorkflowCollaborationRole},
};
use serde::{Deserialize, Serialize};
pub const CAPABILITY_WORKFLOW_COLLABORATION_V1: &str = "workflowCollaborationV1";
pub const WORKFLOW_COLLABORATION_CATALOG: &str = "workflow/collaboration/catalog";
pub const WORKFLOW_COLLABORATION_APPLY: &str = "workflow/collaboration/apply";
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationCatalogParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowCollaborationModelOrigin {
    ExecutionParent,
    ThreadSnapshot,
    ThreadUnobserved,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationRolePreset {
    pub role: WorkflowCollaborationRole,
    pub agent_type: String,
    pub instructions: String,
    pub output_schema: serde_json::Value,
    pub result_check: WorkflowCodeConfig,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationToolFact {
    pub name: String,
    pub registered: bool,
    pub read_only: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationCatalogResult {
    pub schema_version: u32,
    pub roles: Vec<WorkflowCollaborationRolePreset>,
    pub tools: Vec<WorkflowCollaborationToolFact>,
    pub model_origin: WorkflowCollaborationModelOrigin,
    pub thread_id: Option<String>,
    pub model_snapshot: Option<ModelConfigurationSummary>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationApplyParams {
    pub id: String,
    pub expected_revision: u64,
    pub plan: WorkflowCollaborationPlan,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authoring_contract_refuses_execution_flags_and_ambiguous_ids() {
        assert!(
            serde_json::from_value::<WorkflowCollaborationCatalogParams>(
                serde_json::json!({"threadId":"original","execute":true})
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<WorkflowCollaborationApplyParams>(
                serde_json::json!({"id":"original","expectedRevision":1,"plan":{},"run":true})
            )
            .is_err()
        );
        let value = serde_json::to_value(WorkflowCollaborationCatalogParams {
            thread_id: Some("original".into()),
        })
        .unwrap();
        assert_eq!(value, serde_json::json!({"threadId":"original"}));
    }
}
