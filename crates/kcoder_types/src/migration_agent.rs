//! Explicit native choices for adapting a reviewed passive Agent definition.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportedAgentModel {
    /// An explicit user decision; source aliases never select a native model.
    Inherit,
    Target {
        provider: String,
        model: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAgentAdaptation {
    pub reviewed_source_sha256: String,
    pub model: ImportedAgentModel,
    /// Exact canonical native names, narrowed by the source restrictions.
    pub tools: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum MigrationAgentProblem {
    Budget,
    UnsupportedSemantics,
    UnsupportedTools,
    InvalidDefinition,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MigrationAgentCompatibility {
    pub source_sha256: String,
    pub can_adapt: bool,
    pub available_tools: Vec<String>,
    pub source_model_reference: bool,
    pub problem: Option<MigrationAgentProblem>,
}

/// Persisted execution metadata carries no approval or user-question authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportedAgentExecution {
    pub adapter_revision: String,
    pub source_sha256: String,
    pub model: ImportedAgentModel,
}

impl ImportedAgentExecution {
    pub fn is_supported(&self) -> bool {
        self.adapter_revision == "static-agent/v1"
            && self.source_sha256.len() == 64
            && self.source_sha256.bytes().all(|c| c.is_ascii_hexdigit())
            && match &self.model {
                ImportedAgentModel::Inherit => true,
                ImportedAgentModel::Target { provider, model } => {
                    !provider.eq_ignore_ascii_case("current")
                        && [provider, model].into_iter().all(|value| {
                            !value.is_empty()
                                && value.len() <= 256
                                && value.trim() == value
                                && !value.chars().any(char::is_control)
                        })
                }
            }
    }
}

/// Reviewed built-ins with explicit source mappings; dynamic/MCP patterns need another adapter.
pub fn is_imported_agent_tool(name: &str) -> bool {
    matches!(
        name,
        "read" | "write" | "edit" | "glob" | "grep" | "WebSearch" | "WebFetch" | "TodoWrite"
    ) || (cfg!(unix) && name == "bash")
        || (cfg!(windows) && name == "PowerShell")
}
