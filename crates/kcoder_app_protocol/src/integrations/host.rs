//! Native owner discovery. Scope values returned here remain resource locators.
use serde::{Deserialize, Serialize};

pub const CAPABILITY_INTEGRATION_SCOPE_V1: &str = "integrationScopeV1";
pub const INTEGRATION_SCOPE_READ: &str = "integrations/scope/read";
pub const CAPABILITY_MEMORY_REVIEW_V1: &str = "memoryReviewV1";
pub const CAPABILITY_INTEGRATION_OPERATION_RECEIPTS_V1: &str = "integrationOperationReceiptsV1";
pub const INTEGRATION_OPERATION_READ: &str = "integrations/operation/read";
pub const CAPABILITY_INTEGRATION_TASK_STATE_V1: &str = "integrationTaskStateV1";
pub const INTEGRATION_TASK_STATE_CHANGED: &str = "integrations/runtime/taskStateChanged";
pub const INTEGRATION_TASK_STATE_READ: &str = "integrations/runtime/readTaskState";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(deny_unknown_fields)]
pub struct IntegrationScopeReadParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationOperationReadParams {
    pub operation_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "json-schema", derive(schemars::JsonSchema))]
pub enum IntegrationMemoryMethod {
    #[serde(rename = "integrations/memory/list")]
    List,
    #[serde(rename = "integrations/memory/read")]
    Read,
    #[serde(rename = "integrations/memory/readTaskSnapshot")]
    ReadTaskSnapshot,
    #[serde(rename = "integrations/memory/propose")]
    Propose,
    #[serde(rename = "integrations/memory/review")]
    Review,
    #[serde(rename = "integrations/memory/setEnabled")]
    SetEnabled,
    #[serde(rename = "integrations/memory/edit")]
    Edit,
    #[serde(rename = "integrations/memory/forget")]
    Forget,
}

impl IntegrationMemoryMethod {
    pub fn parse(method: &str) -> Option<Self> {
        Some(match method {
            "integrations/memory/list" => Self::List,
            "integrations/memory/read" => Self::Read,
            "integrations/memory/readTaskSnapshot" => Self::ReadTaskSnapshot,
            "integrations/memory/propose" => Self::Propose,
            "integrations/memory/review" => Self::Review,
            "integrations/memory/setEnabled" => Self::SetEnabled,
            "integrations/memory/edit" => Self::Edit,
            "integrations/memory/forget" => Self::Forget,
            _ => return None,
        })
    }

    pub const fn port_method(self) -> (&'static str, bool) {
        match self {
            Self::List => ("listMemories", false),
            Self::Read => ("readMemory", false),
            Self::ReadTaskSnapshot => ("readMemoryTaskSnapshot", true),
            Self::Propose => ("proposeMemory", false),
            Self::Review => ("reviewMemory", false),
            Self::SetEnabled => ("setMemoryEnabled", false),
            Self::Edit => ("editMemory", true),
            Self::Forget => ("removeMemory", true),
        }
    }
}
