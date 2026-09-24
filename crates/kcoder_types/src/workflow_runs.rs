use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeRun {
    pub node_id: String,
    pub status: String,
    pub iteration: Option<u32>,
    #[serde(default)]
    pub iteration_status: Option<String>,
    pub attempt: u32,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub agent_id: Option<String>,
    pub reused: bool,
    pub output_preview: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSnapshot {
    #[serde(default)]
    pub revision: u64,
    pub run_id: String,
    pub definition_id: Option<String>,
    pub version: Option<u64>,
    pub thread_id: String,
    pub workspace: String,
    pub status: String,
    #[serde(default)]
    pub error: Option<String>,
    pub started_at_ms: u64,
    pub updated_at_ms: u64,
    pub resume_count: u32,
    pub node_states: Vec<WorkflowNodeRun>,
}
