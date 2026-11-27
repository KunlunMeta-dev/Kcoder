//! Task capability scope control and provider-source discovery have separate negotiated capabilities.
use serde::{Deserialize, Serialize};

/// The negotiated value keeps its historical wire spelling for existing clients.
pub const CAPABILITY_TASK_CAPABILITY_SCOPE_DIRECTORY_V1: &str = "taskSourceDirectoryV1";
pub const CAPABILITY_TASK_RESOURCE_BINDINGS_V1: &str = "taskResourceBindingsV1";
/// The negotiated value keeps its historical wire spelling for existing clients.
pub const CAPABILITY_TASK_CAPABILITY_SCOPE_V1: &str = "taskSourcesV1";
/// Provider choices use a separate, stable historical capability value.
pub const CAPABILITY_TASK_CAPABILITY_SOURCE_CHOICES_V1: &str = "taskSourceChoicesV1";
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum TaskCapabilitySourceChoicesMethod {
    #[serde(rename = "integrations/tasks/listTaskSourceChoices")]
    List,
}
impl TaskCapabilitySourceChoicesMethod {
    pub fn parse(method: &str) -> Option<Self> {
        match method {
            "integrations/tasks/listTaskSourceChoices" => Some(Self::List),
            _ => None,
        }
    }
}
/// Existing RPC method retained so saved scope records remain readable by older clients.
pub const TASK_CAPABILITY_SCOPE_BINDINGS_READ: &str =
    "integrations/tasks/readSavedTaskSourceBindings";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum TaskCapabilityScopeDirectoryMethod {
    #[serde(rename = "integrations/tasks/readSavedTaskSourceBindings")]
    Read,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum TaskCapabilityScopeMethod {
    #[serde(rename = "integrations/tasks/readTaskSources")]
    Read,
    #[serde(rename = "integrations/tasks/setTaskSources")]
    Set,
    #[serde(rename = "integrations/tasks/readTaskSourceOperation")]
    ReadOperation,
}
