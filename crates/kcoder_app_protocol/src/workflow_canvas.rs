use kcoder_types::workflow::{WorkflowNode, WorkflowSummary};
use serde::{Deserialize, Serialize};
pub const CAPABILITY_WORKFLOW_CANVAS_V1: &str = "workflowCanvasV1";
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowListParams {
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_list_limit")]
    pub limit: usize,
}
fn default_list_limit() -> usize {
    32
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowReadParams {
    pub id: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkflowCreateParams {
    pub title: String,
    #[serde(default)]
    pub description: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSaveParams {
    pub id: String,
    pub expected_revision: u64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowUpsertNodeParams {
    pub id: String,
    pub expected_revision: u64,
    pub node: WorkflowNode,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowRemoveNodeParams {
    pub id: String,
    pub expected_revision: u64,
    pub node_id: String,
}
#[derive(Debug, Deserialize, Serialize)]
pub struct WorkflowListResult {
    pub items: Vec<WorkflowSummary>,
    pub truncated: bool,
    pub total: usize,
    #[serde(rename = "nextOffset", skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<usize>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn graph_mutations_require_revision_and_reject_paths() {
        assert!(
            serde_json::from_value::<WorkflowSaveParams>(serde_json::json!({"id":"test"})).is_err()
        );
        assert!(serde_json::from_value::<WorkflowReadParams>(
            serde_json::json!({"id":"test","path":"/other"})
        )
        .is_err());
        let params: WorkflowSaveParams =
            serde_json::from_value(serde_json::json!({"id":"test","expectedRevision":3})).unwrap();
        assert_eq!(params.expected_revision, 3);
    }
}
