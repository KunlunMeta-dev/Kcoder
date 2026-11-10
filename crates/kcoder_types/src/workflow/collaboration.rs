//! Declarative collaboration contracts. These values are constraints, never authority.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(
    tag = "mode",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkflowAgentModelSelection {
    InheritCurrent,
    Explicit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        profile: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider: Option<String>,
        model: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[serde(rename = "expectedRevision")]
        expected_revision: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowArtifactRequirement {
    pub path: String,
    pub min_bytes: u64,
    pub required: bool,
    pub unique_content: bool,
    pub require_changed: bool,
    #[serde(default)]
    pub forbidden_literals: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum WorkflowCollaborationRole {
    Researcher,
    Planner,
    Writer,
    Reviewer,
    Verifier,
}
impl WorkflowCollaborationRole {
    pub fn agent_type(self) -> &'static str {
        match self {
            Self::Researcher => "explore",
            Self::Planner => "plan",
            Self::Writer => "implementer",
            Self::Reviewer => "review",
            Self::Verifier => "verifier",
        }
    }
    pub fn is_writer(self) -> bool {
        self == Self::Writer
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationRoleContract {
    pub version: u32,
    pub role: WorkflowCollaborationRole,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationMember {
    pub id: String,
    pub title: String,
    pub role: WorkflowCollaborationRole,
    pub instructions: String,
    pub model_selection: WorkflowAgentModelSelection,
    pub input_bindings: BTreeMap<String, String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub allowed_write_paths: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub artifact_requirements: Vec<WorkflowArtifactRequirement>,
    pub output_schema: serde_json::Value,
    pub result_check: super::WorkflowCodeConfig,
    pub max_turns: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowCollaborationPlan {
    pub version: u32,
    pub input_schema: serde_json::Value,
    pub members: Vec<WorkflowCollaborationMember>,
}
