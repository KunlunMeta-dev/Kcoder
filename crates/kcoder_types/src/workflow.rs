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
    #[serde(default, skip_serializing_if = "WorkflowNodeKind::is_agent")]
    pub kind: WorkflowNodeKind,
    #[serde(default, skip_serializing_if = "WorkflowNodeConfig::is_empty")]
    pub config: WorkflowNodeConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_if: Option<WorkflowBranchGuard>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Value>,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowNodeKind {
    #[default]
    Agent,
    Input,
    Template,
    Condition,
    Merge,
    Loop,
    Output,
}
impl WorkflowNodeKind {
    pub fn is_agent(&self) -> bool {
        *self == Self::Agent
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowMergePolicy {
    #[default]
    All,
    Any,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowLoopMode {
    #[default]
    Repeat,
    ForEach,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkflowPredicate {
    Exists {
        pointer: String,
    },
    Equals {
        pointer: String,
        value: serde_json::Value,
    },
    NotEquals {
        pointer: String,
        value: serde_json::Value,
    },
    GreaterThan {
        pointer: String,
        value: f64,
    },
    LessThan {
        pointer: String,
        value: f64,
    },
    Contains {
        pointer: String,
        value: serde_json::Value,
    },
    All {
        conditions: Vec<WorkflowPredicate>,
    },
    Any {
        conditions: Vec<WorkflowPredicate>,
    },
    Not {
        condition: Box<WorkflowPredicate>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowBranchGuard {
    pub node_id: String,
    pub equals: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowLoopConfig {
    #[serde(default)]
    pub mode: WorkflowLoopMode,
    pub max_iterations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_pointer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub until: Option<WorkflowPredicate>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowNodeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<WorkflowPredicate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge_policy: Option<WorkflowMergePolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<WorkflowLoopConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "is_zero_retry")]
    pub validation_retries: u8,
}
fn is_zero_retry(value: &u8) -> bool {
    *value == 0
}
impl WorkflowNodeConfig {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowVersionSummary {
    pub version: u64,
    pub revision: u64,
    pub title: String,
    pub node_count: usize,
    pub saved_at_ms: u64,
}
