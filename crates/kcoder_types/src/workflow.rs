//! Portable saved-workflow data; execution and persistence belong to kcoder_workflow.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStatus {
    #[default]
    Draft,
    Saved,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct WorkflowPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNode {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default = "default_agent_type")]
    pub agent_type: String,
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub position: WorkflowPosition,
    #[serde(default)]
    pub allowed_write_paths: Vec<String>,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub expected_artifacts: Vec<String>,
}
fn default_agent_type() -> String {
    "general".into()
}
fn default_max_turns() -> u32 {
    60
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowDefinition {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub revision: u64,
    pub status: WorkflowStatus,
    pub nodes: Vec<WorkflowNode>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_version: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSummary {
    pub id: String,
    pub title: String,
    pub description: String,
    pub revision: u64,
    pub status: WorkflowStatus,
    pub node_count: usize,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_version: Option<u64>,
}
impl From<&WorkflowDefinition> for WorkflowSummary {
    fn from(value: &WorkflowDefinition) -> Self {
        Self {
            id: value.id.clone(),
            title: value.title.clone(),
            description: value.description.clone(),
            revision: value.revision,
            status: value.status,
            node_count: value.nodes.len(),
            created_at_ms: value.created_at_ms,
            updated_at_ms: value.updated_at_ms,
            saved_version: value.saved_version,
        }
    }
}
