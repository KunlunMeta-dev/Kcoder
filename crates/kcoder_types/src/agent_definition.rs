//! Immutable reusable Agent identity; references never grant execution authority.
use crate::integrations::core::IntegrationOwner;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentDefinitionRef {
    pub id: String,
    pub version: String,
    pub definition_sha256: String,
}

impl AgentDefinitionRef {
    pub fn is_valid(&self) -> bool {
        [&self.id, &self.version].iter().all(|value| {
            !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
        }) && self.definition_sha256.len() == 64
            && self
                .definition_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskSource {
    Expert,
    Channel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTaskBinding {
    pub owner: IntegrationOwner,
    pub definition: AgentDefinitionRef,
    pub title: String,
    pub source: AgentTaskSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
}

/// Original Native channel ownership; independent of optional expert selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelTaskSource {
    pub owner: IntegrationOwner,
    pub channel_id: String,
}

/// Server-captured configuration for one accepted attempt, independent of later selection edits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnConfiguration {
    pub selection_revision: u64,
    pub binding: Option<AgentTaskBinding>,
    pub personalization_revision: Option<u64>,
    pub effective_definition: Option<crate::integrations::office::OfficeAssistantDefinition>,
    /// User tool selection fixed at admission. Missing preserves the older intersecting policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expert_tool_selection: Option<Vec<String>>,
}
